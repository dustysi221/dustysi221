# LMU Telemetry Dashboard — backend

Node.js server that reads Le Mans Ultimate telemetry from
`rFactor2SharedMemoryMapPlugin64.dll`, streams it to dashboards over
WebSocket, and asks Claude for a live tire analysis.

Full installation steps come later; quick start:

```bash
npm install
copy .env.example .env      # then put your key in CLAUDE_API_KEY
npm start                   # live LMU telemetry (Windows)
npm run mock                # simulated car, any OS, no game needed
npm test
```

## Layout

| File | Purpose |
|---|---|
| `server.js` | Express + WebSocket server, polling loop, analysis scheduler |
| `src/rf2Layout.js` | rF2 shared-memory struct definitions (`#pragma pack(4)`) |
| `src/sharedMemory.js` | Opens `$rF2SMMP_Telemetry$` / `$rF2SMMP_Scoring$` via kernel32 and copies torn-read-safe snapshots |
| `src/telemetryParser.js` | Buffers → normalized snapshot (°C, kPa, wear %) |
| `src/tireHistory.js` | 1 Hz tire history, per-lap wear, 60 s trends |
| `src/claudeAnalyzer.js` | Claude API tire analysis with structured JSON output |
| `src/mockSource.js` | Simulator that emits real rF2 binary buffers |

## Timing

| Loop | Default | Env |
|---|---|---|
| Shared-memory read + WebSocket broadcast | 10 Hz | `BROADCAST_HZ` |
| Tire history sample | 1 s | `TIRE_SAMPLE_MS` |
| Claude analysis | 5 s | `ANALYSIS_INTERVAL_MS` |

Claude analysis runs only while at least one dashboard is connected and the car
is live (not paused or in menus), and never overlaps: a slow response skips
ticks instead of stacking up requests.

## API

HTTP: `GET /api/health`, `GET /api/snapshot`, `GET /api/analysis`.

WebSocket `ws://localhost:3000/telemetry`: every message is `{ "type", "data" }`.

| type | when | data |
|---|---|---|
| `hello` | on connect | status (source, connected, live, ai config and running cost) |
| `status` | connection state changes | same as `hello` |
| `telemetry` | 10 Hz | `{ session, vehicle, tires: { FL, FR, RL, RR }, live, timestamp }` |
| `analysis` | each Claude result | `{ overallStatus, summary, tires: { FL: { status, note }, … }, recommendations, estimatedLapsRemaining, model, latencyMs, usage, totals }` |
| `analysis_error` | a Claude call failed | `{ message, at }` |
| `pong` | reply to `{ "type": "ping" }` | `{ at }` |

Send `{ "type": "requestAnalysis" }` to trigger an analysis immediately.

Each tire in `telemetry` has `pressureKpa`, `temps { innerC, middleC, outerC }`,
`surfaceTempC`, `carcassTempC`, `wearPercent` (0 = new), `remainingPercent`,
`brakeTempC`, `loadN`, `gripFraction`, `flat`, `detached`.
