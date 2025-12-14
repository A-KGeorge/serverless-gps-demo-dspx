/**
 * SSE Server - Provides Server-Sent Events endpoint for GPS data
 * Bridges Redis pub/sub to browser EventSource
 *
 * SCALING STRATEGY:
 * ==================
 * 1. Client Filtering: Clients can request specific sensorId via query params
 *    GET /api/gps-stream?sensorId=128-20070414005628
 *
 * 2. Map-based Storage: Map<sensorId, Set<Response>> allows efficient filtering
 *    - Only sends updates to clients interested in that sensor
 *    - Reduces bandwidth by ~1000x for single-sensor clients
 *
 * 3. Horizontal Scaling: Run N instances behind load balancer
 *    - Each instance maintains its own client map in memory
 *    - Redis Pub/Sub fans out to all instances
 *    - Each instance filters locally (O(1) lookup)
 *    - Response objects cannot be serialized, so must live in-memory
 *
 * 4. Regional Sharding (future): For global scale
 *    - New York -> Redis Cluster A (gps:processed:us-east)
 *    - London -> Redis Cluster B (gps:processed:eu-west)
 *    - Removes single Redis bottleneck
 *
 * CAPACITY: With this architecture:
 * - Single instance: ~10K concurrent SSE connections
 * - 50 instances: ~500K concurrent connections
 * - Add regional sharding: Millions of connections
 */

import express from "express";
import Redis from "ioredis";

const app = express();
const PORT = 3002;

// Redis configuration
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const OUTPUT_CHANNEL = "gps:processed";

// Store active SSE connections mapped by sensorId
// Map<sensorId, Set<Response>> - allows filtering by tracking ID
const clients = new Map<string, Set<express.Response>>();

// Track all clients (for broadcast to "all sensors")
const allClients = new Set<express.Response>();

/**
 * SSE endpoint - streams GPS data to browser
 * Supports filtering: GET /api/gps-stream?sensorId=128-20070414005628
 */
app.get("/api/gps-stream", (req, res) => {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Parse sensorId filter from query params
  const sensorId = req.query.sensorId as string | undefined;

  // Send initial comment to establish connection
  res.write(
    `: connected${
      sensorId ? ` (filtering: ${sensorId})` : " (all sensors)"
    }\n\n`
  );

  // Add client to appropriate tracking set
  if (sensorId) {
    // Client wants specific sensor
    if (!clients.has(sensorId)) {
      clients.set(sensorId, new Set());
    }
    clients.get(sensorId)!.add(res);
    console.log(
      `📱 Client connected for sensor: ${sensorId} (${
        clients.get(sensorId)!.size
      } clients)`
    );
  } else {
    // Client wants all sensors
    allClients.add(res);
    console.log(
      `📱 Client connected (all sensors) (${allClients.size} clients)`
    );
  }

  // Remove client on disconnect
  req.on("close", () => {
    if (sensorId) {
      const sensorClients = clients.get(sensorId);
      if (sensorClients) {
        sensorClients.delete(res);
        // Cleanup empty sets
        if (sensorClients.size === 0) {
          clients.delete(sensorId);
          console.log(`🗑️  Removed tracking for sensor: ${sensorId}`);
        } else {
          console.log(
            `👋 Client disconnected from ${sensorId} (${sensorClients.size} remaining)`
          );
        }
      }
    } else {
      allClients.delete(res);
      console.log(`👋 Client disconnected (${allClients.size} remaining)`);
    }
  });
});

/**
 * Stats endpoint - shows current SSE connections
 */
app.get("/api/stats", (req, res) => {
  const stats = {
    totalTrackedSensors: clients.size,
    totalUnfilteredClients: allClients.size,
    totalFilteredClients: Array.from(clients.values()).reduce(
      (sum, set) => sum + set.size,
      0
    ),
    sensorDetails: Array.from(clients.entries()).map(
      ([sensorId, clientSet]) => ({
        sensorId,
        clientCount: clientSet.size,
      })
    ),
  };

  res.json(stats);
});

/**
 * Subscribe to Redis and broadcast to all SSE clients
 * Filters messages by sensorId to only send to interested clients
 */
async function startRedisSubscription() {
  const subscriber = new Redis(REDIS_URL);

  await subscriber.subscribe(OUTPUT_CHANNEL);
  console.log(`📡 Subscribed to Redis channel: ${OUTPUT_CHANNEL}`);
  console.log(`🎯 Broadcasting with client-side filtering enabled\n`);

  subscriber.on("message", (channel, messageBuffer) => {
    if (channel === OUTPUT_CHANNEL) {
      try {
        // Parse message to get sensorId
        const messageStr = messageBuffer.toString();
        const data = JSON.parse(messageStr);
        const sensorId = data.sensorId;

        if (!sensorId) {
          console.warn("⚠️  Message missing sensorId, skipping");
          return;
        }

        const sseMessage = `data: ${messageStr}\n\n`;

        // Send to clients filtering for this specific sensor
        const sensorClients = clients.get(sensorId);
        let sentCount = 0;

        if (sensorClients && sensorClients.size > 0) {
          sensorClients.forEach((client) => {
            try {
              client.write(sseMessage);
              sentCount++;
            } catch (err) {
              // Remove dead connection
              sensorClients.delete(client);
              if (sensorClients.size === 0) {
                clients.delete(sensorId);
              }
            }
          });
        }

        // Send to clients listening to all sensors
        if (allClients.size > 0) {
          allClients.forEach((client) => {
            try {
              client.write(sseMessage);
              sentCount++;
            } catch (err) {
              // Remove dead connection
              allClients.delete(client);
            }
          });
        }

        // Log every 100 messages to avoid spam
        if (Math.random() < 0.01) {
          console.log(
            `📤 Sent ${sensorId} update to ${sentCount} client(s) ` +
              `(${clients.size} tracked sensors, ${allClients.size} unfiltered)`
          );
        }
      } catch (err) {
        console.error("❌ Error processing message:", err);
      }
    }
  });

  subscriber.on("error", (err) => {
    console.error("❌ Redis subscriber error:", err);
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`🌐 SSE Server running on http://localhost:${PORT}`);
  startRedisSubscription();
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n👋 Shutting down SSE server...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n👋 Shutting down SSE server...");
  process.exit(0);
});
