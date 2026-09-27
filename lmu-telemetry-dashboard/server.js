'use strict';

/**
 * LMU telemetry server
 *
 *  - reads Le Mans Ultimate telemetry from rFactor2SharedMemoryMapPlugin64.dll
 *    shared memory (Windows) or a built-in simulator (TELEMETRY_SOURCE=mock)
 *  - broadcasts snapshots to dashboards over ws://HOST:PORT/telemetry at 10 Hz
 *  - samples tire history at 1 Hz
 *  - asks Claude for a tire analysis (src/tire-analyzer.js) every ANALYSIS_INTERVAL_MS
 *  - asks Claude for a strategy call (src/strategy-analyzer.js) after every lap and pit stop
 *  - broadcasts both to the dashboard
 */

require('dotenv').config({ quiet: true });

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const { parseSnapshot } = require('./src/telemetryParser');
const { TireHistory } = require('./src/tireHistory');
const { ClaudeClient, describeClaudeError } = require('./src/claudeClient');
const { TireAnalyzer } = require('./src/tire-analyzer');
const { SessionTracker } = require('./src/sessionTracker');
const { StrategyAnalyzer } = require('./src/strategy-analyzer');

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 3000),
  source: process.argv.includes('--mock') ? 'mock' : (process.env.TELEMETRY_SOURCE || 'auto').toLowerCase(),
  mockSpeed: Number(process.env.MOCK_SPEED) || 1,
  broadcastHz: intEnv('BROADCAST_HZ', 10),
  tireSampleMs: intEnv('TIRE_SAMPLE_MS', 1000),
  analysisIntervalMs: intEnv('ANALYSIS_INTERVAL_MS', 5000),
  apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '',
  model: process.env.ANALYSIS_MODEL || 'claude-opus-5',
  effort: process.env.ANALYSIS_EFFORT || 'low',
  fallbacks: (process.env.ANALYSIS_FALLBACKS || 'true') !== 'false',
  tireOptimalMinC: numEnv('TIRE_OPTIMAL_MIN_C', 75),
  tireOptimalMaxC: numEnv('TIRE_OPTIMAL_MAX_C', 100),
  tireWearLimitPercent: numEnv('TIRE_WEAR_LIMIT_PERCENT', 75),
  pitLossSec: numEnv('PIT_LOSS_SEC', 35),
  fuelReserveLaps: numEnv('FUEL_RESERVE_LAPS', 1),
  strategyMaxIntervalMs: intEnv('STRATEGY_MAX_INTERVAL_MS', 180_000),
};

const RECONNECT_MS = 2000;
const STALE_MS = 2000; // no new frame for this long -> game paused / in menus
const REOPEN_AFTER_STALE_MS = 10_000; // release the mapping so a restarted game gets a fresh one
const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED_BYTES = 1 << 20;

const log = {
  info: (...a) => console.log(new Date().toISOString(), ...a),
  warn: (...a) => console.warn(new Date().toISOString(), ...a),
  error: (...a) => console.error(new Date().toISOString(), ...a),
};

// --- telemetry source -------------------------------------------------------

function createSource() {
  const useMock = config.source === 'mock' || (config.source === 'auto' && process.platform !== 'win32');
  if (useMock) {
    const { MockSource } = require('./src/mockSource');
    return { kind: 'mock', reader: new MockSource({ speedMultiplier: config.mockSpeed }) };
  }
  const { SharedMemoryReader } = require('./src/sharedMemory');
  return { kind: 'rf2', reader: new SharedMemoryReader() };
}

const source = createSource();
const history = new TireHistory();
const tracker = new SessionTracker();
const claude = new ClaudeClient({
  apiKey: config.apiKey,
  model: config.model,
  effort: config.effort,
  useFallbacks: config.fallbacks,
  logger: log,
});
const tireAnalyzer = new TireAnalyzer({
  client: claude,
  optimalMinC: config.tireOptimalMinC,
  optimalMaxC: config.tireOptimalMaxC,
  wearLimitPercent: config.tireWearLimitPercent,
});
const strategyAnalyzer = new StrategyAnalyzer({
  client: claude,
  tracker,
  pitLossSec: config.pitLossSec,
  wearLimitPercent: config.tireWearLimitPercent,
  fuelReserveLaps: config.fuelReserveLaps,
});

const state = {
  connected: false,
  live: false,
  message: 'Starting',
  snapshot: null,
  field: [],
  tireAnalysis: null,
  strategy: null,
  strategyAt: 0,
  strategyLap: 0,
  strategyStops: 0,
  analysisError: null,
  lastVersion: null,
  lastFrameAt: 0,
  lastOpenAttempt: 0,
};

function setStatus(connected, live, message) {
  if (state.connected === connected && state.live === live && state.message === message) return;
  state.connected = connected;
  state.live = live;
  state.message = message;
  log.info(`[telemetry] ${message}`);
  broadcast({ type: 'status', data: statusPayload() });
}

function statusPayload() {
  return {
    source: source.kind,
    connected: state.connected,
    live: state.live,
    message: state.message,
    clients: wss ? wss.clients.size : 0,
    ai: {
      enabled: claude.enabled,
      model: config.model,
      effort: config.effort,
      intervalMs: config.analysisIntervalMs,
      totals: claude.totalsRounded(),
      lastError: state.analysisError,
    },
    tireReference: {
      optimalMinC: config.tireOptimalMinC,
      optimalMaxC: config.tireOptimalMaxC,
      wearLimitPercent: config.tireWearLimitPercent,
    },
  };
}

function pollTelemetry() {
  const now = Date.now();
  const { reader } = source;

  if (!reader.isOpen) {
    if (now - state.lastOpenAttempt < RECONNECT_MS) return;
    state.lastOpenAttempt = now;
    try {
      reader.open();
      state.lastFrameAt = now;
      state.lastVersion = null;
      setStatus(true, false, 'Shared memory opened, waiting for data');
    } catch (err) {
      // Win32 error 2 = the plugin hasn't created the shared memory (game not running or plugin not loaded)
      setStatus(false, false, `Waiting for LMU (is the game running with the rF2 shared memory plugin enabled?) [${err.message}]`);
      return;
    }
  }

  let raw;
  try {
    raw = reader.read();
  } catch (err) {
    log.error('[telemetry] read failed:', err.message);
    reader.close();
    setStatus(false, false, `Read failed: ${err.message}`);
    return;
  }
  if (!raw) return; // plugin mid-write; try again next tick

  if (raw.telemetryVersion !== state.lastVersion) {
    state.lastVersion = raw.telemetryVersion;
    state.lastFrameAt = now;
  }
  const sinceFrame = now - state.lastFrameAt;
  if (sinceFrame > REOPEN_AFTER_STALE_MS && source.kind === 'rf2') {
    reader.close();
    setStatus(false, false, 'No telemetry updates; reconnecting');
    return;
  }

  let snapshot;
  try {
    snapshot = parseSnapshot(raw);
  } catch (err) {
    log.error('[telemetry] parse failed:', err.message);
    return;
  }
  if (!snapshot) {
    setStatus(true, false, 'Connected, no player car on track');
    return;
  }

  const live = sinceFrame < STALE_MS;
  setStatus(true, live, live ? 'Live' : 'Connected, telemetry paused');

  // The full field is only needed for strategy; keep it out of the 10 Hz broadcast
  const { field, ...rest } = snapshot;
  state.field = field;
  state.snapshot = { ...rest, timestamp: now, live, source: source.kind };
  broadcast({ type: 'telemetry', data: state.snapshot });
}

function sampleHistory() {
  if (!state.live || !state.snapshot) return;
  history.record(state.snapshot);
  tracker.record({ ...state.snapshot, field: state.field });

  // Strategy is re-evaluated when something strategic changes: a lap completes
  // or a pit stop happens, with a periodic refresh for very long laps.
  const lastLap = tracker.laps.length ? tracker.laps[tracker.laps.length - 1].lap : 0;
  const newLap = lastLap !== state.strategyLap;
  const newStop = tracker.pitStops.length !== state.strategyStops;
  const stale = Date.now() - state.strategyAt > config.strategyMaxIntervalMs;
  if (newLap || newStop || stale) runStrategy();
}

async function runTireAnalysis({ force = false } = {}) {
  if (!tireAnalyzer.enabled || !state.snapshot) return;
  if (!force && (!state.live || wss.clients.size === 0)) return;

  try {
    const analysis = await tireAnalyzer.analyze(state.snapshot, history.summary());
    if (!analysis) return; // previous request still running
    state.tireAnalysis = analysis;
    state.analysisError = null;
    broadcast({ type: 'tire_analysis', data: analysis });
  } catch (err) {
    const message = describeClaudeError(err);
    state.analysisError = message;
    log.warn('[claude] tire analysis:', message);
    broadcast({ type: 'analysis_error', data: { source: 'tire', message, at: new Date().toISOString() } });
  }
}

async function runStrategy({ force = false } = {}) {
  if (!strategyAnalyzer.enabled || !state.snapshot) return;
  // Automatic calls wait for one clean lap: before that there is no fuel or wear rate
  if (!force && (!state.live || wss.clients.size === 0 || tracker.cleanLaps().length === 0)) return;
  if (strategyAnalyzer.inFlight) return;

  state.strategyAt = Date.now();
  state.strategyLap = tracker.laps.length ? tracker.laps[tracker.laps.length - 1].lap : 0;
  state.strategyStops = tracker.pitStops.length;
  try {
    const result = await strategyAnalyzer.analyze({ ...state.snapshot, field: state.field }, state.tireAnalysis);
    if (!result) return;
    state.strategy = result;
    broadcast({ type: 'strategy', data: result });
  } catch (err) {
    const message = describeClaudeError(err);
    log.warn('[claude] strategy:', message);
    broadcast({ type: 'analysis_error', data: { source: 'strategy', message, at: new Date().toISOString() } });
  }
}

// --- HTTP + WebSocket -------------------------------------------------------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => res.json(statusPayload()));
app.get('/api/snapshot', (_req, res) => res.json(state.snapshot));
app.get('/api/tire-analysis', (_req, res) => res.json(state.tireAnalysis));
app.get('/api/strategy', (_req, res) => res.json(state.strategy));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/telemetry' });

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  // Drop frames for a client that can't keep up instead of queueing forever
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES && message.type === 'telemetry') return;
  ws.send(JSON.stringify(message));
}

function broadcast(message) {
  if (!wss) return;
  const data = JSON.stringify(message);
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES && message.type === 'telemetry') continue;
    ws.send(data);
  }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  log.info(`[ws] client connected from ${req.socket.remoteAddress} (${wss.clients.size} total)`);

  send(ws, { type: 'hello', data: statusPayload() });
  if (state.snapshot) send(ws, { type: 'telemetry', data: state.snapshot });
  if (state.tireAnalysis) send(ws, { type: 'tire_analysis', data: state.tireAnalysis });
  if (state.strategy) send(ws, { type: 'strategy', data: state.strategy });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'ping') send(ws, { type: 'pong', data: { at: Date.now() } });
    if (msg.type === 'requestAnalysis') runTireAnalysis({ force: true });
    if (msg.type === 'requestStrategy') runStrategy({ force: true });
  });

  ws.on('close', () => log.info(`[ws] client disconnected (${wss.clients.size} total)`));
  ws.on('error', (err) => log.warn('[ws] client error:', err.message));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

// --- start ------------------------------------------------------------------

const timers = [];

server.listen(config.port, config.host, () => {
  log.info(`LMU telemetry server on http://${config.host}:${config.port}`);
  log.info(`WebSocket: ws://${config.host}:${config.port}/telemetry`);
  log.info(`Telemetry source: ${source.kind}${source.kind === 'mock' ? ` (x${config.mockSpeed} speed)` : ''}`);
  if (claude.enabled) {
    log.info(
      `Claude tire analysis: ${config.model} (effort ${config.effort}) every ${config.analysisIntervalMs / 1000}s while a dashboard is connected`,
    );
    log.info('Claude strategy: after every completed lap and pit stop');
  } else {
    log.warn('Claude analysis disabled: set CLAUDE_API_KEY in .env to enable it');
  }

  timers.push(setInterval(pollTelemetry, Math.round(1000 / config.broadcastHz)));
  timers.push(setInterval(sampleHistory, config.tireSampleMs));
  if (claude.enabled) timers.push(setInterval(runTireAnalysis, config.analysisIntervalMs));
  pollTelemetry();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Port ${config.port} is already in use. Set PORT in .env or stop the other process.`);
  } else {
    log.error('Server error:', err);
  }
  process.exit(1);
});

function shutdown() {
  log.info('Shutting down');
  timers.forEach(clearInterval);
  clearInterval(heartbeat);
  source.reader.close();
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) ? n : fallback;
}

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
