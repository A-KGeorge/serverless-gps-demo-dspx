# GPS Trajectory Demo - Architecture

## System Overview

This demo implements a **serverless, event-driven architecture** for real-time GPS trajectory smoothing using Redis Streams, Kalman filtering, and WebSocket-like communication via Server-Sent Events (SSE).

```mermaid
flowchart TD
    Dataset[📦 Geolife Dataset<br/>./archive/<br/>182 users, ~18k trajectories]

    Replay[🎬 Data Replay<br/>data/replay.ts<br/>• Parses PLT files<br/>• Time-scaled replay 10x<br/>• Parallel streaming]

    RedisStream[(💾 Redis Stream<br/>gps:raw<br/>Raw GPS points)]

    Worker[⚙️ GPS Worker<br/>worker/gps-worker.ts<br/>Consumer Group: gps-workers]

    Pipeline[5-Step Pipeline:<br/>1. Load State Redis<br/>2. Position Pipeline dspx<br/>3. Haversine Distance<br/>4. Velocity Pipeline dspx<br/>5. Save State Redis]

    RedisPubSub[(💾 Redis Pub/Sub<br/>gps:processed<br/>Smoothed + velocity)]

    SSE[📡 SSE Server<br/>client/sse-server.ts<br/>Port: 3002<br/>• Redis subscriber<br/>• EventSource bridge<br/>• CORS enabled]

    Client[🗺️ Web Client<br/>index.html + app.ts<br/>Port: 5173<br/>• Leaflet map<br/>• Dark/Light theme<br/>• Raw vs filtered traces<br/>• Live statistics]

    Dataset -->|Read PLT files| Replay
    Replay -->|XADD| RedisStream
    RedisStream -->|XREADGROUP<br/>Batch: 10 msgs| Worker
    Worker -->|Process| Pipeline
    Pipeline -.->|State I/O| Worker
    Worker -->|PUBLISH| RedisPubSub
    RedisPubSub -->|SUBSCRIBE| SSE
    SSE -->|Server-Sent Events<br/>text/event-stream| Client

    style Dataset fill:#2d3748,stroke:#4a5568,color:#fff
    style Replay fill:#2b6cb0,stroke:#3182ce,color:#fff
    style RedisStream fill:#c53030,stroke:#e53e3e,color:#fff
    style Worker fill:#2f855a,stroke:#38a169,color:#fff
    style Pipeline fill:#805ad5,stroke:#9f7aea,color:#fff
    style RedisPubSub fill:#c53030,stroke:#e53e3e,color:#fff
    style SSE fill:#d69e2e,stroke:#ecc94b,color:#fff
    style Client fill:#0066cc,stroke:#3182ce,color:#fff
```

---

## Components

### 1. Data Replay (`data/replay.ts`)

**Purpose**: Simulate real-time GPS data stream from historical Geolife dataset

**Key Features**:

- Parses PLT files (lat, lon, altitude, timestamp)
- Time-scaled replay (configurable speed multiplier)
- Parallel trajectory streaming
- Automatic Redis stream creation

**Input**: PLT files from `archive/Geolife Trajectories 1.3/Data/`
**Output**: Redis Stream `gps:raw`

**Message Format**:

```typescript
{
  sensorId: "000-20081023025304",  // userId-trajectoryId
  lat: "39.984702",
  lon: "116.318417",
  timestamp: "1734567890000"       // Current time (not original)
}
```

---

### 2. GPS Worker (`worker/gps-worker.ts`)

**Purpose**: Stateful GPS processing with Kalman filtering

**Architecture**:

- **Consumer Group**: `gps-workers` (enables horizontal scaling)
- **Batch Processing**: Reads 10 messages per iteration
- **Blocking Read**: 5-second timeout on empty stream

**Pipeline Architecture**:

The GPS processing system uses **two separate dspx pipelines** for optimal performance:

1. **Position Pipeline** (`positionPipeline`)

   - Stage: `KalmanFilter` (2D: lat, lon)
   - Input: Raw GPS coordinates
   - Output: Smoothed position
   - Channel count: 2 (interleaved lat, lon)

2. **Velocity Pipeline** (`velocityPipeline`)
   - Stage: `MovingAverage` (1D)
   - Input: Instantaneous velocity values
   - Output: Smoothed velocity
   - Channel count: 1

**Why Two Pipelines?**

Separate pipelines are necessary because:

- The Kalman filter requires 2 dimensions (lat, lon) matching its configuration
- The moving average operates on 1-dimensional velocity data
- dspx validates that channel count matches stage requirements
- Each pipeline maintains its own internal state optimized for its data type

This architecture provides better performance than a unified pipeline while maintaining clean separation of concerns.

**Pipeline Steps**:

#### Step 1: Load State

```typescript
// Redis key: gps:state:{sensorId}
// Binary format: 212 bytes
{
  x: Float64Array(4),      // [lat, lon, 0, 0] - smoothed position only
  P: Float64Array(16),     // 4×4 covariance (maintained by dspx internally)
  velocityBuffer: Float64Array(5),
  velocityIndex: number,
  lastTimestamp: number
}
```

#### Step 2: Position Pipeline (dspx Kalman Filter)

- **Pipeline**: `positionPipeline` (dedicated for 2D position)
- **Implementation**: Built-in dspx KalmanFilter stage
- **Dimensions**: 2 (lat, lon tracking - library auto-creates 4D state with velocity)
- **Process noise**: 0.0001 (degrees² - process variance for position changes)
- **Measurement noise**: 0.0001 (degrees² - GPS uncertainty in degree units)
- **Initial error**: 0.0001 (degrees² - initial position uncertainty)
- **Input format**: Interleaved Float32Array `[lat, lon]` with **time deltas** `[dt, dt]`
- **CRITICAL**: Must pass time **delta** (seconds elapsed since last point), NOT absolute timestamps
  - ✅ Correct: `dt = (currentTime - lastTime) / 1000` (e.g., 0.5 seconds)
  - ❌ Wrong: `timestamp = currentTime / 1000` (e.g., 1739824567 seconds)
  - Why: C++ implementation uses input directly in state transition matrix F
- **Operations**: Processes 2-channel position data through Kalman filter
- **Output**: Smoothed `[lat, lon]` coordinates

#### Step 3: Velocity Calculation

- **Method**: Haversine distance calculation (geospatial)
- **Formula**: Great-circle distance on sphere
- **Time delta**: Divides distance by elapsed time
- **Output**: Instantaneous velocity (m/s)
- **Note**: Uses native JS (not dspx) since it's geospatial math, not signal processing

#### Step 4: Velocity Pipeline (dspx Moving Average)

- **Pipeline**: `velocityPipeline` (dedicated for 1D velocity)
- **Implementation**: Built-in dspx MovingAverage stage
- **Mode**: moving (stateful across calls)
- **Window**: 5 samples (circular buffer)
- **Input format**: Float32Array of velocity buffer with time deltas
- **Time deltas**: Same dt value used for each velocity sample (uniform sampling)
- **Operations**: Processes 1-channel velocity data through moving average
- **Purpose**: Smooth velocity to reduce jitter
- **Output**: Smoothed velocity scalar for movement detection

#### Step 5: Save State

- **TTL**: 1 hour (auto-expire inactive sensors)
- **Persistence**: Binary serialization to Redis

**Output**: Redis Pub/Sub `gps:processed`

---

### 3. SSE Server (`client/sse-server.ts`)

**Purpose**: Bridge Redis pub/sub to browser EventSource API

**Why SSE?**:

- ✅ Simpler than WebSockets (unidirectional server→client)
- ✅ Auto-reconnection built-in
- ✅ HTTP/2 multiplexing friendly
- ✅ No socket.io dependency

**Implementation**:

```typescript
// Express endpoint
app.get("/api/gps-stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Broadcast Redis messages to all connected clients
  redis.on("message", (channel, data) => {
    res.write(`data: ${data}\n\n`);
  });
});
```

**Port**: 3002
**Protocol**: HTTP/1.1 with chunked transfer encoding

---

### 4. Web Client (`client/app.ts`)

**Purpose**: Interactive map visualization with raw/filtered comparison

**Tech Stack**:

- **Map**: Leaflet.js with dark CARTO basemap
- **Rendering**: Canvas-based polylines (60 FPS)
- **State**: In-memory trace storage per sensor

**Features**:

#### Trace Rendering

```typescript
// Raw GPS: Red (#cc3333)
// Filtered: Green (#33cc33)
L.polyline(points, {
  color: type === "raw" ? "#cc3333" : "#33cc33",
  weight: 3,
  opacity: 0.8,
});
```

#### Movement Detection

```typescript
// Marker colors:
// Green: Moving (velocity > 0.5 m/s)
// Yellow: Stopped (velocity ≤ 0.5 m/s)
marker.setStyle({
  fillColor: isMoving ? "#33cc33" : "#cc9933",
});
```

#### Live Statistics

- **Points Processed**: Cumulative counter
- **Average Velocity**: Running mean
- **Movement Status**: Current state (🚗 Moving / 🅿️ Stopped)

---

## Data Flow

### Typical Request Path

```mermaid
sequenceDiagram
    participant Replay as 🎬 Replay
    participant Stream as Redis Stream<br/>(gps:raw)
    participant Worker as ⚙️ Worker
    participant State as Redis State<br/>(gps:state:*)
    participant PubSub as Redis Pub/Sub<br/>(gps:processed)
    participant SSE as 📡 SSE Server
    participant Browser as 🗺️ Browser

    Replay->>Stream: XADD gps:raw *<br/>sensorId lat lon timestamp

    Worker->>Stream: XREADGROUP GROUP gps-workers<br/>worker-1234 COUNT 10
    Stream-->>Worker: 10 messages

    loop For each message
        Worker->>State: GETBUFFER gps:state:{sensorId}
        State-->>Worker: 212-byte state buffer

        Note over Worker: 1. Position Pipeline dspx<br/>   (Kalman 2D: lat,lon)<br/>2. Haversine Distance<br/>3. Velocity Pipeline dspx<br/>   (MovingAvg 1D: velocity)

        Worker->>State: SETEX gps:state:{sensorId}<br/>3600 [binary state]

        Worker->>PubSub: PUBLISH gps:processed<br/>{lat, smoothedLat, velocity...}
    end

    PubSub-->>SSE: message event
    SSE->>Browser: Server-Sent Event<br/>data: {...}\n\n

    Note over Browser: updateTrace()<br/>Leaflet.polyline.addLatLng()
```

### Performance Metrics

| Metric             | Value            | Notes                               |
| ------------------ | ---------------- | ----------------------------------- |
| Processing Latency | <5ms             | Per GPS point (including Redis I/O) |
| Throughput         | 1000+ points/sec | Per worker instance                 |
| State Size         | 212 bytes        | Per sensor (binary serialization)   |
| Browser Rendering  | 60 FPS           | Up to 1000+ points on screen        |
| Memory (Worker)    | ~50 MB           | Node.js + Redis client              |
| Memory (Browser)   | ~100 MB          | Leaflet + traces                    |

---

## Redis Data Structures

### Streams

```redis
# gps:raw - Input queue
XADD gps:raw * sensorId "000-20081023025304" lat "39.984" lon "116.318" timestamp "1734567890000"

# Consumer group
XGROUP CREATE gps:raw gps-workers 0 MKSTREAM
```

### Pub/Sub

```redis
# gps:processed - Output broadcast
PUBLISH gps:processed '{"sensorId":"000-20081023025304","lat":39.984,...}'
```

### State Storage

```redis
# gps:state:{sensorId} - Kalman state (binary)
SETEX gps:state:000-20081023025304 3600 <212-byte binary buffer>
```

---

## Scaling Strategies

### Horizontal Scaling (Workers)

```bash
# Run multiple worker instances
npm run dev:worker  # Terminal 1
npm run dev:worker  # Terminal 2
npm run dev:worker  # Terminal 3
```

**Benefits**:

- Redis consumer groups automatically distribute messages
- Each worker processes different sensors
- Linear throughput scaling

### Vertical Scaling (SSE Server)

```bash
# Use cluster module for multi-core
import cluster from 'cluster';
import os from 'os';

if (cluster.isPrimary) {
  for (let i = 0; i < os.cpus().length; i++) {
    cluster.fork();
  }
} else {
  startSSEServer();
}
```

### Sharding (Redis)

```bash
# Partition by sensor ID hash
sensorId % numShards = shard_index

# Route to different Redis instances
redis_shard_0: sensors 000-099
redis_shard_1: sensors 100-199
```

---

## Algorithm Deep Dive

### Kalman Filter Mathematics

```mermaid
graph LR
    subgraph "State Vector (4D)"
        X[x = lat, lon<br/>lat_vel, lon_vel]
    end

    subgraph "Predict Step"
        X --> P1[x̂ₖ₊₁|ₖ = F·xₖ|ₖ]
        P1 --> P2[Pₖ₊₁|ₖ = F·Pₖ|ₖ·Fᵀ + Q]
    end

    subgraph "Update Step"
        Z[Measurement<br/>lat, lon] --> U1[y = z - H·x̂]
        P2 --> U2[S = H·P·Hᵀ + R]
        U1 --> U3[K = P·Hᵀ·S⁻¹]
        U2 --> U3
        U3 --> U4[x = x̂ + K·y]
        U3 --> U5[P = I - K·H·P]
    end

    U4 --> Output[Smoothed Position]
    U5 --> NextCycle[Next Iteration]

    style X fill:#805ad5,stroke:#9f7aea,color:#fff
    style P1 fill:#2b6cb0,stroke:#3182ce,color:#fff
    style P2 fill:#2b6cb0,stroke:#3182ce,color:#fff
    style Z fill:#d69e2e,stroke:#ecc94b,color:#000
    style U1 fill:#2f855a,stroke:#38a169,color:#fff
    style U2 fill:#2f855a,stroke:#38a169,color:#fff
    style U3 fill:#2f855a,stroke:#38a169,color:#fff
    style U4 fill:#2f855a,stroke:#38a169,color:#fff
    style U5 fill:#2f855a,stroke:#38a169,color:#fff
    style Output fill:#0066cc,stroke:#3182ce,color:#fff
```

**State Vector** (4D):

```
x = [lat, lon, lat_velocity, lon_velocity]ᵀ
```

**State Transition** (constant velocity model):

```
F = [ 1  0  dt  0 ]
    [ 0  1  0  dt ]
    [ 0  0  1   0 ]
    [ 0  0  0   1 ]
```

**Measurement Matrix** (observe position only):

```
H = [ 1  0  0  0 ]
    [ 0  1  0  0 ]
```

**Predict Step**:

```
x̂ₖ₊₁|ₖ = F·xₖ|ₖ
Pₖ₊₁|ₖ = F·Pₖ|ₖ·Fᵀ + Q
```

**Update Step**:

```
y = z - H·x̂     (innovation)
S = H·P·Hᵀ + R   (innovation covariance)
K = P·Hᵀ·S⁻¹     (Kalman gain)
x = x̂ + K·y      (updated state)
P = (I - K·H)·P  (updated covariance)
```

### Two-Pipeline Architecture

```typescript
// Initialize two separate pipelines in constructor
class GPSPipeline {
  private positionPipeline: ReturnType<typeof createDspPipeline>;
  private velocityPipeline: ReturnType<typeof createDspPipeline>;

  constructor() {
    // Position pipeline: Kalman filter for 2D coordinates
    this.positionPipeline = createDspPipeline();
    this.positionPipeline.KalmanFilter({
      dimensions: 2, // 2D: lat, lon
      processNoise: 1e-4, // Very smooth (0.0001)
      measurementNoise: 1e-7, // High trust in GPS (0.0000001)
      initialError: 1.0,
    });

    // Velocity pipeline: Moving average for 1D velocity
    this.velocityPipeline = createDspPipeline();
    this.velocityPipeline.MovingAverage({
      mode: "moving",
      windowSize: 5,
    });
  }

  async process(point: GPSPoint, state: KalmanState) {
    // Process position through 2-channel pipeline
    const measurement = new Float32Array([point.lat, point.lon]);

    // CRITICAL: Calculate time delta (dt), not absolute timestamp
    const dt =
      state.lastTimestamp > 0
        ? (point.timestamp - state.lastTimestamp) / 1000
        : 0.1; // Default to 0.1s for first point
    const positionDeltas = new Float32Array([dt, dt]);

    const smoothedPosition = await this.positionPipeline.process(
      measurement,
      positionDeltas, // Time deltas, not timestamps!
      { channels: 2 } // 2-channel input for lat, lon
    );

    // Calculate velocity using Haversine distance
    const velocity = calculateVelocity(state, smoothedPosition);

    // Process velocity through 1-channel pipeline
    const velocityArray = new Float32Array(state.velocityBuffer);
    const velocityDeltas = new Float32Array(5).fill(dt); // Uniform time steps
    const smoothedVelocity = await this.velocityPipeline.process(
      velocityArray,
      velocityDeltas,
      { channels: 1 } // 1-channel input for velocity
    );

    return { smoothedPosition, smoothedVelocity };
  }
}
```

### Haversine Distance

```typescript
function haversine(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS * c; // meters
}
```

---

## Configuration

### Environment Variables

```bash
# Redis connection
REDIS_URL=redis://localhost:6379

# Worker settings
BATCH_SIZE=10           # Messages per read
BLOCK_MS=5000          # Read timeout (ms)

# Replay settings
REPLAY_SPEED=10        # Time multiplier (1=real-time)
NUM_TRAJECTORIES=3     # Trajectories to load

# Kalman filter (edit shared/gps-pipeline.ts constructor)
PROCESS_NOISE=0.0001     # Process variance in degrees
MEASUREMENT_NOISE=0.0001 # GPS variance in degrees (~10m)
INITIAL_ERROR=0.0001     # Initial uncertainty in degrees
```

### Tuning Guidelines

**Understanding the Scale**:

- Input coordinates are in **degrees** (lat/lon)
- ~0.0001 degrees ≈ 11 meters at the equator
- All noise parameters must be in **degree units**, not meters

**Current configuration** (balanced smoothing):

- `processNoise: 0.0001` - Process variance (how much position changes per timestep)
- `measurementNoise: 0.0001` - GPS sensor variance (~10m accuracy in degrees)
- `initialError: 0.0001` - Initial position uncertainty

**For more aggressive smoothing**:

- Decrease `processNoise` (e.g., 0.00001) - assume very smooth motion
- Keep `measurementNoise` same or increase (trust GPS less)

**For more responsive tracking**:

- Increase `processNoise` (e.g., 0.001) - allow faster position changes
- Decrease `measurementNoise` (e.g., 0.00005) - trust GPS more

**CRITICAL REMINDER**: Always pass **time deltas (dt)**, not absolute timestamps!

**Note**: Edit `shared/gps-pipeline.ts` constructor to change these values

**For high-speed replay**:

- Increase `REPLAY_SPEED` (e.g., 50x)
- Increase `BATCH_SIZE` (e.g., 50)

---

## Deployment

### Docker Compose

```yaml
version: "3.8"
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  worker:
    build: .
    command: npm run dev:worker
    depends_on:
      - redis
    environment:
      - REDIS_URL=redis://redis:6379
    deploy:
      replicas: 3 # Horizontal scaling

  sse-server:
    build: .
    command: npm run dev:sse
    ports:
      - "3002:3002"
    depends_on:
      - redis

  client:
    build: .
    command: npm run dev:client
    ports:
      - "5173:5173"
    depends_on:
      - sse-server
```

### Production Checklist

- ✅ Redis persistence enabled (AOF + RDB)
- ✅ Redis memory limit configured (`maxmemory-policy allkeys-lru`)
- ✅ Worker health checks (PING Redis, check consumer lag)
- ✅ SSE connection limits (per IP rate limiting)
- ✅ CORS properly configured (whitelist allowed origins)
- ✅ HTTPS/TLS for production (Let's Encrypt)
- ✅ Monitoring (Grafana + Prometheus for Redis metrics)
- ✅ Error logging (Winston + Sentry)

---

## Future Enhancements

### Algorithm Improvements

- **Extended Kalman Filter (EKF)**: Handle non-linear motion models (custom stage)
- **Particle Filter**: Better for multimodal distributions (custom stage)
- **ZUPT (Zero Velocity Update)**: Detect stops more accurately
- **Map Matching**: Snap GPS to road networks
- **Adaptive Kalman**: Dynamically adjust process/measurement noise
- **Multi-sensor Fusion**: Combine GPS + IMU using dspx pipelines

### Architecture Enhancements

- **GraphQL Subscriptions**: Alternative to SSE
- **WebRTC Data Channels**: Lower latency for real-time
- **Time-series DB**: InfluxDB for historical trajectory storage
- **Edge Processing**: WASM-based filtering in browser

### Features

- **Trajectory Prediction**: Forecast next N positions
- **Anomaly Detection**: Flag unusual movement patterns
- **Multi-device Fusion**: Combine phone + watch + car GPS
- **Geofencing**: Alert when entering/exiting zones

---

## References

- [Kalman Filter Explained](https://www.kalmanfilter.net/)
- [Redis Streams Tutorial](https://redis.io/docs/data-types/streams-tutorial/)
- [Leaflet Documentation](https://leafletjs.com/reference.html)
- [Geolife Dataset Paper](https://www.microsoft.com/en-us/research/publication/geolife-gps-trajectory-dataset-user-guide/)
- [Server-Sent Events Spec](https://html.spec.whatwg.org/multipage/server-sent-events.html)

---

Built with **dspx** - Digital Signal Processing for TypeScript 🚀
