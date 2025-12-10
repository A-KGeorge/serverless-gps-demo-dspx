# GPS Trajectory Demo - Quick Start Guide

## Prerequisites

1. **Redis** - Running on `localhost:6379` (or set `REDIS_URL` environment variable)
2. **Geolife Dataset** - Download from Kaggle and place in it in the root directory (you can extract directly from the compressed archive, under the `archive/` folder)

## Installation

```bash
cd examples/gps-demo
npm install
```

## Running the Demo

### Option 1: Full System (Recommended)

Run all components together:

```bash
# Terminal 1: Start worker + SSE server + client
npm run dev
```

Then in a separate terminal:

```bash
# Terminal 2: Start data replay
npm run replay
```

### Option 2: Individual Components

Run each component separately for debugging:

```bash
# Terminal 1: Worker (processes GPS data)
npm run dev:worker

# Terminal 2: SSE Server (streams data to browser)
npm run dev:sse

# Terminal 3: Client (web interface)
npm run dev:client

# Terminal 4: Data replay (sends GPS data)
npm run replay
```

## Accessing the Demo

Open your browser to: **http://localhost:5173**

## Architecture Flow

```
Geolife Dataset (archive/)
    ↓
Data Replay (data/replay.ts)
    ↓ Redis Stream: gps:raw
GPS Worker (worker/gps-worker.ts)
    ↓ 5-Step Pipeline
    ↓ Redis Pub/Sub: gps:processed
SSE Server (client/sse-server.ts)
    ↓ Server-Sent Events
Web Client (index.html + client/app.ts)
    ↓
Leaflet Map Visualization
```

## Configuration

### Environment Variables

```bash
# Redis connection
REDIS_URL=redis://localhost:6379

# Replay settings
REPLAY_SPEED=10          # 10x real-time (default)
NUM_TRAJECTORIES=3       # Number of trajectories to load (default)
```

### Replay Speed Examples

```bash
# Real-time replay (1x speed)
REPLAY_SPEED=1 npm run replay

# Fast replay (50x speed)
REPLAY_SPEED=50 npm run replay

# Instant replay (no delays)
REPLAY_SPEED=1000 npm run replay
```

## Features

- **Real-time Visualization**: See GPS traces appear on map as they're processed
- **Raw vs Filtered Toggle**: Compare noisy GPS with Kalman-smoothed output
- **Multi-sensor Support**: Track multiple trajectories simultaneously
- **Live Statistics**: View points processed, average velocity, movement status
- **Interactive Map**: Pan, zoom, click markers for sensor info

## Troubleshooting

### "No trajectories loaded"

Make sure Geolife dataset is in `./archive/` with structure:

```
archive/
├── 000/
│   └── Trajectory/
│       ├── 20081023025304.plt
│       └── ...
├── 001/
└── ...
```

### "Redis connection refused"

Start Redis server:

```bash
# Windows
redis-server

# Linux/Mac
sudo systemctl start redis
# or
brew services start redis
```

### Client shows "Disconnected"

Ensure SSE server is running:

```bash
npm run dev:sse
```

Check console output - should show: `🌐 SSE Server running on http://localhost:3002`

## Dataset

**Microsoft Geolife GPS Trajectory Dataset**

- Source: https://www.kaggle.com/datasets/arashnic/microsoft-geolife-gps-trajectory-dataset
- Size: ~18,000 trajectories from 182 users
- Location: Beijing, China
- Collection period: 2007-2012
- Sampling: 1-5 second intervals

## Performance

- **Processing**: <5ms per GPS point
- **Throughput**: 1000+ points/second per worker
- **State size**: 212 bytes per sensor in Redis
- **Browser rendering**: 60 FPS with 1000+ points on screen

## Next Steps

1. **Experiment with parameters**: Edit `shared/kalman-filter.ts` to adjust process/measurement noise
2. **Add more sensors**: Modify `data/replay.ts` to load more trajectories
3. **Try different speeds**: Vary `REPLAY_SPEED` to see behavior at different rates
4. **Horizontal scaling**: Run multiple workers to process in parallel

Enjoy exploring GPS trajectory smoothing with dspx! 🛰️
