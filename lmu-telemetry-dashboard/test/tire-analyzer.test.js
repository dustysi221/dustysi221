'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTireMetrics, windowState, normalize, TireAnalyzer, SCHEMA } = require('../src/tire-analyzer');
const { parseSnapshot } = require('../src/telemetryParser');
const { MockSource } = require('../src/mockSource');

function tire({ inner, middle, outer, wear = 10, kpa = 180 }) {
  return {
    temps: { innerC: inner, middleC: middle, outerC: outer },
    surfaceTempC: (inner + middle + outer) / 3,
    carcassTempC: middle - 5,
    pressureKpa: kpa,
    wearPercent: wear,
    brakeTempC: 500,
    flat: false,
    detached: false,
  };
}

function snapshot(overrides = {}) {
  return {
    session: { type: 'race', elapsedSec: 600, endSec: 3600, maxLaps: null, trackTempC: 35, ambientTempC: 22 },
    vehicle: { lap: 7, lapsCompleted: 6, lastLapSec: 100, bestLapSec: 99.5, name: 'Car', class: 'GT3' },
    tires: {
      FL: tire({ inner: 102, middle: 95, outer: 88, wear: 12 }), // 14 C inner-outer spread
      FR: tire({ inner: 90, middle: 86, outer: 85, wear: 9 }),
      RL: tire({ inner: 84, middle: 90, outer: 83, wear: 8 }), // hot middle
      RR: tire({ inner: 60, middle: 58, outer: 57, wear: 7 }),
    },
    ...overrides,
  };
}

test('windowState classifies against the reference window', () => {
  const w = { optimalMinC: 75, optimalMaxC: 100 };
  assert.equal(windowState(55, w), 'cold');
  assert.equal(windowState(70, w), 'warming');
  assert.equal(windowState(90, w), 'optimal');
  assert.equal(windowState(105, w), 'hot');
  assert.equal(windowState(120, w), 'overheating');
});

test('metrics: edge spreads, balance, psi, and wear projection from completed laps', () => {
  const history = {
    lapsThisStint: 6,
    stintStartLap: 1,
    avgWearPerLapLast3: { FL: 2, FR: 1.5, RL: 1.3, RR: 1.2 },
  };
  const m = computeTireMetrics(snapshot(), history, { wearLimitPercent: 70 });

  assert.equal(m.tires.FL.innerMinusOuterC, 14);
  assert.equal(m.tires.RL.middleMinusEdgesC, 6.5);
  assert.equal(m.tires.FL.pressurePsi, 26.11);
  assert.equal(m.tires.RR.windowState, 'cold');
  assert.equal(m.tires.FL.lapsToWearLimit, 29); // (70 - 12) / 2
  assert.deepEqual(m.projection, { limitingTire: 'FL', lapsToWearLimit: 29, basis: 'completed_laps' });
  assert.equal(m.race.timeRemainingSec, 3000);
  assert.equal(m.race.lapsRemaining, 30);
  assert.ok(m.balance.frontMinusRearC > 0);
});

test('metrics: extrapolates wear from the 60 s trend before a lap is complete', () => {
  const trend = { spanSec: 60 };
  for (const k of ['FL', 'FR', 'RL', 'RR']) trend[k] = { tempChangeC: 3, pressureChangeKpa: 1, wearChangePercent: 0.6 };
  const m = computeTireMetrics(snapshot(), { trendLast60s: trend });
  assert.equal(m.tires.FL.wearPerLap, 1); // 0.6% per 60 s * 100 s lap
  assert.equal(m.tires.FL.wearRateSource, 'extrapolated_60s');
  assert.equal(m.projection.basis, 'extrapolated_60s');
});

test('metrics: no wear rate means no projection', () => {
  const m = computeTireMetrics(snapshot(), {});
  assert.equal(m.projection, null);
  assert.equal(m.tires.FL.lapsToWearLimit, null);
});

test('metrics work on a real parsed snapshot', () => {
  const m = computeTireMetrics(parseSnapshot(new MockSource().read()), {});
  assert.ok(Number.isFinite(m.tires.FR.pressurePsi));
});

test('normalize fills gaps and formats pressure changes', () => {
  const out = normalize({
    tire_health: 'excellent',
    pressure_adjustments: [
      { tire: 'FL', change_psi: -0.2, reason: 'hot middle' },
      { tire: 'XX', change_psi: 1, reason: 'bogus' },
      { tire: 'RR', change_psi: 0, reason: 'zero' },
    ],
    driving_tips: ['a', ' ', 'b', 'c', 'd', 'e'],
    tires: { FL: { health: 'critical', temperature_state: 'overheating', note: ' hot ' } },
  });
  assert.equal(out.tire_health, 'fair');
  assert.equal(out.pressure_adjustment, '-0.2 PSI front left');
  assert.equal(out.pressure_adjustments.length, 1);
  assert.deepEqual(out.driving_tips, ['a', 'b', 'c', 'd']);
  assert.equal(out.tires.FL.note, 'hot');
  assert.equal(out.tires.RR.health, 'fair');
  assert.equal(out.pit_window, 'Unknown');
  assert.equal(out.pit_window_laps, null);
});

test('schema requires every documented field', () => {
  for (const key of ['tire_health', 'pressure_adjustment', 'pit_window', 'driving_tips', 'analysis']) {
    assert.ok(SCHEMA.required.includes(key), key);
  }
});

test('analyze sends the brief to Claude and merges metrics into the result', async () => {
  let sent;
  const client = {
    enabled: true,
    async requestJson(req) {
      sent = req;
      return {
        data: {
          tire_health: 'fair',
          analysis: 'Front left overheating on the inside edge.',
          temperature_analysis: 'Fronts hot, rear right still cold.',
          pressure_adjustment: '-0.2 PSI front left',
          pressure_adjustments: [{ tire: 'FL', change_psi: -0.2, reason: 'hot' }],
          pit_window: '8-12 laps',
          pit_window_laps: { earliest: 8, latest: 12 },
          driving_tips: ['Less trail-braking into slow corners'],
          tires: {
            FL: { health: 'fair', temperature_state: 'hot', note: 'Inside edge +14 C' },
            FR: { health: 'good', temperature_state: 'optimal', note: '' },
            RL: { health: 'good', temperature_state: 'optimal', note: '' },
            RR: { health: 'good', temperature_state: 'cold', note: 'Still warming' },
          },
        },
        meta: { model: 'claude-opus-5', latencyMs: 900, usage: {}, totals: {} },
      };
    },
  };
  const analyzer = new TireAnalyzer({ client });
  const result = await analyzer.analyze(snapshot(), { avgWearPerLapLast3: { FL: 2, FR: 1, RL: 1, RR: 1 } });

  assert.equal(result.tire_health, 'fair');
  assert.equal(result.pit_window, '8-12 laps');
  assert.equal(result.lap, 7);
  assert.equal(result.metrics.projection.limitingTire, 'FL');
  assert.equal(sent.schema, SCHEMA);
  assert.equal(sent.payload.tires.FL.innerMinusOuterC, 14);
  assert.equal(sent.payload.car.class, 'GT3');
});

test('analyze skips while a request is already running', async () => {
  let release;
  const client = { enabled: true, requestJson: () => new Promise((r) => (release = r)) };
  const analyzer = new TireAnalyzer({ client });
  const first = analyzer.analyze(snapshot(), {});
  assert.equal(await analyzer.analyze(snapshot(), {}), null);
  release({ data: {}, meta: {} });
  assert.ok(await first);
});

test('ClaudeClient omits thinking and effort for Haiku, keeps them for other models', async () => {
  const { ClaudeClient } = require('../src/claudeClient');
  const sent = [];
  for (const model of ['claude-haiku-4-5', 'claude-opus-5']) {
    const client = new ClaudeClient({ apiKey: 'test', model, useFallbacks: false });
    client.sdk = {
      messages: {
        create: async (params) => {
          sent.push(params);
          return { content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', usage: {}, model };
        },
      },
    };
    await client.requestJson({ system: 's', payload: {}, schema: { type: 'object' } });
  }
  assert.equal(sent[0].thinking, undefined);
  assert.equal(sent[0].output_config.effort, undefined);
  assert.deepEqual(sent[1].thinking, { type: 'adaptive' });
  assert.equal(sent[1].output_config.effort, 'low');
});
