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
const BATCH_SIZE = 10; // Process N trajectories at a time to avoid memory overflow

// Parse command-line arguments
const args = process.argv.slice(2);
const USER_IDS: string[] = [];
const SENSOR_IDS: string[] = [];

// Parse arguments: --users 000,001,002 or --sensors 20081023025304,20081024020959
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--users" || args[i] === "-u") {
    i++;
    while (i < args.length && !args[i].startsWith("-")) {
      // Split comma-separated values and spaces
      const ids = args[i]
        .split(/[,\s]+/)
        .map((id) => id.trim())
        .filter((id) => id);
      USER_IDS.push(...ids);
      i++;
    }
    i--; // Back up one since loop will increment
  } else if (args[i] === "--sensors" || args[i] === "-s") {
    i++;
    while (i < args.length && !args[i].startsWith("-")) {
      // Split comma-separated values and spaces
      const ids = args[i]
        .split(/[,\s]+/)
        .map((id) => id.trim())
        .filter((id) => id);
      SENSOR_IDS.push(...ids);
      i++;
    }
    i--; // Back up one since loop will increment
  } else if (!args[i].startsWith("-")) {
    // Auto-detect: 3 digits = user ID, 14 digits = sensor ID
    // Also handle space-separated values within a single argument
    const ids = args[i].split(/[,\s]+/).filter((id) => id.trim());
    for (const id of ids) {
      const trimmedId = id.trim();
      if (/^\d{3}$/.test(trimmedId)) {
        USER_IDS.push(trimmedId);
      } else if (/^\d{14}$/.test(trimmedId)) {
        SENSOR_IDS.push(trimmedId);
      } else {
        console.warn(
          `⚠️  Unknown argument format: ${trimmedId} (expected 3-digit user ID or 14-digit sensor ID)`
        );
      }
    }
  }
}

// Debug output
console.log(`🔍 Parsed USER_IDS: [${USER_IDS.join(", ")}]`);
console.log(`🔍 Parsed SENSOR_IDS: [${SENSOR_IDS.join(", ")}]\n`);

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

interface TrajectoryFile {
  userId: string;
  trajectoryId: string;
  filePath: string;
  pointCount: number;
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
 * Scan trajectories from archive directory (returns file paths, not loaded data)
 */
function scanTrajectories(
  userIds: string[] = [],
  sensorIds: string[] = []
): TrajectoryFile[] {
  const trajectoryFiles: TrajectoryFile[] = [];

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

        // Quick count of points without parsing full data
        const content = fs.readFileSync(filePath, "utf-8");
        const lineCount = content.split("\n").length - 7; // Subtract 6 header lines + 1
        const pointCount = Math.max(0, lineCount);

        if (pointCount > 10) {
          // Only include trajectories with enough points
          trajectoryFiles.push({
            userId,
            trajectoryId: pltFile.replace(".plt", ""),
            filePath,
            pointCount,
          });
          console.log(
            `   ✓ Found ${pltFile.replace(".plt", "")} (${pointCount} points)`
          );
        } else {
          console.log(
            `   ⚠ Skipped ${pltFile.replace(
              ".plt",
              ""
            )} (only ${pointCount} points)`
          );
        }
      }
    }

    console.log(`\n✅ Found ${trajectoryFiles.length} trajectories total`);
  } catch (err) {
    console.error("❌ Error scanning trajectories:", err);
  }

  return trajectoryFiles;
}

/**
 * Load and replay trajectory from file
 */
async function loadAndReplayTrajectory(
  redis: Redis,
  trajectoryFile: TrajectoryFile,
  speed: number
): Promise<void> {
  const { userId, trajectoryId, filePath, pointCount } = trajectoryFile;
  const sensorId = `${userId}-${trajectoryId}`;

  console.log(`🎬 Loading trajectory: ${sensorId} (${pointCount} points)`);

  // Load points from file
  const points = parsePltFile(filePath);

  if (points.length === 0) {
    console.warn(`⚠️  No valid points in ${sensorId}, skipping`);
    return;
  }

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
    console.log(
      "\n⚠️  IMPORTANT: Always use '--' before arguments when using npm run"
    );
    console.log("\nOptions:");
    console.log(
      "  --users, -u <ids>     Specify user IDs to load (comma or space separated)"
    );
    console.log("                        Example: --users 000,001,002");
    console.log('                        Example: --users "000 001 002"');
    console.log(
      "  --sensors, -s <ids>   Specify sensor IDs to load (comma or space separated)"
    );
    console.log("                        Example: --sensors 20081023025304");
    console.log(
      '                        Example: --sensors "20081023025304,20081024020959"'
    );
    console.log("\nShorthand (auto-detected by length, RECOMMENDED):");
    console.log("  3-digit arguments = user IDs");
    console.log("  14-digit arguments = sensor IDs");
    console.log("  Example: npm run replay -- 001 20081028102805");
    console.log("\nEnvironment Variables:");
    console.log(
      "  REDIS_URL            Redis connection URL (default: redis://localhost:6379)"
    );
    console.log("  REPLAY_SPEED         Replay speed multiplier (default: 10)");
    console.log("\n✅ Recommended Examples (shorthand auto-detect):");
    console.log("  npm run replay -- 128 20070414005628 20070414123327");
    console.log("  npm run replay -- 001 002 003");
    console.log("  npm run replay -- 001");
    console.log("\n📝 Alternative Examples (explicit flags):");
    console.log("  npm run replay");
    console.log("  npm run replay -- --users 001,002,003");
    console.log("  npm run replay -- --users 001 --sensors 20081023025304");
    console.log(
      "  REPLAY_SPEED=50 npm run replay -- --users 000 --sensors 20081023025304,20081024020959"
    );
    process.exit(0);
  }

  // Scan trajectory files (lightweight metadata only)
  const trajectoryFiles = scanTrajectories(USER_IDS, SENSOR_IDS);

  if (trajectoryFiles.length === 0) {
    console.error("❌ No trajectories found. Exiting.");
    if (USER_IDS.length > 0 || SENSOR_IDS.length > 0) {
      console.log(
        "\n💡 Tip: Check that the specified user/sensor IDs exist in the archive"
      );
    }
    console.log("💡 Tip: Use --help to see usage information");
    process.exit(1);
  }

  // Connect to Redis
  const redis = new Redis(REDIS_URL);
  console.log(`📡 Connected to Redis: ${REDIS_URL}\n`);

  // Process trajectories in batches to avoid memory overflow
  console.log(`⚡ Replay speed: ${REPLAY_SPEED}x real-time`);
  console.log(
    `📦 Processing ${trajectoryFiles.length} trajectories in batches of ${BATCH_SIZE}\n`
  );

  for (let i = 0; i < trajectoryFiles.length; i += BATCH_SIZE) {
    const batch = trajectoryFiles.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(trajectoryFiles.length / BATCH_SIZE);

    console.log(
      `\n📦 Processing batch ${batchNum}/${totalBatches} (${batch.length} trajectories)`
    );

    // Replay batch in parallel
    const replayPromises = batch.map((trajectoryFile) =>
      loadAndReplayTrajectory(redis, trajectoryFile, REPLAY_SPEED)
    );

    await Promise.all(replayPromises);

    console.log(`✅ Batch ${batchNum}/${totalBatches} complete`);
  }

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
