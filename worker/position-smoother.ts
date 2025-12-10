/**
 * Position Smoother Worker
 * Stage 1: Applies Kalman filter to raw GPS coordinates
 *
 * Input:  gps:raw (sensorId, lat, lon, timestamp)
 * Output: gps:position-smoothed (sensorId, lat, lon, smoothedLat, smoothedLon, timestamp)
 */

import Redis from "ioredis";
import { createDspPipeline } from "dspx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE = path.join(__dirname, "../logs/position-smoother.log");

// Redis configuration
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const INPUT_STREAM = "gps:raw";
const OUTPUT_STREAM = "gps:position-smoothed";
const CONSUMER_GROUP = "position-smoothers";
const CONSUMER_NAME = `position-smoother-${process.pid}`;

// Processing configuration
const BATCH_SIZE = 10;
const BLOCK_MS = 5000;
const LOG_BATCH_SIZE = 100; // Log every 100 samples

interface KalmanState {
  lastTimestamp: number;
}

interface RawGPSPoint {
  sensorId: string;
  lat: number;
  lon: number;
  timestamp: number;
}

interface LatencyStats {
  kalmanMs: number;
  totalMs: number;
}

class PositionSmootherWorker {
  private redis: Redis;
  private pipeline: ReturnType<typeof createDspPipeline>;
  private states = new Map<string, KalmanState>();
  private running = false;
  private latencyStats: LatencyStats[] = [];

  constructor() {
    this.redis = new Redis(REDIS_URL);

    // Initialize Kalman filter pipeline (2D: lat, lon)
    this.pipeline = createDspPipeline();
    this.pipeline.KalmanFilter({
      dimensions: 2,
      processNoise: 0.0001,
      measurementNoise: 0.0001,
      initialError: 0.0001,
    });

    // Ensure log directory exists
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Write CSV header
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, "timestamp,sensorId,kalmanMs,totalMs\n");
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
    console.log("🎯 Position Smoother Worker starting...");
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

    console.log("👋 Position Smoother Worker stopped");
  }

  private async processMessage(
    messageId: string,
    fields: string[]
  ): Promise<void> {
    const startTime = performance.now();
    const latency: LatencyStats = {
      kalmanMs: 0,
      totalMs: 0,
    };

    const data: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      data[fields[i]] = fields[i + 1];
    }

    const rawPoint: RawGPSPoint = {
      sensorId: data.sensorId,
      lat: parseFloat(data.lat),
      lon: parseFloat(data.lon),
      timestamp: parseFloat(data.timestamp),
    };

    if (
      !rawPoint.sensorId ||
      isNaN(rawPoint.lat) ||
      isNaN(rawPoint.lon) ||
      isNaN(rawPoint.timestamp)
    ) {
      console.warn(`⚠️  Invalid GPS point in message ${messageId}`, data);
      await this.redis.xack(INPUT_STREAM, CONSUMER_GROUP, messageId);
      return;
    }

    // Get or create state for this sensor
    let state = this.states.get(rawPoint.sensorId);
    if (!state) {
      state = { lastTimestamp: 0 };
      this.states.set(rawPoint.sensorId, state);
    }

    // Calculate time delta
    const dt =
      state.lastTimestamp > 0
        ? (rawPoint.timestamp - state.lastTimestamp) / 1000
        : 0.1;

    // Apply Kalman filter
    const kalmanStart = performance.now();
    const measurement = new Float32Array([rawPoint.lat, rawPoint.lon]);
    const deltas = new Float32Array([dt, dt]);

    const smoothedPosition = await this.pipeline.process(measurement, deltas, {
      channels: 2,
    });

    const smoothedLat = smoothedPosition[0];
    const smoothedLon = smoothedPosition[1];
    latency.kalmanMs = performance.now() - kalmanStart;

    // Update state
    state.lastTimestamp = rawPoint.timestamp;

    // Publish to next stage
    await this.redis.xadd(
      OUTPUT_STREAM,
      "*",
      "sensorId",
      rawPoint.sensorId,
      "lat",
      rawPoint.lat.toString(),
      "lon",
      rawPoint.lon.toString(),
      "smoothedLat",
      smoothedLat.toString(),
      "smoothedLon",
      smoothedLon.toString(),
      "timestamp",
      rawPoint.timestamp.toString()
    );

    // Acknowledge message
    await this.redis.xack(INPUT_STREAM, CONSUMER_GROUP, messageId);

    // Track latency
    latency.totalMs = performance.now() - startTime;
    this.latencyStats.push(latency);
    if (this.latencyStats.length >= LOG_BATCH_SIZE) {
      this.flushLatencyLog(rawPoint.sensorId);
    }

    console.log(
      `✅ ${rawPoint.sensorId} | Smoothed: [${smoothedLat.toFixed(
        6
      )}, ${smoothedLon.toFixed(6)}] | ${latency.totalMs.toFixed(2)}ms`
    );
  }

  private flushLatencyLog(sensorId?: string): void {
    if (this.latencyStats.length === 0) return;

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    const kalmanTimes = this.latencyStats.map((s) => s.kalmanMs);
    const totalTimes = this.latencyStats.map((s) => s.totalMs);

    const timestamp = new Date().toISOString();
    const logLine =
      `${timestamp},${sensorId || "batch"},` +
      `${avg(kalmanTimes).toFixed(3)},${avg(totalTimes).toFixed(3)}\n`;

    fs.appendFileSync(LOG_FILE, logLine);

    console.log(
      `📊 [Position Smoother] Latency (${this.latencyStats.length} samples): ` +
        `Kalman=${avg(kalmanTimes).toFixed(2)}ms, ` +
        `Total=${avg(totalTimes).toFixed(2)}ms`
    );

    this.latencyStats = [];
  }

  async stop(): Promise<void> {
    console.log("🛑 Stopping Position Smoother Worker...");
    this.running = false;
    await this.redis.quit();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Main entry point
const worker = new PositionSmootherWorker();

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
