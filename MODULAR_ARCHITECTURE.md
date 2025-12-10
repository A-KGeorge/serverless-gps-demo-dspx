# Modular GPS Demo Architecture

This document describes the **modular microservices architecture** where each GPS processing stage runs as an independent, horizontally-scalable worker.

## Architecture Overview

The system is split into **three independent workers**, each consuming from and publishing to Redis Streams:

```
gps:raw → [Position Smoother] → gps:position-smoothed → [Velocity Calculator] → gps:velocity-calculated → [Velocity Smoother] → gps:processed (pub/sub)
```

## Workers

### 1. Position Smoother (`worker/position-smoother.ts`)

**Purpose**: Apply Kalman filtering to raw GPS coordinates

- **Input Stream**: `gps:raw`
- **Output Stream**: `gps:position-smoothed`
- **Consumer Group**: `position-smoothers`
- **Technology**: dspx Kalman Filter (2D)

**Processing**:

1. Reads raw GPS points (sensorId, lat, lon, timestamp)
2. Calculates time delta (dt) since last point
3. Applies 2D Kalman filter with process/measurement noise = 0.0001
4. Outputs smoothed coordinates

**Scalability**: CPU-intensive stage - scale horizontally for high sensor counts

---

### 2. Velocity Calculator (`worker/velocity-calculator.ts`)

**Purpose**: Calculate instantaneous velocity using Haversine distance

- **Input Stream**: `gps:position-smoothed`
- **Output Stream**: `gps:velocity-calculated`
- **Consumer Group**: `velocity-calculators`
- **Technology**: Pure JavaScript (geospatial math)

**Processing**:

1. Reads smoothed GPS positions
2. Calculates great-circle distance using Haversine formula
3. Divides by time delta to get velocity (m/s)
4. Outputs position + velocity

**Why Separate?**:

- Haversine is not DSP - it's geospatial calculation
- Can be replaced with alternative distance algorithms
- Demonstrates modularity and technology flexibility

**Scalability**: Lightweight computation - single instance handles high throughput

---

### 3. Velocity Smoother (`worker/velocity-smoother.ts`)

**Purpose**: Apply moving average to velocity data and publish final results

- **Input Stream**: `gps:velocity-calculated`
- **Output**: `gps:processed` pub/sub channel
- **Consumer Group**: `velocity-smoothers`
- **Technology**: dspx Moving Average (1D)

**Processing**:

1. Reads velocity data
2. Maintains circular buffer (5 samples per sensor)
3. Applies 1D moving average filter
4. Determines movement status (threshold: 0.5 m/s)
5. Publishes final result to SSE server via pub/sub

**Scalability**: I/O-intensive (final stage) - scale for high message rates

---

## Redis Stream Topology

```redis
# Stage 1: Raw GPS → Position Smoother
XADD gps:raw * sensorId "000-20081023025304" lat "39.984" lon "116.318" timestamp "1734567890000"

# Stage 2: Position Smoothed → Velocity Calculator
XADD gps:position-smoothed * sensorId "000-20081023025304" smoothedLat "39.9842" smoothedLon "116.3182" lat "39.984" lon "116.318" timestamp "1734567890000"

# Stage 3: Velocity Calculated → Velocity Smoother
XADD gps:velocity-calculated * sensorId "000-20081023025304" smoothedLat "39.9842" smoothedLon "116.3182" velocity "12.5" lat "39.984" lon "116.318" timestamp "1734567890000"

# Final: Processed → SSE Server (pub/sub)
PUBLISH gps:processed '{"sensorId":"000-20081023025304","smoothedLat":39.9842,"smoothedVelocity":11.8,"isMoving":true}'
```

## Running the System

### Modular Architecture (Recommended)

```bash
# Start all three workers + SSE + client
npm run dev

# Or start individually:
npm run dev:position        # Position Smoother
npm run dev:velocity-calc   # Velocity Calculator
npm run dev:velocity-smooth # Velocity Smoother
npm run dev:sse            # SSE Server
npm run dev:client         # Vite dev server
```

### Legacy Monolithic Worker

```bash
# Run original single-worker architecture
npm run dev:monolith
```

## Scaling Strategies

### Identify Bottlenecks

Check stream lengths to find slow stages:

```bash
redis-cli XLEN gps:raw                  # Should be near 0
redis-cli XLEN gps:position-smoothed    # Check backlog
redis-cli XLEN gps:velocity-calculated  # Check backlog
```

### Scale Bottleneck Stages

**If Position Smoother is slow** (Kalman filter CPU-bound):

```bash
npm run dev:position  # Terminal 1
npm run dev:position  # Terminal 2
npm run dev:position  # Terminal 3
```

**If Velocity Smoother is slow** (high message rate):

```bash
npm run dev:velocity-smooth  # Terminal 1
npm run dev:velocity-smooth  # Terminal 2
```

### Performance Tuning

| Worker              | Tuning Parameter                   | Impact                       |
| ------------------- | ---------------------------------- | ---------------------------- |
| Position Smoother   | `processNoise`, `measurementNoise` | Smoothness vs responsiveness |
| Velocity Calculator | None (stateless)                   | Horizontal scaling only      |
| Velocity Smoother   | `windowSize` (default: 5)          | Velocity smoothing window    |
| All                 | `BATCH_SIZE` (default: 10)         | Throughput vs latency        |

## Benefits of Modular Architecture

### vs. Monolithic Worker

| Aspect                | Modular                                   | Monolithic                 |
| --------------------- | ----------------------------------------- | -------------------------- |
| **Scalability**       | ✅ Independent scaling per stage          | ❌ All-or-nothing scaling  |
| **Flexibility**       | ✅ Swap algorithms per stage              | ❌ Tightly coupled         |
| **Debugging**         | ✅ Monitor each stage separately          | ❌ Black box processing    |
| **Failure Isolation** | ✅ Stage crash doesn't affect others      | ❌ Single point of failure |
| **Technology Mix**    | ✅ dspx + JavaScript + (future: Rust/GPU) | ❌ Single tech stack       |
| **Deployment**        | ❌ More complex (3 processes)             | ✅ Simple (1 process)      |
| **Latency**           | ❌ Inter-process communication overhead   | ✅ In-memory processing    |

### Use Cases

**Use Modular When**:

- High sensor count (>100 sensors)
- Need independent scaling
- Want to experiment with algorithms
- Production deployment with monitoring

**Use Monolithic When**:

- Development/testing
- Low sensor count (<50 sensors)
- Minimal latency requirement
- Simple deployment constraints

## Monitoring

### Stream Lag

```bash
# Check consumer group lag (messages waiting)
redis-cli XPENDING gps:raw position-smoothers
redis-cli XPENDING gps:position-smoothed velocity-calculators
redis-cli XPENDING gps:velocity-calculated velocity-smoothers
```

### Worker Health

Each worker logs processing status:

- ✅ Success messages with sensor ID and results
- ⚠️ Warnings for invalid data
- ❌ Errors with message ID for replay

### Throughput Metrics

```bash
# Messages per second (estimate from stream info)
redis-cli XINFO STREAM gps:raw
redis-cli XINFO STREAM gps:position-smoothed
redis-cli XINFO STREAM gps:velocity-calculated
```

## Future Enhancements

### Parallel Processing per Stage

```bash
# Scale position smoothing to 3 workers
npm run dev:position  # Worker 1
npm run dev:position  # Worker 2
npm run dev:position  # Worker 3
```

Redis consumer groups automatically distribute messages across workers.

### Alternative Algorithms

**Position Smoother**:

- Replace Kalman with Particle Filter
- Add Extended Kalman Filter (EKF) for non-linear motion
- GPU-accelerated filtering for high-frequency data

**Velocity Calculator**:

- Replace Haversine with Vincenty formula (higher accuracy)
- Add IMU sensor fusion
- Implement map-matching for road-constrained motion

**Velocity Smoother**:

- Adaptive window size based on velocity
- Outlier detection and removal
- Predictive velocity estimation

### Observability

Add metrics collection to each worker:

- Prometheus exporters for throughput/latency
- Grafana dashboards per stage
- Distributed tracing (OpenTelemetry)

---

**Built with dspx** - Digital Signal Processing for TypeScript 🚀
