# LMU Telemetry Dashboard

Node.js server that reads Le Mans Ultimate telemetry from
`rFactor2SharedMemoryMapPlugin64.dll`, streams it to a browser dashboard over
WebSocket, and asks Claude for a live tire analysis.

Open **http://localhost:3000** on your second monitor once the server is running.

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
| `public/index.html` | The dashboard (single file, inline CSS/JS, no build step) |
| `src/rf2Layout.js` | rF2 shared-memory struct definitions (`#pragma pack(4)`) |
| `src/sharedMemory.js` | Opens `$rF2SMMP_Telemetry$` / `$rF2SMMP_Scoring$` via kernel32 and copies torn-read-safe snapshots |
| `src/telemetryParser.js` | Buffers → normalized snapshot (°C, kPa, wear %) |
| `src/tireHistory.js` | 1 Hz tire history, per-lap wear, 60 s trends |
| `src/claudeClient.js` | Shared Claude API wrapper: structured JSON output, refusal/fallback handling, cost tally |
| `src/tire-analyzer.js` | Tire metrics + Claude tire engineer (health, pressures, pit window, driving tips) |
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

HTTP: `GET /api/health`, `GET /api/snapshot`, `GET /api/tire-analysis`.

WebSocket `ws://localhost:3000/telemetry`: every message is `{ "type", "data" }`.

| type | when | data |
|---|---|---|
| `hello` | on connect | status (source, connected, live, ai config and running cost) |
| `status` | connection state changes | same as `hello` |
| `telemetry` | 10 Hz | `{ session, vehicle, tires: { FL, FR, RL, RR }, live, timestamp }` |
| `tire_analysis` | each Claude tire result | see [Tire analysis](#tire-analysis) |
| `analysis_error` | a Claude call failed | `{ source, message, at }` |
| `pong` | reply to `{ "type": "ping" }` | `{ at }` |

Send `{ "type": "requestAnalysis" }` to trigger a tire analysis immediately.

Each tire in `telemetry` has `pressureKpa`, `temps { innerC, middleC, outerC }`,
`surfaceTempC`, `carcassTempC`, `wearPercent` (0 = new), `remainingPercent`,
`brakeTempC`, `loadN`, `gripFraction`, `flat`, `detached`.

## Dashboard

- Four tires laid out as on the car. Tread temps are split into outer/middle/inner
  edges and colored cold → optimal → overheat; the ⚙ menu sets the optimal
  window (default 75–100 °C), pressure unit (psi/kPa) and speed unit.
- Speed, gear, RPM, current/last/best lap with delta, fuel with laps remaining
  (fuel per lap is measured from completed laps).
- Claude panel: latest verdict and recommendations, plus an "engineer radio"
  feed. Repeated identical verdicts collapse into one message with a ×N count.
  Tires Claude flags are outlined on the car.
- Fits 1920×1080 and 1366×768 without scrolling; stacks on phones and tablets.

## Tire analysis

`src/tire-analyzer.js` first computes the numbers an engineer reads, then asks
Claude (as the team's tire engineer) to judge them:

- per tire: inner/middle/outer temps, inner−outer spread (camber),
  middle−edges (pressure), carcass temp, hot pressure in PSI, wear %, wear per
  lap (from completed laps, or extrapolated from the last 60 s before the first
  full lap), laps to the wear limit, 60 s temp/pressure trends
- front/rear and left/right temperature and wear balance
- the tire that limits the stint, and laps/time left in the session

Result (`tire_analysis` message, `GET /api/tire-analysis`):

```json
{
  "tire_health": "fair",
  "pressure_adjustment": "-0.2 PSI front left",
  "pit_window": "8-12 laps",
  "driving_tips": ["Less trail-brake into slow right-handers", "Smoother throttle on exit"],
  "analysis": "Front left overheating on the inside edge; take 0.2 PSI out at the stop.",
  "temperature_analysis": "Fronts at the top of the window and rising; rears centered.",
  "pressure_adjustments": [{ "tire": "FL", "change_psi": -0.2, "reason": "hot inside edge" }],
  "pit_window_laps": { "earliest": 8, "latest": 12 },
  "tires": { "FL": { "health": "fair", "temperature_state": "hot", "note": "Inner edge +12°C" } },
  "metrics": { "...": "the computed numbers above" },
  "lap": 14, "createdAt": "…", "model": "claude-opus-5", "latencyMs": 3100,
  "usage": { "inputTokens": 2600, "outputTokens": 600, "costUsd": 0.028 }
}
```

The first five fields are the core contract; the rest are extras the dashboard
uses. Pressure changes are cold-pressure changes for the next stop. The
telemetry has no corner-by-corner data, so tips name corner types rather than
turn numbers.

Use it on its own:

```js
const { ClaudeClient } = require('./src/claudeClient');
const { TireAnalyzer } = require('./src/tire-analyzer');

const tires = new TireAnalyzer({ client: new ClaudeClient({ apiKey: process.env.CLAUDE_API_KEY }) });
const result = await tires.analyze(snapshot, tireHistory.summary());
```
