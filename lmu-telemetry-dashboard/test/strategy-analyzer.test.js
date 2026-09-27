'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MockSource } = require('../src/mockSource');
const { parseSnapshot } = require('../src/telemetryParser');
const { SessionTracker } = require('../src/sessionTracker');
const {
  StrategyAnalyzer,
  computeStrategyMetrics,
  lapEndsReachable,
  slope,
  normalize,
  SCHEMA,
} = require('../src/strategy-analyzer');

/** Drive the simulator through `seconds` of race time at 1 Hz. */
function simulate(seconds) {
  const realNow = Date.now;
  const base = realNow();
  let t = 0;
  Date.now = () => base + t * 1000;
  try {
    const mock = new MockSource();
    const tracker = new SessionTracker();
    let snap;
    for (t = 0; t <= seconds; t++) {
      snap = parseSnapshot(mock.read());
      tracker.record(snap);
    }
    return { snap, tracker };
  } finally {
    Date.now = realNow;
  }
}

test('lapEndsReachable counts the pit chances within fuel range', () => {
  assert.equal(lapEndsReachable(3, 0.5, 0.25), 3); // 0.5 to the line, then 2 more full laps (2.75 usable)
  assert.equal(lapEndsReachable(0.6, 0.5, 0.25), 0); // can't safely reach the line
  assert.equal(lapEndsReachable(1.0, 0.2, 0.25), 0); // 0.8 to the line but only 0.75 usable
  assert.equal(lapEndsReachable(1.1, 0.2, 0.25), 1);
  assert.equal(lapEndsReachable(null, 0.2, 0.25), null);
});

test('slope measures lap-time degradation', () => {
  assert.equal(slope([100, 100.1, 100.2, 100.3]).toFixed(2), '0.10');
  assert.equal(slope([100, 101]), null);
});

test('tracker records clean laps, fuel use, a pit stop and a new stint', () => {
  const { tracker } = simulate(3300); // past the lap-30 stop
  assert.equal(tracker.pitStops.length, 1);
  assert.equal(tracker.pitStops[0].tiresChanged, true);
  assert.ok(tracker.pitStops[0].fuelAddedL > 80);
  assert.equal(tracker.stints.length, 2);

  const clean = tracker.cleanLaps();
  assert.ok(clean.length >= 28);
  assert.ok(clean.every((l) => Math.abs(l.fuelUsedL - 2.9) < 0.05), 'fuel per lap ~2.9 L');
  const pitLap = tracker.laps.find((l) => l.pitted);
  assert.ok(pitLap && !pitLap.clean, 'pit lap is excluded from averages');
});

test('strategy metrics before the stop: fuel forces one stop, tires reach the finish', () => {
  const { snap, tracker } = simulate(1500);
  const m = computeStrategyMetrics(snap, tracker, { pitLossSec: 35 });

  assert.equal(m.race.lapsRemainingBasis, 'timed_estimate');
  assert.ok(m.race.lapsRemaining > 30 && m.race.lapsRemaining < 45, `laps remaining ${m.race.lapsRemaining}`);
  assert.equal(m.fuel.perLapL, 2.9);
  assert.equal(m.fuel.stopsNeededForFuel, 1);
  assert.equal(m.fuel.lastLapToPitForFuel, 30); // 90 L / 2.9 L = 31 laps, keep a margin
  assert.equal(m.tires.limitingTire, 'FL');
  assert.equal(m.tires.lastToFinish, true);
  assert.equal(m.tires.stopsNeededForTires, 0);
  assert.ok(m.pace.stintDegradationSecPerLap > 0);
});

test('strategy metrics: competitors ahead/behind in class with gaps and pace', () => {
  const { snap, tracker } = simulate(1500);
  const c = computeStrategyMetrics(snap, tracker).competitors;
  assert.equal(c.playerClass, 'Hypercar');
  assert.equal(c.carsInClass, 4);
  assert.ok(c.ahead.gapSec > 0, 'car ahead has a positive gap');
  assert.ok(c.behind.gapSec < 0, 'car behind has a negative gap');
  assert.ok(c.ahead.paceDeltaSecPerLap < 0, 'car ahead is faster in the sim');
  assert.ok(!c.classLeader || c.classLeader.car !== c.ahead.car);
});

test('after the stop: no more fuel stop needed, wear rate falls back to the previous set', () => {
  const { snap, tracker } = simulate(3120);
  const m = computeStrategyMetrics(snap, tracker);
  assert.equal(m.stint.number, 2);
  assert.equal(m.fuel.stopsNeededForFuel, 0);
  assert.equal(m.tires.basis, 'previous_stint');
  assert.equal(m.tires.lastToFinish, true);
});

test('normalize keeps the documented contract', () => {
  const out = normalize({ confidence: 'very', pit_lap: 12.5, pit_window_laps: { earliest: 1 } });
  assert.equal(out.confidence, 'low');
  assert.equal(out.pit_lap, null);
  assert.equal(out.pit_window_laps, null);
  assert.equal(out.competitor_analysis, 'No competitor data');
  for (const key of ['pit_recommendation', 'fuel_status', 'tire_trend', 'strategy', 'confidence']) {
    assert.ok(SCHEMA.required.includes(key), key);
    assert.equal(typeof out[key], 'string');
  }
});

test('analyze sends the brief with tire engineer context and returns the call', async () => {
  const { snap, tracker } = simulate(1500);
  let sent;
  const client = {
    enabled: true,
    async requestJson(req) {
      sent = req;
      return {
        data: {
          call: 'Stay out, box end of lap 30',
          pit_recommendation: 'Pit in 15 laps for fuel only',
          fuel_status: '2.9 L/lap, 47 L = 16 laps; need 117 L to finish',
          tire_trend: 'FL at 1.2 %/lap, reaches the flag',
          strategy: 'One stop, fuel only, lap 30',
          competitor_analysis: '#6 ahead by 1.5 s, 0.8 s/lap quicker',
          confidence: 'high',
          pit_lap: 30,
          pit_window_laps: { earliest: 28, latest: 30 },
          stops_remaining: 1,
          tires_to_finish: 'yes',
          service: 'Fuel +70 L, no tires',
        },
        meta: { model: 'claude-opus-5', latencyMs: 1200, usage: {}, totals: {} },
      };
    },
  };
  const analyzer = new StrategyAnalyzer({ client, tracker, pitLossSec: 40 });
  const result = await analyzer.analyze(snap, { tire_health: 'good', pit_window: 'Beyond race end', lap: 15 });

  assert.equal(result.confidence, 'high');
  assert.equal(result.pit_lap, 30);
  assert.equal(result.metrics.fuel.lastLapToPitForFuel, 30);
  assert.equal(sent.schema, SCHEMA);
  assert.equal(sent.payload.reference.pitLossSec, 40);
  assert.equal(sent.payload.tires.tireEngineer.health, 'good');
  assert.ok(sent.payload.competitors.ahead);
});
