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
 *  - serves a Control Panel (/control) to switch the AI, each engineer and the
 *    telemetry source on and off while running
 */

const http = require('http');
const path = require('path');

// Settings file: .env next to server.js (ENV_FILE overrides it, e.g. for tests)
const ENV_PATH = process.env.ENV_FILE || path.join(__dirname, '.env');
require('dotenv').config({ path: ENV_PATH, quiet: true });
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const { parseSnapshot } = require('./src/telemetryParser');
const { TireHistory } = require('./src/tireHistory');
const { ClaudeClient, describeClaudeError } = require('./src/claudeClient');
const { TireAnalyzer } = require('./src/tire-analyzer');
const { SessionTracker } = require('./src/sessionTracker');
const { StrategyAnalyzer } = require('./src/strategy-analyzer');
const { VoiceAssistant, BusyError } = require('./src/voice-assistant');
const { updateEnvFile } = require('./src/envFile');

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const EFFORTS = ['low', 'medium', 'high'];

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
  voiceEffort: process.env.VOICE_EFFORT || 'low',
  // On/off switches (Control Panel); all on by default
  aiEnabled: boolEnv('AI_ENABLED', true),
  tireEngineer: boolEnv('TIRE_ENGINEER', true),
  strategist: boolEnv('STRATEGIST', true),
  voiceEngineer: boolEnv('VOICE_ENGINEER', true),
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
  // Throws on non-Windows when the game source is requested
  const useMock = config.source === 'mock' || (config.source === 'auto' && process.platform !== 'win32');
  if (useMock) {
    const { MockSource } = require('./src/mockSource');
    return { kind: 'mock', reader: new MockSource({ speedMultiplier: config.mockSpeed }) };
  }
  const { SharedMemoryReader } = require('./src/sharedMemory');
  return { kind: 'rf2', reader: new SharedMemoryReader() };
}

let source = createSource();
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
const voice = new VoiceAssistant({
  client: claude,
  effort: config.voiceEffort,
  getContext: () => ({
    snapshot: state.snapshot,
    field: state.field,
    tireHistory: history,
    tracker,
    tireAnalysis: state.tireAnalysis,
    strategy: state.strategy,
    tireOptions: {
      optimalMinC: config.tireOptimalMinC,
      optimalMaxC: config.tireOptimalMaxC,
      wearLimitPercent: config.tireWearLimitPercent,
    },
    strategyOptions: {
      pitLossSec: config.pitLossSec,
      wearLimitPercent: config.tireWearLimitPercent,
      fuelReserveLaps: config.fuelReserveLaps,
    },
  }),
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

/** AI is usable: a key is set and the master switch is on. */
function aiActive() {
  return claude.enabled && config.aiEnabled;
}

function statusPayload() {
  return {
    source: source.kind,
    connected: state.connected,
    live: state.live,
    message: state.message,
    clients: wss ? wss.clients.size : 0,
    ai: {
      enabled: aiActive(),
      hasKey: claude.enabled,
      master: config.aiEnabled,
      tireEngineer: config.tireEngineer,
      strategist: config.strategist,
      voiceEngineer: config.voiceEngineer,
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
  if (!aiActive() || !config.tireEngineer || !state.snapshot) return;
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
  if (!aiActive() || !config.strategist || !state.snapshot) return;
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

// Push-to-talk question from a dashboard: answer only that dashboard.
async function handleVoiceQuery(ws, { id, text }) {
  if (claude.enabled && (!config.aiEnabled || !config.voiceEngineer)) {
    const message = 'The voice engineer is turned off in the Control Panel';
    send(ws, { type: 'voice_error', data: { id, message, busy: false } });
    return;
  }
  try {
    const answer = await voice.ask(text);
    log.info(`[voice] "${answer.question}" -> "${answer.reply}" (${answer.latencyMs} ms)`);
    send(ws, { type: 'voice_reply', data: { id, ...answer } });
  } catch (err) {
    const message = err instanceof BusyError ? err.message : describeClaudeError(err);
    log.warn('[voice]', message);
    send(ws, { type: 'voice_error', data: { id, message, busy: err instanceof BusyError } });
  }
}

// --- HTTP + WebSocket -------------------------------------------------------

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/control', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));

app.get('/api/health', (_req, res) => res.json(statusPayload()));
app.get('/api/snapshot', (_req, res) => res.json(state.snapshot));
app.get('/api/tire-analysis', (_req, res) => res.json(state.tireAnalysis));
app.get('/api/strategy', (_req, res) => res.json(state.strategy));

// --- Control Panel API ------------------------------------------------------
// Reading is open to any dashboard; changing settings only from this PC.

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  // Block other websites in your browser from posting to the panel
  const origin = req.headers.origin;
  const sameOrigin = !origin || origin === `http://${req.headers.host}`;
  return local && sameOrigin;
}

function requireLocal(req, res, next) {
  if (!isLocalRequest(req)) {
    res.status(403).json({ error: 'Settings can only be changed from the PC running the server' });
    return;
  }
  next();
}

function controlState() {
  return {
    ai: {
      hasKey: claude.enabled,
      keyHint: config.apiKey ? `${config.apiKey.slice(0, 10)}…${config.apiKey.slice(-4)}` : null,
      master: config.aiEnabled,
      active: aiActive(),
      model: config.model,
      effort: config.effort,
      tireIntervalSec: Math.round(config.analysisIntervalMs / 1000),
      totals: claude.totalsRounded(),
      lastError: state.analysisError,
    },
    engineers: {
      tireEngineer: config.tireEngineer,
      strategist: config.strategist,
      voiceEngineer: config.voiceEngineer,
    },
    telemetry: {
      source: source.kind === 'mock' ? 'simulator' : 'game',
      mockSpeed: config.mockSpeed,
      connected: state.connected,
      live: state.live,
      message: state.message,
      gameAvailable: process.platform === 'win32',
    },
    dashboards: wss ? wss.clients.size : 0,
    options: { models: MODELS, efforts: EFFORTS, tireIntervalsSec: [5, 10, 15, 30, 60], mockSpeeds: [1, 5, 10, 20] },
  };
}

function saveEnv(updates) {
  try {
    updateEnvFile(ENV_PATH, updates);
  } catch (err) {
    log.warn('[control] could not save .env:', err.message);
  }
}

/** Switch between the game and the simulator without restarting. */
function switchSource(kind, mockSpeed) {
  const previous = source;
  const previousConfig = { source: config.source, mockSpeed: config.mockSpeed };
  config.source = kind === 'simulator' ? 'mock' : 'rf2';
  if (mockSpeed) config.mockSpeed = mockSpeed;
  try {
    source = createSource();
  } catch (err) {
    Object.assign(config, previousConfig);
    throw new Error(`Can't switch to the game here: ${err.message}`);
  }
  previous.reader.close();
  Object.assign(state, {
    snapshot: null,
    field: [],
    tireAnalysis: null,
    strategy: null,
    strategyAt: 0,
    strategyLap: 0,
    strategyStops: 0,
    lastVersion: null,
    lastOpenAttempt: 0,
  });
  history.reset();
  tracker.reset();
  voice.resetHistory();
  log.info(`[control] telemetry source: ${source.kind}${source.kind === 'mock' ? ` (x${config.mockSpeed})` : ''}`);
  setStatus(false, false, source.kind === 'mock' ? 'Starting simulator' : 'Waiting for LMU');
  pollTelemetry();
}

app.get('/api/control', (_req, res) => res.json(controlState()));

app.post('/api/control', requireLocal, express.json(), (req, res) => {
  const body = req.body || {};
  const envUpdates = {};
  const changes = [];
  const bool = (v) => v === true || v === false;

  for (const [key, envKey] of [
    ['aiEnabled', 'AI_ENABLED'],
    ['tireEngineer', 'TIRE_ENGINEER'],
    ['strategist', 'STRATEGIST'],
    ['voiceEngineer', 'VOICE_ENGINEER'],
  ]) {
    if (bool(body[key]) && body[key] !== config[key]) {
      config[key] = body[key];
      envUpdates[envKey] = String(body[key]);
      changes.push(`${key}=${body[key]}`);
    }
  }
  if (MODELS.includes(body.model) && body.model !== config.model) {
    config.model = claude.model = body.model;
    envUpdates.ANALYSIS_MODEL = body.model;
    changes.push(`model=${body.model}`);
  }
  if (EFFORTS.includes(body.effort) && body.effort !== config.effort) {
    config.effort = claude.effort = body.effort;
    envUpdates.ANALYSIS_EFFORT = body.effort;
    changes.push(`effort=${body.effort}`);
  }
  const interval = Number(body.tireIntervalSec);
  if (Number.isFinite(interval) && interval >= 3 && interval <= 300 && interval * 1000 !== config.analysisIntervalMs) {
    config.analysisIntervalMs = Math.round(interval * 1000);
    envUpdates.ANALYSIS_INTERVAL_MS = String(config.analysisIntervalMs);
    restartTireTimer();
    changes.push(`tireInterval=${interval}s`);
  }

  // Source and simulator speed apply now but aren't saved: the next start
  // follows how you launch it (Start Dashboard vs Start Simulator).
  const speed = Number(body.mockSpeed);
  const wantSource = body.source === 'game' || body.source === 'simulator' ? body.source : null;
  const currentSource = source.kind === 'mock' ? 'simulator' : 'game';
  const speedChanged = Number.isFinite(speed) && speed >= 1 && speed <= 50 && speed !== config.mockSpeed;
  try {
    if ((wantSource && wantSource !== currentSource) || (speedChanged && (wantSource || currentSource) === 'simulator')) {
      switchSource(wantSource || currentSource, speedChanged ? speed : null);
      changes.push(`source=${wantSource || currentSource}`);
    } else if (speedChanged) {
      config.mockSpeed = speed;
    }
  } catch (err) {
    res.status(400).json({ error: err.message, state: controlState() });
    return;
  }

  if (Object.keys(envUpdates).length) saveEnv(envUpdates);
  if (changes.length) {
    log.info(`[control] ${changes.join(', ')}`);
    broadcast({ type: 'status', data: statusPayload() });
  }
  res.json(controlState());
});

app.post('/api/control/api-key', requireLocal, express.json(), (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (key && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
    res.status(400).json({ error: 'That doesn’t look like a Claude API key (it starts with sk-ant-)' });
    return;
  }
  config.apiKey = key;
  claude.setApiKey(key || null);
  saveEnv({ CLAUDE_API_KEY: key || null });
  log.info(`[control] API key ${key ? 'updated' : 'removed'}`);
  broadcast({ type: 'status', data: statusPayload() });
  res.json(controlState());
});

app.post('/api/control/shutdown', requireLocal, (_req, res) => {
  res.json({ ok: true });
  log.info('[control] stop requested from the Control Panel');
  setTimeout(shutdown, 200);
});

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
    if (msg.type === 'voice_query') handleVoiceQuery(ws, msg.data || {});
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
let tireTimer = null;

function restartTireTimer() {
  clearInterval(tireTimer);
  tireTimer = setInterval(runTireAnalysis, config.analysisIntervalMs);
}

server.listen(config.port, config.host, () => {
  log.info(`LMU telemetry server on http://${config.host}:${config.port}`);
  log.info(`WebSocket: ws://${config.host}:${config.port}/telemetry`);
  log.info(`Telemetry source: ${source.kind}${source.kind === 'mock' ? ` (x${config.mockSpeed} speed)` : ''}`);
  if (claude.enabled) {
    log.info(
      `Claude tire analysis: ${config.model} (effort ${config.effort}) every ${config.analysisIntervalMs / 1000}s while a dashboard is connected`,
    );
    log.info('Claude strategy: after every completed lap and pit stop');
    const off = [
      !config.aiEnabled && 'all AI',
      !config.tireEngineer && 'tire engineer',
      !config.strategist && 'strategist',
      !config.voiceEngineer && 'voice engineer',
    ].filter(Boolean);
    if (off.length) log.info(`Turned off in the Control Panel: ${off.join(', ')}`);
  } else {
    log.warn('Claude analysis disabled: set CLAUDE_API_KEY in .env (or in the Control Panel) to enable it');
  }
  log.info(`Control Panel: http://localhost:${config.port}/control`);

  timers.push(setInterval(pollTelemetry, Math.round(1000 / config.broadcastHz)));
  timers.push(setInterval(sampleHistory, config.tireSampleMs));
  restartTireTimer();
  pollTelemetry();

  // --open or --open=/control: open the page in the default browser once listening
  const openArg = process.argv.find((a) => a === '--open' || a.startsWith('--open='));
  if (openArg) openBrowser(`http://localhost:${config.port}${openArg.split('=')[1] || '/'}`);
});

function openBrowser(url) {
  const { spawn } = require('child_process');
  // explorer.exe opens a URL in the default browser without cmd quoting issues
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    /* no browser available */
  }
}

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
  clearInterval(tireTimer);
  clearInterval(heartbeat);
  source.reader.close();
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function boolEnv(name, fallback) {
  const v = (process.env[name] || '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) ? n : fallback;
}

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
