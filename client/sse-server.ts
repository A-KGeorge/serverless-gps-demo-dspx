/**
 * SSE Server - Provides Server-Sent Events endpoint for GPS data
 * Bridges Redis pub/sub to browser EventSource
 */

import express from "express";
import Redis from "ioredis";

const app = express();
const PORT = 3002;

// Redis configuration
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const OUTPUT_CHANNEL = "gps:processed";

// Store active SSE connections
const clients = new Set<express.Response>();

/**
 * SSE endpoint - streams GPS data to browser
 */
app.get("/api/gps-stream", (req, res) => {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Send initial comment to establish connection
  res.write(": connected\n\n");

  // Add client to active connections
  clients.add(res);

  // Remove client on disconnect
  req.on("close", () => {
    clients.delete(res);
  });
});

/**
 * Subscribe to Redis and broadcast to all SSE clients
 */
async function startRedisSubscription() {
  const subscriber = new Redis(REDIS_URL);

  await subscriber.subscribe(OUTPUT_CHANNEL);
  console.log(`📡 Subscribed to Redis channel: ${OUTPUT_CHANNEL}`);

  subscriber.on("message", (channel, messageBuffer) => {
    if (channel === OUTPUT_CHANNEL) {
      // Message is in TOON binary format, convert to JSON for SSE
      const message = messageBuffer;

      // Broadcast to all connected SSE clients
      const sseMessage = `data: ${message}\n\n`;
      clients.forEach((client) => {
        try {
          client.write(sseMessage);
        } catch (err) {
          clients.delete(client);
        }
      });
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
