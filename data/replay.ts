/**
 * Geolife Dataset Replay System
 * Loads GPS trajectories and streams them to Redis for real-time processing
 */

import fs from "fs";
import path from "path";
import Redis from "ioredis";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const INPUT_STREAM = "gps:raw";
const ARCHIVE_DIR = path.join(__dirname, "../archive");
const REPLAY_SPEED = parseFloat(process.env.REPLAY_SPEED || "10"); // 10x real-time

// Parse command-line arguments
const args = process.argv.slice(2);
const USER_IDS: string[] = [];
const SENSOR_IDS: string[] = [];

// Parse arguments: --users 000,001,002 or --sensors 20081023025304,20081024020959
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--users" || args[i] === "-u") {
    i++;
    while (i < args.length && !args[i].startsWith("-")) {
      // Split comma-separated values
      const ids = args[i].split(",").map((id) => id.trim());
      USER_IDS.push(...ids);
      i++;
    }
    i--; // Back up one since loop will increment
  } else if (args[i] === "--sensors" || args[i] === "-s") {
    i++;
    while (i < args.length && !args[i].startsWith("-")) {
      // Split comma-separated values
      const ids = args[i].split(",").map((id) => id.trim());
      SENSOR_IDS.push(...ids);
      i++;
    }
    i--; // Back up one since loop will increment
  } else if (!args[i].startsWith("-")) {
    // Auto-detect: 3 digits = user ID, 14 digits = sensor ID
    const id = args[i].trim();
    if (/^\d{3}$/.test(id)) {
      USER_IDS.push(id);
    } else if (/^\d{14}$/.test(id)) {
      SENSOR_IDS.push(id);
    } else {
      console.warn(
        `⚠️  Unknown argument format: ${id} (expected 3-digit user ID or 14-digit sensor ID)`
      );
    }
  }
}

interface GPSPoint {
  lat: number;
  lon: number;
  altitude: number;
  timestamp: number;
  dateTime: string;
}

interface Trajectory {
  userId: string;
  trajectoryId: string;
  points: GPSPoint[];
}

/**
 * Parse Geolife PLT file
 * Format: lat,lon,0,altitude,days,date,time
 */
function parsePltFile(filePath: string): GPSPoint[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const points: GPSPoint[] = [];

  // Skip header lines (first 6 lines)
  for (let i = 6; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(",");
    if (parts.length < 7) continue;

    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    const altitude = parseFloat(parts[3]);
    const date = parts[5];
    const time = parts[6];

    // Parse datetime to Unix timestamp
    const dateTime = `${date} ${time}`;
    const timestamp = new Date(dateTime).getTime();

    if (!isNaN(lat) && !isNaN(lon) && !isNaN(timestamp)) {
      points.push({ lat, lon, altitude, timestamp, dateTime });
    }
  }

  return points;
}

/**
 * Load trajectories from archive directory
 */
function loadTrajectories(
  userIds: string[] = [],
  sensorIds: string[] = []
): Trajectory[] {
  const trajectories: Trajectory[] = [];

  try {
    // Check if archive directory exists
    if (!fs.existsSync(ARCHIVE_DIR)) {
      console.error(`❌ Archive directory not found: ${ARCHIVE_DIR}`);
      console.log("📥 Please download Geolife dataset and place in ./archive/");
      return [];
    }

    // Check for "Geolife Trajectories 1.3/Data" structure
    const geolifeDataDir = path.join(
      ARCHIVE_DIR,
      "Geolife Trajectories 1.3",
      "Data"
    );
    const dataDir = fs.existsSync(geolifeDataDir)
      ? geolifeDataDir
      : ARCHIVE_DIR;

    console.log(`📂 Scanning: ${dataDir}`);

    // Find user directories (000, 001, 002, etc.)
    const entries = fs.readdirSync(dataDir);
    let userDirs = entries.filter((entry) => {
      const fullPath = path.join(dataDir, entry);
      return fs.statSync(fullPath).isDirectory() && /^\d{3}$/.test(entry);
    });

    // Filter by specified user IDs if provided
    if (userIds.length > 0) {
      userDirs = userDirs.filter((dir) => userIds.includes(dir));
      console.log(`🎯 Filtering to users: ${userIds.join(", ")}`);

      if (userDirs.length === 0) {
        console.error(
          `❌ No matching user directories found for: ${userIds.join(", ")}`
        );
        return [];
      }
    }

    console.log(`📂 Found ${userDirs.length} user directories`);

    if (sensorIds.length > 0) {
      console.log(`🎯 Filtering to sensors: ${sensorIds.join(", ")}\n`);
    } else {
      console.log(`📊 Loading all available sensors\n`);
    }

    for (const userId of userDirs) {
      const trajectoryDir = path.join(dataDir, userId, "Trajectory");
      if (!fs.existsSync(trajectoryDir)) {
        console.warn(`⚠️  No Trajectory folder found for user ${userId}`);
        continue;
      }

      let pltFiles = fs
        .readdirSync(trajectoryDir)
        .filter((file) => file.endsWith(".plt"));

      // Filter by sensor IDs if specified
      if (sensorIds.length > 0) {
        pltFiles = pltFiles.filter((file) => {
          const sensorId = file.replace(".plt", "");
          return sensorIds.includes(sensorId);
        });
      }

      console.log(`📁 User ${userId}: Found ${pltFiles.length} sensor files`);

      for (const pltFile of pltFiles) {
        const filePath = path.join(trajectoryDir, pltFile);
        const points = parsePltFile(filePath);

        if (points.length > 10) {
          // Only include trajectories with enough points
          trajectories.push({
            userId,
            trajectoryId: pltFile.replace(".plt", ""),
            points,
          });
          console.log(
            `   ✓ Loaded ${pltFile.replace(".plt", "")} (${
              points.length
            } points)`
          );
        } else {
          console.log(
            `   ⚠ Skipped ${pltFile.replace(".plt", "")} (only ${
              points.length
            } points)`
          );
        }
      }
    }

    console.log(`\n✅ Loaded ${trajectories.length} trajectories total`);
  } catch (err) {
    console.error("❌ Error loading trajectories:", err);
  }

  return trajectories;
}

/**
 * Replay trajectory to Redis stream
 */
async function replayTrajectory(
  redis: Redis,
  trajectory: Trajectory,
  speed: number
): Promise<void> {
  const { userId, trajectoryId, points } = trajectory;
  const sensorId = `${userId}-${trajectoryId}`;

  console.log(`🎬 Replaying trajectory: ${sensorId} (${points.length} points)`);

  let lastTimestamp = points[0].timestamp;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];

    // Calculate real-world time delta
    const delta = point.timestamp - lastTimestamp;
    lastTimestamp = point.timestamp;

    // Sleep proportional to time delta (accelerated by speed factor)
    if (i > 0 && delta > 0) {
      const sleepMs = delta / speed;
      await sleep(Math.min(sleepMs, 1000)); // Cap at 1 second
    }

    // Send to Redis stream with Unix epoch timestamp
    const currentTimestamp = Date.now(); // Unix epoch in milliseconds
    await redis.xadd(
      INPUT_STREAM,
      "*", // Auto-generate ID
      "sensorId",
      sensorId,
      "lat",
      point.lat.toString(),
      "lon",
      point.lon.toString(),
      "timestamp",
      currentTimestamp.toString(), // Unix epoch (milliseconds)
      "altitude",
      point.altitude.toString(),
      "originalTimestamp",
      point.timestamp.toString() // Original dataset timestamp for reference
    );

    // Progress indicator
    if ((i + 1) % 50 === 0 || i === points.length - 1) {
      console.log(`  📍 ${sensorId}: ${i + 1}/${points.length} points sent`);
    }
  }

  console.log(`✅ Completed trajectory: ${sensorId}`);
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main replay loop
 */
async function main() {
  console.log("🎬 Geolife Dataset Replay System");
  console.log("================================\n");

  // Show usage if help requested
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run replay -- [options]");
    console.log("\nOptions:");
    console.log(
      "  --users, -u <ids>     Specify user IDs to load (comma or space separated)"
    );
    console.log("                        Example: --users 000,001,002");
    console.log("                        Example: --users 000 001 002");
    console.log(
      "  --sensors, -s <ids>   Specify sensor IDs to load (comma or space separated)"
    );
    console.log("                        Example: --sensors 20081023025304");
    console.log(
      "                        Example: --sensors 20081023025304,20081024020959"
    );
    console.log("\nShorthand (auto-detected by length):");
    console.log("  3-digit arguments = user IDs");
    console.log("  14-digit arguments = sensor IDs");
    console.log("  Example: npm run replay -- 001 20081028102805");
    console.log("\nEnvironment Variables:");
    console.log(
      "  REDIS_URL            Redis connection URL (default: redis://localhost:6379)"
    );
    console.log("  REPLAY_SPEED         Replay speed multiplier (default: 10)");
    console.log("\nExamples:");
    console.log("  npm run replay");
    console.log("  npm run replay -- --users 001,002,003");
    console.log("  npm run replay -- --users 001 --sensors 20081023025304");
    console.log("  npm run replay -- 001 20081028102805");
    console.log("  npm run replay -- 001 002 20081023025304 20081024020959");
    console.log(
      "  REPLAY_SPEED=50 npm run replay -- --users 000 --sensors 20081023025304,20081024020959"
    );
    process.exit(0);
  }

  // Load trajectories
  const trajectories = loadTrajectories(USER_IDS, SENSOR_IDS);

  if (trajectories.length === 0) {
    console.error("❌ No trajectories loaded. Exiting.");
    console.log("\n💡 Tip: Use --help to see usage information");
    process.exit(1);
  }

  // Connect to Redis
  const redis = new Redis(REDIS_URL);
  console.log(`📡 Connected to Redis: ${REDIS_URL}\n`);

  // Replay trajectories in parallel
  console.log(`⚡ Replay speed: ${REPLAY_SPEED}x real-time\n`);

  const replayPromises = trajectories.map((trajectory) =>
    replayTrajectory(redis, trajectory, REPLAY_SPEED)
  );

  await Promise.all(replayPromises);

  console.log("\n✅ All trajectories replayed successfully!");
  await redis.quit();
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n👋 Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n👋 Shutting down...");
  process.exit(0);
});

// Run
main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
