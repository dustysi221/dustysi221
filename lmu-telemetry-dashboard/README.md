# LMU Telemetry Dashboard

Node.js server that reads Le Mans Ultimate telemetry from
`rFactor2SharedMemoryMapPlugin64.dll`, streams it to a browser dashboard over
WebSocket, and asks Claude for live tire analysis and race strategy calls.

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
| `src/sessionTracker.js` | Whole-session history: per-lap time/fuel/wear, stints, pit stops, rival lap times |
| `src/strategy-analyzer.js` | Strategy metrics + Claude strategist (pit timing, fuel, tire trend, rivals) |
| `src/mockSource.js` | Simulator that emits real rF2 binary buffers |

## Timing

| Loop | Default | Env |
|---|---|---|
| Shared-memory read + WebSocket broadcast | 10 Hz | `BROADCAST_HZ` |
| Tire history sample | 1 s | `TIRE_SAMPLE_MS` |
| Claude tire analysis | 5 s | `ANALYSIS_INTERVAL_MS` |
| Claude strategy | after each clean lap and each pit stop (max 180 s apart) | `STRATEGY_MAX_INTERVAL_MS` |

Claude analysis runs only while at least one dashboard is connected and the car
is live (not paused or in menus), and never overlaps: a slow response skips
ticks instead of stacking up requests.

## API

HTTP: `GET /api/health`, `GET /api/snapshot`, `GET /api/tire-analysis`, `GET /api/strategy`.

WebSocket `ws://localhost:3000/telemetry`: every message is `{ "type", "data" }`.

| type | when | data |
|---|---|---|
| `hello` | on connect | status (source, connected, live, ai config and running cost) |
| `status` | connection state changes | same as `hello` |
| `telemetry` | 10 Hz | `{ session, vehicle, tires: { FL, FR, RL, RR }, live, timestamp }` |
| `tire_analysis` | each Claude tire result | see [Tire analysis](#tire-analysis) |
| `strategy` | each Claude strategy call | see [Race strategy](#race-strategy) |
| `analysis_error` | a Claude call failed | `{ source, message, at }` |
| `pong` | reply to `{ "type": "ping" }` | `{ at }` |

Send `{ "type": "requestAnalysis" }` or `{ "type": "requestStrategy" }` to run a tire
analysis or strategy call immediately.

Each tire in `telemetry` has `pressureKpa`, `temps { innerC, middleC, outerC }`,
`surfaceTempC`, `carcassTempC`, `wearPercent` (0 = new), `remainingPercent`,
`brakeTempC`, `loadN`, `gripFraction`, `flat`, `detached`.

## Dashboard

- Four tires laid out as on the car. Tread temps are split into outer/middle/inner
  edges and colored cold → optimal → overheat; the ⚙ menu sets the optimal
  window (default 75–100 °C), pressure unit (psi/kPa) and speed unit.
- Speed, gear, RPM, current/last/best lap with delta, fuel with laps remaining
  (fuel per lap is measured from completed laps).
- Claude panel in three columns: tire engineer (health, pressure change, pit
  window, driving tips), strategist (the call, fuel, tire trend, plan, rivals,
  next-stop service), and an "engineer radio" feed. A verdict identical to the
  previous one from the same engineer collapses into one message with a ×N
  count. Tires Claude flags are outlined on the car.
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

## Race strategy

`src/sessionTracker.js` keeps the whole session at 1 Hz: one record per
completed lap (lap time, fuel used, wear per tire, stint), pit stops (detected
from refuelling, a tire change, or the game's stop counter) and recent lap
times for every car. Laps with a pit visit, and the partial lap the server
joined on, are excluded from averages.

`src/strategy-analyzer.js` turns that into strategy numbers:

- race: laps remaining (lap limit, or estimated from time left and pace in a
  timed race), positions
- fuel: L/lap from the last 3 clean laps, laps in the tank, fuel needed to
  finish plus a reserve lap, shortfall, **last lap you can still pit on**,
  stops needed
- tires: wear per lap now vs start of stint (acceleration), laps to the wear
  limit, whether the set reaches the flag, laps a new set lasts, the tire
  engineer's latest verdict
- pace: recent clean laps and stint degradation (s/lap)
- rivals: class leader and the cars directly ahead/behind in class, with gap,
  average pace and pace delta per lap, stops made
- pit loss (`PIT_LOSS_SEC`, an estimate you set per track)

Claude, as the strategist, returns (`strategy` message, `GET /api/strategy`):

```json
{
  "pit_recommendation": "Pit at the end of lap 30 for fuel; the tires reach the flag.",
  "fuel_status": "2.9 L/lap, 47.9 L in tank = 16.5 laps; need 117 L to finish",
  "tire_trend": "FL wear 1.1 %/lap and rising slightly; makes the finish",
  "strategy": "One stop, fuel only at lap 30. Switch to four tires if FL wear passes 1.6 %/lap.",
  "confidence": "high",
  "call": "Stay out. Box end of lap 30, fuel only",
  "competitor_analysis": "#6 1.5 s ahead and 0.8 s/lap quicker; #8 10 s behind, no undercut threat.",
  "pit_lap": 30, "pit_window_laps": { "earliest": 28, "latest": 30 },
  "stops_remaining": 1, "tires_to_finish": "yes", "service": "Fuel +70 L, no tires",
  "metrics": { "...": "the computed numbers above" },
  "lap": 15, "createdAt": "…", "model": "claude-opus-5", "latencyMs": 4200
}
```

The first five fields are the core contract. Lap numbers are absolute race laps.
Confidence is "low" until there are clean laps of fuel and wear data, and the
prompt tells Claude never to plan a stop later than the fuel or tire limit.

Use it on its own:

```js
const { SessionTracker } = require('./src/sessionTracker');
const { StrategyAnalyzer } = require('./src/strategy-analyzer');

const tracker = new SessionTracker();       // tracker.record(snapshotWithField) once per second
const strategy = new StrategyAnalyzer({ client: claudeClient, tracker, pitLossSec: 40 });
const call = await strategy.analyze(snapshotWithField, latestTireAnalysis);
```
