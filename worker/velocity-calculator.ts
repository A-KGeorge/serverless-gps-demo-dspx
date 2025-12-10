/**
 * Velocity Calculator Worker
 * Stage 2: Calculates instantaneous velocity using Haversine distance
 *
 * Input:  gps:position-smoothed (sensorId, smoothedLat, smoothedLon, timestamp)
 * Output: gps:velocity-calculated (sensorId, smoothedLat, smoothedLon, velocity, timestamp)
 */

import Redis from "ioredis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE = path.join(__dirname, "../logs/velocity-calculator.log");

// Redis configuration
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const INPUT_STREAM = "gps:position-smoothed";
const OUTPUT_STREAM = "gps:velocity-calculated";
const CONSUMER_GROUP = "velocity-calculators";
const CONSUMER_NAME = `velocity-calculator-${process.pid}`;

// Processing configuration
const BATCH_SIZE = 10;
const BLOCK_MS = 5000;
const LOG_BATCH_SIZE = 100;

// Earth radius in meters
const EARTH_RADIUS = 6371000;

interface VelocityState {
  lastLat: number;
  lastLon: number;
  lastTimestamp: number;
}

interface SmoothedGPSPoint {
  sensorId: string;
  lat: number;
  lon: number;
  smoothedLat: number;
  smoothedLon: number;
  timestamp: number;
}

/**
 * Calculate distance between two GPS points (Haversine formula)
 */
function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS * c;
}

interface LatencyStats {
  haversineMs: number;
  totalMs: number;
}

class VelocityCalculatorWorker {
  private redis: Redis;
  private states = new Map<string, VelocityState>();
  private running = false;
  private latencyStats: LatencyStats[] = [];

  constructor() {
    this.redis = new Redis(REDIS_URL);

    // Ensure log directory exists
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Write CSV header
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, "timestamp,sensorId,haversineMs,totalMs\n");
    }
  }

  private async initializeConsumerGroup(): Promise<void> {
    try {
      await this.redis.xgroup(
        "CREATE",
        INPUT_STREAM,
        CONSUMER_GROUP,
        "0",
        "MKSTREAM"
      );
      console.log(`✅ Created consumer group: ${CONSUMER_GROUP}`);
    } catch (err: any) {
      if (err.message.includes("BUSYGROUP")) {
        console.log(`✅ Consumer group already exists: ${CONSUMER_GROUP}`);
      } else {
        throw err;
      }
    }
  }

  async start(): Promise<void> {
    console.log("📐 Velocity Calculator Worker starting...");
    console.log(`   Consumer: ${CONSUMER_NAME}`);
    console.log(`   Input: ${INPUT_STREAM} → Output: ${OUTPUT_STREAM}`);

    await this.initializeConsumerGroup();

    this.running = true;

    while (this.running) {
      try {
        const results = await this.redis.xreadgroup(
          "GROUP",
          CONSUMER_GROUP,
          CONSUMER_NAME,
          "COUNT",
          BATCH_SIZE,
          "BLOCK",
          BLOCK_MS,
          "STREAMS",
          INPUT_STREAM,
          ">"
        );

        if (!results || results.length === 0) {
          continue;
        }

        const [_streamName, messages] = results[0] as [
          string,
          [string, string[]][]
        ];

        for (const [messageId, fields] of messages) {
          try {
            await this.processMessage(messageId, fields);
          } catch (err) {
            console.error(`❌ Error processing message ${messageId}:`, err);
          }
        }
      } catch (err) {
        console.error("❌ Error in processing loop:", err);
        await this.sleep(1000);
      }
    }

    console.log("👋 Velocity Calculator Worker stopped");
  }

  private async processMessage(
    messageId: string,
    fields: string[]
  ): Promise<void> {
    const startTime = performance.now();
    const latency: LatencyStats = {
      haversineMs: 0,
      totalMs: 0,
    };

    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      data[fields[i]] = fields[i + 1];
    }

    const point: SmoothedGPSPoint = {
      sensorId: data.sensorId,
      lat: parseFloat(data.lat),
      lon: parseFloat(data.lon),
      smoothedLat: parseFloat(data.smoothedLat),
      smoothedLon: parseFloat(data.smoothedLon),
      timestamp: parseFloat(data.timestamp),
    };

    if (
      !point.sensorId ||
      isNaN(point.smoothedLat) ||
      isNaN(point.smoothedLon) ||
      isNaN(point.timestamp)
    ) {
      console.warn(`⚠️  Invalid smoothed point in message ${messageId}`, data);
      await this.redis.xack(INPUT_STREAM, CONSUMER_GROUP, messageId);
      return;
    }

    // Get or create state for this sensor
    let state = this.states.get(point.sensorId);
    let velocity = 0;

    if (state) {
      // Calculate velocity using Haversine distance
      const haversineStart = performance.now();
      const distance = haversineDistance(
        state.lastLat,
        state.lastLon,
        point.smoothedLat,
        point.smoothedLon
      );
      const dt = (point.timestamp - state.lastTimestamp) / 1000;
      velocity = dt > 0 ? distance / dt : 0;
      latency.haversineMs = performance.now() - haversineStart;
    }

    // Update state
    this.states.set(point.sensorId, {
      lastLat: point.smoothedLat,
      lastLon: point.smoothedLon,
      lastTimestamp: point.timestamp,
    });

    // Publish to next stage
    await this.redis.xadd(
      OUTPUT_STREAM,
      "*",
      "sensorId",
      point.sensorId,
      "lat",
      point.lat.toString(),
      "lon",
      point.lon.toString(),
      "smoothedLat",
      point.smoothedLat.toString(),
      "smoothedLon",
      point.smoothedLon.toString(),
      "velocity",
      velocity.toString(),
      "timestamp",
      point.timestamp.toString()
    );

    // Acknowledge message
    await this.redis.xack(INPUT_STREAM, CONSUMER_GROUP, messageId);

    // Track latency
    latency.totalMs = performance.now() - startTime;
    this.latencyStats.push(latency);
    if (this.latencyStats.length >= LOG_BATCH_SIZE) {
      this.flushLatencyLog(point.sensorId);
    }

    console.log(
      `✅ ${point.sensorId} | Velocity: ${velocity.toFixed(
        2
      )} m/s | ${latency.totalMs.toFixed(2)}ms`
    );
  }

  private flushLatencyLog(sensorId?: string): void {
    if (this.latencyStats.length === 0) return;

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    const haversineTimes = this.latencyStats.map((s) => s.haversineMs);
    const totalTimes = this.latencyStats.map((s) => s.totalMs);

    const timestamp = new Date().toISOString();
    const logLine =
      `${timestamp},${sensorId || "batch"},` +
      `${avg(haversineTimes).toFixed(3)},${avg(totalTimes).toFixed(3)}\n`;

    fs.appendFileSync(LOG_FILE, logLine);

    console.log(
      `📊 [Velocity Calculator] Latency (${this.latencyStats.length} samples): ` +
        `Haversine=${avg(haversineTimes).toFixed(2)}ms, ` +
        `Total=${avg(totalTimes).toFixed(2)}ms`
    );

    this.latencyStats = [];
  }

  async stop(): Promise<void> {
    console.log("🛑 Stopping Velocity Calculator Worker...");
    this.running = false;
    await this.redis.quit();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Main entry point
const worker = new VelocityCalculatorWorker();

process.on("SIGINT", async () => {
  await worker.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.stop();
  process.exit(0);
});

worker.start().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
