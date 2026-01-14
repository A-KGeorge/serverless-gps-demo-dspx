/**
 * GPS Processing Pipeline
 * Combines Kalman filter, differentiator, and moving average
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createDspPipeline } from "dspx";
import type { KalmanState } from "./state-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_FILE = path.join(__dirname, "../logs/latency.log");

export interface GPSPoint {
  lat: number;
  lon: number;
  timestamp: number;
}

export interface ProcessedGPS extends GPSPoint {
  // Smoothed coordinates
  smoothedLat: number;
  smoothedLon: number;

  // Calculated velocities (m/s)
  velocity: number;
  smoothedVelocity: number;

  // Status
  isMoving: boolean;

  // Performance metrics
  processingLatencyMs: number;
}

interface LatencyStats {
  kalmanMs: number;
  differentiatorMs: number;
  dspPipelineMs: number;
  totalMs: number;
}

const VELOCITY_WINDOW_SIZE = 5; // 5 samples for moving average
const MOVEMENT_THRESHOLD = 0.5; // 0.5 m/s minimum to consider "moving"

// Earth radius in meters (for distance calculations)
const EARTH_RADIUS = 6371000;

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

/**
 * GPS Processing Pipeline
 * Implements the 5-step algorithm
 */
export class GPSPipeline {
  private positionPipeline: ReturnType<typeof createDspPipeline>;
  private velocityPipeline: ReturnType<typeof createDspPipeline>;
  private latencyStats: LatencyStats[] = [];
  private logBatchSize = 100; // Log every 100 samples

  constructor() {
    // Initialize position pipeline with TimeAlignment + Kalman filter (2D: lat, lon)
    this.positionPipeline = createDspPipeline();

    // TimeAlignment normalizes irregular GPS samples (1-5s intervals) to uniform 1 Hz
    this.positionPipeline.TimeAlignment({
      targetSampleRate: 1, // 1 Hz (1 sample/second)
      interpolationMethod: "linear", // Linear interpolation between GPS points
      gapPolicy: "interpolate", // Interpolate across gaps
    });

    this.positionPipeline.KalmanFilter({
      dimensions: 2, // 2D tracking: lat, lon (library creates 4D state with velocity)
      processNoise: 1e-5, // Trust smooth motion model (low process noise)
      measurementNoise: 1e-2, // GPS is noisy - trust individual pings less
      initialError: 1.0, // Higher initial uncertainty
    });

    // Initialize velocity pipeline with moving average (1D)
    this.velocityPipeline = createDspPipeline();
    this.velocityPipeline.MovingAverage({
      mode: "moving",
      windowSize: VELOCITY_WINDOW_SIZE,
    });

    // Ensure log directory exists
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // Write CSV header
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(
        LOG_FILE,
        "timestamp,sensorId,kalmanMs,differentiatorMs,dspPipelineMs,totalMs\n"
      );
    }
  }

  /**
   * Process a single GPS point through the full pipeline
   */
  async process(
    point: GPSPoint,
    state: KalmanState,
    sensorId?: string
  ): Promise<{ result: ProcessedGPS; newState: KalmanState }> {
    const startTime = performance.now();
    const latency: LatencyStats = {
      kalmanMs: 0,
      differentiatorMs: 0,
      dspPipelineMs: 0,
      totalMs: 0,
    };

    // Step 1: State loaded (passed in as parameter)

    // Step 2: Apply TimeAlignment + Kalman filter to position
    const kalmanStart = performance.now();

    // Prepare input: interleaved [lat, lon] with timestamps
    const measurement = new Float32Array([point.lat, point.lon]);

    // Calculate time delta in SECONDS (not milliseconds)
    // Kalman filter expects dt in seconds for velocity units (degrees/second)
    let dtSeconds: number;
    if (state.lastTimestamp > 0) {
      dtSeconds = (point.timestamp - state.lastTimestamp) / 1000; // Convert ms to seconds
    } else {
      dtSeconds = 1.0; // Default 1 second for first sample
    }

    // Pass dt in SECONDS for both channels
    const timestamps = new Float32Array([dtSeconds, dtSeconds]);
    const smoothedPosition = await this.positionPipeline.process(
      measurement,
      timestamps,
      { channels: 2 }
    );

    // Extract smoothed position
    const smoothedLat = smoothedPosition[0];
    const smoothedLon = smoothedPosition[1];

    latency.kalmanMs = performance.now() - kalmanStart;

    // Step 3: Calculate instantaneous velocity (differentiator)
    const diffStart = performance.now();
    const distance = haversineDistance(
      state.x[0],
      state.x[1], // Previous position
      smoothedLat,
      smoothedLon // Current position
    );
    // Use actual dt (already in seconds) for velocity calculation
    const instantVelocity = dtSeconds > 0 ? distance / dtSeconds : 0;
    latency.differentiatorMs = performance.now() - diffStart;

    // Step 4: Smooth velocity through moving average
    const velocityStart = performance.now();

    // Update circular buffer
    state.velocityBuffer[state.velocityIndex] = instantVelocity;
    state.velocityIndex = (state.velocityIndex + 1) % VELOCITY_WINDOW_SIZE;

    // Prepare velocity array with uniform timestamps (1 Hz = 1000ms intervals)
    const velocityArray = new Float32Array(state.velocityBuffer);
    const baseTimestamp = point.timestamp;
    const velocityTimestamps = new Float32Array(VELOCITY_WINDOW_SIZE);
    for (let i = 0; i < VELOCITY_WINDOW_SIZE; i++) {
      velocityTimestamps[i] =
        baseTimestamp - (VELOCITY_WINDOW_SIZE - 1 - i) * 1000;
    }

    // Process velocity through moving average
    const smoothedVelocityArray = await this.velocityPipeline
      .process(velocityArray, velocityTimestamps, { channels: 1 })
      .then((result) => result[result.length - 1] || 0);

    latency.dspPipelineMs = performance.now() - velocityStart;

    // Calculate total latency
    latency.totalMs = performance.now() - startTime;

    // Log latency stats
    this.latencyStats.push(latency);
    if (this.latencyStats.length >= this.logBatchSize) {
      this.flushLatencyLog(sensorId);
    }

    // Determine movement status
    const isMoving = smoothedVelocityArray > MOVEMENT_THRESHOLD;

    // Step 5: Update state for persistence (caller will save)
    const newState: KalmanState = {
      x: new Float64Array([smoothedLat, smoothedLon, 0, 0]), // Store smoothed position
      P: state.P, // Keep covariance (managed internally by dspx)
      velocityBuffer: state.velocityBuffer,
      velocityIndex: state.velocityIndex,
      lastTimestamp: point.timestamp,
    };

    const result: ProcessedGPS = {
      lat: point.lat,
      lon: point.lon,
      timestamp: point.timestamp,
      smoothedLat,
      smoothedLon,
      velocity: instantVelocity,
      smoothedVelocity: smoothedVelocityArray,
      isMoving,
      processingLatencyMs: latency.totalMs,
    };

    return { result, newState };
  }

  /**
   * Flush latency statistics to log file
   */
  private flushLatencyLog(sensorId?: string): void {
    if (this.latencyStats.length === 0) return;

    // Calculate aggregated stats
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const max = (arr: number[]) => Math.max(...arr);
    const min = (arr: number[]) => Math.min(...arr);

    const kalmanTimes = this.latencyStats.map((s) => s.kalmanMs);
    const diffTimes = this.latencyStats.map((s) => s.differentiatorMs);
    const dspTimes = this.latencyStats.map((s) => s.dspPipelineMs);
    const totalTimes = this.latencyStats.map((s) => s.totalMs);

    // Append batch summary to log
    const timestamp = new Date().toISOString();
    const logLine =
      `${timestamp},${sensorId || "batch"},` +
      `${avg(kalmanTimes).toFixed(3)},${avg(diffTimes).toFixed(3)},` +
      `${avg(dspTimes).toFixed(3)},${avg(totalTimes).toFixed(3)}\n`;

    fs.appendFileSync(LOG_FILE, logLine);

    // Console summary
    console.log(
      `📊 Latency (${this.latencyStats.length} samples): ` +
        `Kalman=${avg(kalmanTimes).toFixed(2)}ms, ` +
        `Diff=${avg(diffTimes).toFixed(2)}ms, ` +
        `DSP=${avg(dspTimes).toFixed(2)}ms, ` +
        `Total=${avg(totalTimes).toFixed(2)}ms (max=${max(totalTimes).toFixed(
          2
        )}ms)`
    );

    // Clear stats
    this.latencyStats = [];
  }

  /**
   * Process a batch of points (for testing/replay)
   */
  async processBatch(
    points: GPSPoint[],
    initialState: KalmanState,
    sensorId?: string
  ): Promise<ProcessedGPS[]> {
    const results: ProcessedGPS[] = [];
    let currentState = initialState;

    for (const point of points) {
      const { result, newState } = await this.process(
        point,
        currentState,
        sensorId
      );
      results.push(result);
      currentState = newState;
    }

    // Flush any remaining latency stats
    if (this.latencyStats.length > 0) {
      this.flushLatencyLog(sensorId);
    }

    return results;
  }
}
