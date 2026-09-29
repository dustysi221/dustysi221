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

test('shared memory names match the plugin', () => {
  assert.equal(L.TELEMETRY_MAP_NAME, '$rFactor2SMMP_Telemetry$');
  assert.equal(L.SCORING_MAP_NAME, '$rFactor2SMMP_Scoring$');
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

test('damage: dents, detached parts, flats and the last impact are parsed', () => {
  const stride = koffi.sizeof(L.rF2VehicleTelemetry);
  const telemetry = Buffer.alloc(L.TELEMETRY_VEHICLES_OFFSET + stride);
  koffi.encode(telemetry, 0, L.rF2TelemetryHeader, { mNumVehicles: 1 });
  const wheels = [{ mFlat: true }, {}, {}, { mDetached: true }].map((w) => ({ mWear: 1, mTemperature: [300, 300, 300], ...w }));
  koffi.encode(telemetry, L.TELEMETRY_VEHICLES_OFFSET, L.rF2VehicleTelemetry, {
    mID: 1,
    mElapsedTime: 500,
    mLastImpactET: 497.5,
    mLastImpactMagnitude: 5400,
    mDentSeverity: [2, 1, 0, 0, 0, 0, 0, 2],
    mDetached: true,
    mWheels: wheels,
  });
  const scoring = Buffer.alloc(L.SCORING_VEHICLES_OFFSET + koffi.sizeof(L.rF2VehicleScoring));
  koffi.encode(scoring, 0, L.rF2ScoringHeader, { mScoringInfo: { mNumVehicles: 1 } });
  koffi.encode(scoring, L.SCORING_VEHICLES_OFFSET, L.rF2VehicleScoring, { mID: 1, mIsPlayer: true, mInGarageStall: true });

  const snap = parseSnapshot({ telemetry, scoring });
  assert.deepEqual(snap.damage, {
    maxDentSeverity: 2,
    dentedZones: { front: 2, frontRight: 1, frontLeft: 2 },
    partsDetached: true,
    engineOverheating: false,
    flatTires: ['FL'],
    detachedWheels: ['RR'],
    lastImpactSecAgo: 2.5,
    lastImpactMagnitude: 5400,
  });
  assert.equal(snap.vehicle.inGarage, true);

  const clean = parseSnapshot(new MockSource().read()).damage;
  assert.equal(clean.maxDentSeverity, 0);
  assert.equal(clean.lastImpactSecAgo, null);
});

test('rules buffer layout matches rF2State.h (safety car fields)', () => {
  assert.equal(L.RULES_MAP_NAME, '$rFactor2SMMP_Rules$');
  const at = (f) => koffi.offsetof(L.rF2RulesHeader, 'mTrackRules') + koffi.offsetof(L.rF2TrackRulesPrefix, f);
  assert.equal(at('mCurrentET'), 12);
  assert.equal(at('mSafetyCarActive'), 47);
  assert.equal(at('mSafetyCarLapDist'), 56);
  assert.equal(at('mYellowFlagState'), 332);
  assert.equal(at('mYellowFlagLaps'), 334);
  assert.equal(at('mSafetyCarSpeed'), 340);
});

/** Parsed snapshot from the simulator at `seconds` of race time. */
function snapshotAt(seconds) {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base;
  try {
    const mock = new MockSource();
    mock.startedAt = base - seconds * 1000;
    return parseSnapshot(mock.read());
  } finally {
    Date.now = realNow;
  }
}

test('flags: green, local yellow with a stopped car, FCY and safety car', () => {
  const green = snapshotAt(100).flags;
  assert.equal(green.state, 'green');
  assert.deepEqual(green.slowCars, []);

  const local = snapshotAt(350).flags;
  assert.equal(local.state, 'localYellow');
  assert.deepEqual(local.sectorYellow, [false, true, false]); // rF2 order [S3, S1, S2] converted
  assert.deepEqual(local.slowCars, [77]);

  const fcy = snapshotAt(960);
  assert.equal(fcy.flags.state, 'fcy');
  assert.equal(fcy.flags.yellowState, 'pitsOpen');
  assert.equal(fcy.flags.safetyCar, null);
  assert.equal(fcy.session.phase, 'fullCourseYellow');

  const sc = snapshotAt(1600).flags;
  assert.equal(sc.state, 'safetyCar');
  assert.ok(sc.safetyCar.lapDistM >= 0 && sc.safetyCar.lapDistM < 5400);
  assert.equal(sc.safetyCar.speedKph, 120);
});

test('flags without the Rules buffer: full course yellow, safety car unknown', () => {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base;
  try {
    const mock = new MockSource();
    mock.startedAt = base - 1600 * 1000;
    const { rules, ...raw } = mock.read();
    const flags = parseSnapshot(raw).flags;
    assert.equal(flags.state, 'fullCourse');
    assert.equal(flags.rulesAvailable, false);
    assert.equal(flags.safetyCar, null);
  } finally {
    Date.now = realNow;
  }
});

test('flags ignore a stale Rules buffer (online, rules run on the server)', () => {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base;
  try {
    const mock = new MockSource();
    mock.startedAt = base - 1600 * 1000;
    const raw = mock.read();
    const r = koffi.decode(raw.rules, L.rF2RulesHeader);
    r.mTrackRules.mCurrentET = 12; // frozen since the start
    koffi.encode(raw.rules, 0, L.rF2RulesHeader, r);
    const flags = parseSnapshot(raw).flags;
    assert.equal(flags.state, 'fullCourse');
    assert.equal(flags.rulesAvailable, false);
  } finally {
    Date.now = realNow;
  }
});

/** Raw simulator buffers at `seconds` of race time. */
function rawAt(seconds) {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base;
  try {
    const mock = new MockSource();
    mock.startedAt = base - seconds * 1000;
    return mock.read();
  } finally {
    Date.now = realNow;
  }
}

test('lap distance: right after the line it restarts from 0, not the stale scoring distance', () => {
  // Scoring lags telemetry: at 100.05 s telemetry is on lap 2, scoring still at the end of lap 1
  const raw = rawAt(100.05);
  const scoringPlayer = (() => {
    const n = koffi.decode(raw.scoring, L.rF2ScoringHeader).mScoringInfo.mNumVehicles;
    for (let i = 0; i < n; i++) {
      const v = koffi.decode(raw.scoring, L.SCORING_VEHICLES_OFFSET + i * koffi.sizeof(L.rF2VehicleScoring), L.rF2VehicleScoring);
      if (v.mIsPlayer) return v;
    }
    return null;
  })();
  assert.ok(scoringPlayer.mLapDist > 5300, 'scoring still has the old lap');
  const v = parseSnapshot(raw).vehicle;
  assert.equal(v.lap, 2);
  assert.ok(v.lapDistanceM < 50, `lap distance ${v.lapDistanceM}`);

  // Mid-lap, the distance is brought forward from the last scoring update
  const mid = parseSnapshot(rawAt(50.05)).vehicle.lapDistanceM;
  assert.ok(Math.abs(mid - 50.05 * 54) < 30, `mid-lap distance ${mid}`);
});

test('flags: only sector flag value 1 is a yellow, and cars in the garage are not slow cars', () => {
  const raw = rawAt(350); // local yellow, #77 stopped on track
  const header = koffi.decode(raw.scoring, L.rF2ScoringHeader);
  header.mScoringInfo.mSectorFlag = [11, 11, 11]; // what LMU can leave there under green
  koffi.encode(raw.scoring, 0, L.rF2ScoringHeader, header);
  const n = header.mScoringInfo.mNumVehicles;
  for (let i = 0; i < n; i++) {
    const off = L.SCORING_VEHICLES_OFFSET + i * koffi.sizeof(L.rF2VehicleScoring);
    const v = koffi.decode(raw.scoring, off, L.rF2VehicleScoring);
    if (v.mID === 77) koffi.encode(raw.scoring, off, L.rF2VehicleScoring, { ...v, mInGarageStall: true });
  }
  const flags = parseSnapshot(raw).flags;
  assert.equal(flags.state, 'green');
  assert.deepEqual(flags.sectorYellow, [false, false, false]);
  assert.deepEqual(flags.rawSectorFlags, [11, 11, 11]);
  assert.deepEqual(flags.slowCars, []);
});
