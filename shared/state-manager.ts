/**
 * GPS State Manager
 * Handles serialization/deserialization of Kalman filter state to/from Redis
 */

import type Redis from "ioredis";

export interface KalmanState {
  // State vector: [lat, lon, lat_velocity, lon_velocity]
  // Note: With dspx Kalman, velocities are managed internally
  // We store smoothed position in x[0], x[1]
  x: Float64Array;

  // Error covariance matrix (4x4)
  // Maintained by dspx Kalman filter internally
  P: Float64Array;

  // Velocity buffer for moving average (last N velocities)
  velocityBuffer: Float64Array;
  velocityIndex: number;

  // Timestamp of last update (milliseconds)
  lastTimestamp: number;
}

const VELOCITY_WINDOW_SIZE = 5;
const STATE_TTL = 3600; // 1 hour in seconds

export class GPSStateManager {
  constructor(private redis: Redis) {}

  /**
   * Create initial state for a new sensor
   */
  createInitialState(lat: number, lon: number, timestamp: number): KalmanState {
    return {
      x: new Float64Array([lat, lon, 0, 0]),
      P: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      velocityBuffer: new Float64Array(VELOCITY_WINDOW_SIZE),
      velocityIndex: 0,
      lastTimestamp: timestamp,
    };
  }

  /**
   * Serialize state to binary buffer
   */
  private serializeState(state: KalmanState): Buffer {
    // Calculate buffer size:
    // x: 4 * 8 = 32 bytes
    // P: 16 * 8 = 128 bytes
    // velocityBuffer: 5 * 8 = 40 bytes
    // velocityIndex: 4 bytes (uint32)
    // lastTimestamp: 8 bytes (float64)
    // Total: 212 bytes
    const buffer = Buffer.allocUnsafe(212);
    let offset = 0;

    // Write x (4 doubles)
    for (let i = 0; i < 4; i++) {
      buffer.writeDoubleLE(state.x[i], offset);
      offset += 8;
    }

    // Write P (16 doubles)
    for (let i = 0; i < 16; i++) {
      buffer.writeDoubleLE(state.P[i], offset);
      offset += 8;
    }

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

    return buffer;
  }

  /**
   * Deserialize state from binary buffer
   */
  private deserializeState(buffer: Buffer): KalmanState {
    let offset = 0;

    // Read x (4 doubles)
    const x = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      x[i] = buffer.readDoubleLE(offset);
      offset += 8;
    }

    // Read P (16 doubles)
    const P = new Float64Array(16);
    for (let i = 0; i < 16; i++) {
      P[i] = buffer.readDoubleLE(offset);
      offset += 8;
    }

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

    return {
      x,
      P,
      velocityBuffer,
      velocityIndex,
      lastTimestamp,
    };
  }

  /**
   * Load state from Redis
   */
  async loadState(sensorId: string): Promise<KalmanState | null> {
    const key = `gps:state:${sensorId}`;
    const buffer = await this.redis.getBuffer(key);

    if (!buffer || buffer.length !== 212) {
      return null;
    }

    return this.deserializeState(buffer);
  }

  /**
   * Save state to Redis with TTL
   */
  async saveState(sensorId: string, state: KalmanState): Promise<void> {
    const key = `gps:state:${sensorId}`;
    const buffer = this.serializeState(state);

    await this.redis.setex(key, STATE_TTL, buffer);
  }

  /**
   * Delete state from Redis
   */
  async deleteState(sensorId: string): Promise<void> {
    const key = `gps:state:${sensorId}`;
    await this.redis.del(key);
  }

  /**
   * Check if state exists
   */
  async hasState(sensorId: string): Promise<boolean> {
    const key = `gps:state:${sensorId}`;
    const exists = await this.redis.exists(key);
    return exists === 1;
  }
}
