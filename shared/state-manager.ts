/**
 * GPS State Manager
 * Handles serialization/deserialization of application state to/from Redis
 * Pipeline state (Kalman, MovingAverage, TimeAlignment) is managed by dspx
 */

import type Redis from "ioredis";
import type { createDspPipeline } from "dspx";

export interface AppState {
  // Velocity buffer for moving average (last N velocities)
  velocityBuffer: Float64Array;
  velocityIndex: number;

  // Timestamp of last update (milliseconds)
  lastTimestamp: number;

  // Previous smoothed position (for velocity calculation)
  prevLat: number;
  prevLon: number;
}

const VELOCITY_WINDOW_SIZE = 5;
const STATE_TTL = 3600; // 1 hour in seconds

export class GPSStateManager {
  constructor(private redis: Redis) {}

  /**
   * Create initial state for a new sensor
   */
  createInitialState(lat: number, lon: number, timestamp: number): AppState {
    return {
      velocityBuffer: new Float64Array(VELOCITY_WINDOW_SIZE),
      velocityIndex: 0,
      lastTimestamp: timestamp,
      prevLat: lat,
      prevLon: lon,
    };
  }

  /**
   * Serialize app state to binary buffer (64 bytes)
   */
  private serializeAppState(state: AppState): Buffer {
    // Calculate buffer size:
    // velocityBuffer: 5 * 8 = 40 bytes
    // velocityIndex: 4 bytes (uint32)
    // lastTimestamp: 8 bytes (float64)
    // prevLat: 8 bytes (float64)
    // prevLon: 8 bytes (float64)
    // Total: 68 bytes
    const buffer = Buffer.allocUnsafe(68);
    let offset = 0;

    // Write velocityBuffer (5 doubles)
    for (let i = 0; i < VELOCITY_WINDOW_SIZE; i++) {
      buffer.writeDoubleLE(state.velocityBuffer[i], offset);
      offset += 8;
    }

    // Write velocityIndex (uint32)
    buffer.writeUInt32LE(state.velocityIndex, offset);
    offset += 4;

    // Write lastTimestamp (double)
    buffer.writeDoubleLE(state.lastTimestamp, offset);
    offset += 8;

    // Write prevLat (double)
    buffer.writeDoubleLE(state.prevLat, offset);
    offset += 8;

    // Write prevLon (double)
    buffer.writeDoubleLE(state.prevLon, offset);

    return buffer;
  }

  /**
   * Deserialize app state from binary buffer
   */
  private deserializeAppState(buffer: Buffer): AppState {
    let offset = 0;

    // Read velocityBuffer (5 doubles)
    const velocityBuffer = new Float64Array(VELOCITY_WINDOW_SIZE);
    for (let i = 0; i < VELOCITY_WINDOW_SIZE; i++) {
      velocityBuffer[i] = buffer.readDoubleLE(offset);
      offset += 8;
    }

    // Read velocityIndex (uint32)
    const velocityIndex = buffer.readUInt32LE(offset);
    offset += 4;

    // Read lastTimestamp (double)
    const lastTimestamp = buffer.readDoubleLE(offset);
    offset += 8;

    // Read prevLat (double)
    const prevLat = buffer.readDoubleLE(offset);
    offset += 8;

    // Read prevLon (double)
    const prevLon = buffer.readDoubleLE(offset);

    return {
      velocityBuffer,
      velocityIndex,
      lastTimestamp,
      prevLat,
      prevLon,
    };
  }

  /**
   * Load full state: pipeline state (from dspx) + app state (custom)
   */
  async loadState(
    sensorId: string,
    positionPipeline: ReturnType<typeof createDspPipeline>,
    velocityPipeline: ReturnType<typeof createDspPipeline>,
  ): Promise<AppState> {
    const [pipelineBuffer, appBuffer] = await Promise.all([
      this.redis.getBuffer(`gps:pipeline:${sensorId}`),
      this.redis.getBuffer(`gps:app:${sensorId}`),
    ]);

    // Load dspx pipeline state (Kalman + TimeAlignment)
    if (pipelineBuffer) {
      await positionPipeline.loadState(pipelineBuffer);
    }

    // Load velocity pipeline state (MovingAverage)
    // Note: velocityPipeline state is lightweight, but we restore it for consistency

    // Load app state (68 bytes: velocityBuffer + metadata)
    if (appBuffer && appBuffer.length === 68) {
      return this.deserializeAppState(appBuffer);
    }

    // Return initial state if not found
    return {
      velocityBuffer: new Float64Array(VELOCITY_WINDOW_SIZE),
      velocityIndex: 0,
      lastTimestamp: 0,
      prevLat: 0,
      prevLon: 0,
    };
  }

  /**
   * Save full state: pipeline state (via dspx) + app state (custom)
   */
  async saveState(
    sensorId: string,
    positionPipeline: ReturnType<typeof createDspPipeline>,
    velocityPipeline: ReturnType<typeof createDspPipeline>,
    appState: AppState,
  ): Promise<void> {
    // Save pipeline state using dspx (handles Kalman complexity)
    const pipelineBuffer = await positionPipeline.saveState({ format: "toon" });

    // Save app state (simple custom serialization)
    const appBuffer = this.serializeAppState(appState);

    await Promise.all([
      this.redis.setex(
        `gps:pipeline:${sensorId}`,
        STATE_TTL,
        pipelineBuffer as Buffer,
      ),
      this.redis.setex(`gps:app:${sensorId}`, STATE_TTL, appBuffer),
    ]);
  }

  /**
   * Delete state from Redis
   */
  async deleteState(sensorId: string): Promise<void> {
    await Promise.all([
      this.redis.del(`gps:pipeline:${sensorId}`),
      this.redis.del(`gps:app:${sensorId}`),
    ]);
  }

  /**
   * Check if state exists
   */
  async hasState(sensorId: string): Promise<boolean> {
    const exists = await this.redis.exists(`gps:app:${sensorId}`);
    return exists === 1;
  }
}
