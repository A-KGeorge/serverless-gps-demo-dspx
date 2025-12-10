/**
 * GPS Worker - Serverless GPS trajectory processor
 *
 * Consumes raw GPS points from Redis stream, applies 5-step pipeline:
 * 1. Load state from Redis
 * 2. Kalman filter
 * 3. Differentiate for velocity
 * 4. Moving average on velocity
 * 5. Save state to Redis
 *
 * Publishes processed results for real-time visualization
 */

import Redis from "ioredis";
import { GPSPipeline } from "../shared/gps-pipeline.js";
import { GPSStateManager } from "../shared/state-manager.js";

// Redis configuration
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const INPUT_STREAM = "gps:raw";
const OUTPUT_CHANNEL = "gps:processed";
const CONSUMER_GROUP = "gps-workers";
const CONSUMER_NAME = `worker-${process.pid}`;

// Processing configuration
const BATCH_SIZE = 10; // Process N points per iteration
const BLOCK_MS = 5000; // Block 5 seconds waiting for data

interface RawGPSPoint {
  sensorId: string;
  lat: number;
  lon: number;
  timestamp: number;
}

class GPSWorker {
  private redis: Redis;
  private stateManager: GPSStateManager;
  private pipeline: GPSPipeline;
  private running = false;

  constructor() {
    this.redis = new Redis(REDIS_URL);
    this.stateManager = new GPSStateManager(this.redis);
    this.pipeline = new GPSPipeline();
  }

  /**
   * Initialize consumer group (idempotent)
   */
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

  /**
   * Start processing loop
   */
  async start(): Promise<void> {
    console.log("🚀 GPS Worker starting...");
    console.log(`   Consumer: ${CONSUMER_NAME}`);
    console.log(`   Input stream: ${INPUT_STREAM}`);
    console.log(`   Output channel: ${OUTPUT_CHANNEL}`);

    await this.initializeConsumerGroup();

    this.running = true;

    while (this.running) {
      try {
        // Read batch from stream
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
          continue; // No messages, keep polling
        }

        // Process messages
        const [_streamName, messages] = results[0] as [
          string,
          [string, string[]][]
        ];

        for (const [messageId, fields] of messages) {
          try {
            await this.processMessage(messageId, fields);
          } catch (err) {
            console.error(`❌ Error processing message ${messageId}:`, err);
            // Continue processing other messages
          }
        }
      } catch (err) {
        console.error("❌ Error in processing loop:", err);
        await this.sleep(1000); // Back off on error
      }
    }

    console.log("👋 GPS Worker stopped");
  }

  /**
   * Process single GPS message
   */
  private async processMessage(
    messageId: string,
    fields: string[]
  ): Promise<void> {
    // Parse message fields (Redis returns flat array: [key1, val1, key2, val2, ...])
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

    // Validate input
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

    // Load state
    let state = await this.stateManager.loadState(rawPoint.sensorId);
    if (!state) {
      // Initialize state if not found
      state = this.stateManager.createInitialState(
        rawPoint.lat,
        rawPoint.lon,
        rawPoint.timestamp
      );
    }

    // Process through pipeline (now async with dspx timestamps)
    const { result: processed, newState } = await this.pipeline.process(
      {
        lat: rawPoint.lat,
        lon: rawPoint.lon,
        timestamp: rawPoint.timestamp,
      },
      state,
      rawPoint.sensorId
    );

    // Save updated state
    await this.stateManager.saveState(rawPoint.sensorId, newState);

    // Publish result (use TOON binary format for efficiency)
    const resultBuffer = this.serializeToon({
      ...processed,
      sensorId: rawPoint.sensorId,
      messageId,
    });

    await this.redis.publish(OUTPUT_CHANNEL, resultBuffer);

    // Acknowledge message
    await this.redis.xack(INPUT_STREAM, CONSUMER_GROUP, messageId);

    // Log progress
    const status = processed.isMoving ? "🚗 MOVING" : "🅿️  STOPPED";
    console.log(
      `✅ ${rawPoint.sensorId} | ` +
        `${status} | ` +
        `v=${processed.smoothedVelocity.toFixed(2)} m/s | ` +
        `[${processed.smoothedLat.toFixed(6)}, ${processed.smoothedLon.toFixed(
          6
        )}]`
    );
  }

  /**
   * Stop processing loop
   */
  async stop(): Promise<void> {
    console.log("🛑 Stopping GPS Worker...");
    this.running = false;
    await this.redis.quit();
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Serialize object to TOON binary format
   * TOON (Token Oriented Object Notation): efficient binary serialization
   */
  private serializeToon(obj: any): Buffer {
    // Simple TOON-like binary encoding
    const json = JSON.stringify(obj);
    const buffer = Buffer.from(json, "utf8");
    return buffer;
  }

  /**
   * Deserialize TOON binary format to object
   */
  private deserializeToon(buffer: Buffer): any {
    const json = buffer.toString("utf8");
    return JSON.parse(json);
  }
}

// Main entry point
const worker = new GPSWorker();

// Graceful shutdown
process.on("SIGINT", async () => {
  await worker.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.stop();
  process.exit(0);
});

// Start worker
worker.start().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
