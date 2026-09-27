'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const L = require('../src/rf2Layout');
const { parseSnapshot, parseWheel } = require('../src/telemetryParser');
const { MockSource } = require('../src/mockSource');
const { TireHistory } = require('../src/tireHistory');
const { buildPromptPayload } = require('../src/claudeAnalyzer');

const { koffi } = L;

test('struct sizes match rF2State.h (pack 4)', () => {
  assert.equal(koffi.sizeof(L.rF2Wheel), 260);
  assert.equal(koffi.sizeof(L.rF2VehicleTelemetry), 1888);
  assert.equal(koffi.sizeof(L.rF2ScoringInfo), 548);
  assert.equal(koffi.sizeof(L.rF2VehicleScoring), 584);
  assert.equal(koffi.offsetof(L.rF2VehicleTelemetry, 'mWheels'), 848);
  assert.equal(koffi.offsetof(L.rF2VehicleTelemetry, 'mFuel'), 524);
  assert.equal(koffi.offsetof(L.rF2VehicleScoring, 'mIsPlayer'), 196);
  assert.equal(L.TELEMETRY_VEHICLES_OFFSET, 16);
  assert.equal(L.SCORING_VEHICLES_OFFSET, 560);
});

test('wheel temps map left/right to inner/outer per side, Kelvin to Celsius', () => {
  const wheel = {
    mTemperature: [373.15, 363.15, 353.15], // left 100C, center 90C, right 80C
    mWear: 0.9,
    mPressure: 180,
    mTireCarcassTemperature: 358.15,
    mBrakeTemp: 773.15,
  };
  const fl = parseWheel(wheel, 'FL');
  assert.deepEqual(fl.temps, { innerC: 80, middleC: 90, outerC: 100 });
  const fr = parseWheel(wheel, 'FR');
  assert.deepEqual(fr.temps, { innerC: 100, middleC: 90, outerC: 80 });
  assert.equal(fl.wearPercent, 10);
  assert.equal(fl.remainingPercent, 90);
  assert.equal(fl.carcassTempC, 85);
  assert.equal(fl.brakeTempC, 500);
});

test('parser picks the player car by scoring mIsPlayer/mID', () => {
  const stride = koffi.sizeof(L.rF2VehicleTelemetry);
  const telemetry = Buffer.alloc(L.TELEMETRY_VEHICLES_OFFSET + 2 * stride);
  koffi.encode(telemetry, 0, L.rF2TelemetryHeader, { mNumVehicles: 2 });
  koffi.encode(telemetry, L.TELEMETRY_VEHICLES_OFFSET, L.rF2VehicleTelemetry, { mID: 1, mVehicleName: 'AI car' });
  koffi.encode(telemetry, L.TELEMETRY_VEHICLES_OFFSET + stride, L.rF2VehicleTelemetry, {
    mID: 2,
    mVehicleName: 'My car',
    mFuel: 42,
  });

  const sStride = koffi.sizeof(L.rF2VehicleScoring);
  const scoring = Buffer.alloc(L.SCORING_VEHICLES_OFFSET + 2 * sStride);
  koffi.encode(scoring, 0, L.rF2ScoringHeader, { mScoringInfo: { mNumVehicles: 2, mSession: 5 } });
  koffi.encode(scoring, L.SCORING_VEHICLES_OFFSET, L.rF2VehicleScoring, { mID: 1 });
  koffi.encode(scoring, L.SCORING_VEHICLES_OFFSET + sStride, L.rF2VehicleScoring, {
    mID: 2,
    mIsPlayer: true,
    mPlace: 4,
  });

  const snap = parseSnapshot({ telemetry, scoring });
  assert.equal(snap.vehicle.name, 'My car');
  assert.equal(snap.vehicle.fuelL, 42);
  assert.equal(snap.vehicle.position, 4);
  assert.equal(snap.session.type, 'qualifying');
});

test('mock source produces plausible snapshots through the real parser', () => {
  const snap = parseSnapshot(new MockSource().read());
  assert.equal(snap.session.phase, 'green');
  for (const key of ['FL', 'FR', 'RL', 'RR']) {
    const t = snap.tires[key];
    assert.ok(t.pressureKpa > 100 && t.pressureKpa < 300, `${key} pressure ${t.pressureKpa}`);
    assert.ok(t.surfaceTempC > 0 && t.surfaceTempC < 150, `${key} temp ${t.surfaceTempC}`);
    assert.ok(t.wearPercent >= 0 && t.wearPercent < 5, `${key} wear ${t.wearPercent}`);
  }
});

test('tire history computes per-lap wear and resets on a tire change', () => {
  const h = new TireHistory();
  const snap = (lap, wear) => ({
    vehicle: { lap, lastLapSec: 100, fuelL: 50 - lap * 3 },
    tires: Object.fromEntries(
      ['FL', 'FR', 'RL', 'RR'].map((k) => [k, { wearPercent: wear, surfaceTempC: 85, pressureKpa: 180 }]),
    ),
  });
  h.record(snap(1, 0));
  h.record(snap(2, 1.2));
  h.record(snap(3, 2.2));
  assert.equal(h.laps.length, 2);
  assert.equal(h.wearPerLap(3).FL, 1.1);
  assert.equal(h.laps[0].fuelUsedL, 3);

  h.record(snap(4, 0.1)); // new tires
  assert.equal(h.laps.length, 0);
  assert.equal(h.stintStartLap, 4);
});

test('prompt payload carries tires and history but not 10 Hz noise', () => {
  const snap = parseSnapshot(new MockSource().read());
  const payload = buildPromptPayload({ snapshot: snap, history: { lapsThisStint: 0 } });
  assert.deepEqual(Object.keys(payload.tires), ['FL', 'FR', 'RL', 'RR']);
  assert.ok(!('rpm' in payload.car));
  assert.equal(payload.history.lapsThisStint, 0);
});

test('server streams telemetry over ws://.../telemetry at ~10 Hz', async (t) => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock'], {
    env: { ...process.env, PORT: String(port), CLAUDE_API_KEY: '', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => proc.kill());

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 5000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('WebSocket:')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.source, 'mock');
  assert.equal(health.ai.enabled, false);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/telemetry`);
  const types = [];
  const telemetry = [];
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    types.push(msg.type);
    if (msg.type === 'telemetry') telemetry.push(msg.data);
  });
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 1500));
  ws.close();

  assert.equal(types[0], 'hello');
  assert.ok(telemetry.length >= 10 && telemetry.length <= 18, `got ${telemetry.length} frames in 1.5 s`);
  const last = telemetry[telemetry.length - 1];
  assert.equal(last.live, true);
  assert.ok(last.tires.FL.pressureKpa > 0);
});
