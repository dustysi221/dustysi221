'use strict';

/**
 * Tire wear analysis with Claude.
 *
 * 1. computeTireMetrics() turns a telemetry snapshot + tire history into the
 *    numbers an engineer looks at: edge spreads, axle/side balance, wear per
 *    lap and projected laps to the wear limit. Doing the arithmetic here keeps
 *    Claude focused on judgment instead of math.
 * 2. TireAnalyzer.analyze() sends those metrics to Claude and returns:
 *
 *    {
 *      tire_health: "good" | "fair" | "critical",
 *      radio: "Front left overheating. Ease off the brakes into slow right-handers.",
 *      pressure_adjustment: "-0.2 PSI front left",
 *      pit_window: "8-12 laps",
 *      driving_tips: ["...", "..."],
 *      analysis: "...",
 *      temperature_analysis: "...",
 *      pressure_adjustments: [{ tire, change_psi, reason }],
 *      pit_window_laps: { earliest, latest } | null,
 *      tires: { FL: { health, temperature_state, note }, ... },
 *      metrics, lap, createdAt, model, latencyMs, usage, totals
 *    }
 */

const { WHEEL_KEYS } = require('./telemetryParser');
const { limitWords } = require('./brevity');

const KPA_TO_PSI = 0.1450377;
const CORNER_NAMES = { FL: 'front left', FR: 'front right', RL: 'rear left', RR: 'rear right' };

const DEFAULTS = {
  optimalMinC: 75,
  optimalMaxC: 100,
  wearLimitPercent: 75,
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function windowState(tempC, { optimalMinC, optimalMaxC }) {
  if (tempC == null) return null;
  if (tempC < optimalMinC - 15) return 'cold';
  if (tempC < optimalMinC) return 'warming';
  if (tempC <= optimalMaxC) return 'optimal';
  if (tempC <= optimalMaxC + 12) return 'hot';
  return 'overheating';
}

const round = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const avg = (...xs) => (xs.every(Number.isFinite) ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * @param snapshot  telemetry snapshot from telemetryParser
 * @param history   TireHistory.summary() (optional)
 * @param options   { optimalMinC, optimalMaxC, wearLimitPercent }
 */
function computeTireMetrics(snapshot, history = {}, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { session, vehicle, tires } = snapshot;
  const lapSec = vehicle.lastLapSec || vehicle.bestLapSec || null;
  const perLap = history.avgWearPerLapLast3 || null;
  const trend = history.trendLast60s || null;

  const out = {};
  for (const k of WHEEL_KEYS) {
    const t = tires[k];
    const { innerC, middleC, outerC } = t.temps;

    // Wear rate: completed laps if we have them, else extrapolate the last minute
    let wearPerLap = perLap ? perLap[k] : null;
    let wearRateSource = wearPerLap != null ? 'completed_laps' : null;
    if (wearPerLap == null && trend && trend[k] && lapSec && trend.spanSec >= 30) {
      wearPerLap = (trend[k].wearChangePercent / trend.spanSec) * lapSec;
      wearRateSource = 'extrapolated_60s';
    }
    const lapsToWearLimit =
      wearPerLap > 0 ? Math.max(0, (opts.wearLimitPercent - t.wearPercent) / wearPerLap) : null;

    out[k] = {
      avgC: t.surfaceTempC,
      innerC,
      middleC,
      outerC,
      innerMinusOuterC: round(innerC - outerC),
      middleMinusEdgesC: round(middleC - avg(innerC, outerC)),
      carcassC: t.carcassTempC,
      windowState: windowState(t.surfaceTempC, opts),
      pressurePsi: round(t.pressureKpa * KPA_TO_PSI, 2),
      wearPercent: t.wearPercent,
      wearPerLap: round(wearPerLap, 3),
      wearRateSource,
      lapsToWearLimit: round(lapsToWearLimit, 1),
      tempTrendC60s: trend && trend[k] ? trend[k].tempChangeC : null,
      pressureTrendPsi60s: trend && trend[k] ? round(trend[k].pressureChangeKpa * KPA_TO_PSI, 2) : null,
      brakeC: t.brakeTempC,
      flat: t.flat,
      detached: t.detached,
    };
  }

  const m = out;
  const frontAvgC = avg(m.FL.avgC, m.FR.avgC);
  const rearAvgC = avg(m.RL.avgC, m.RR.avgC);
  const leftAvgC = avg(m.FL.avgC, m.RL.avgC);
  const rightAvgC = avg(m.FR.avgC, m.RR.avgC);

  const limiting = WHEEL_KEYS.filter((k) => m[k].lapsToWearLimit != null).sort(
    (a, b) => m[a].lapsToWearLimit - m[b].lapsToWearLimit,
  )[0];

  return {
    reference: {
      optimalWindowC: [opts.optimalMinC, opts.optimalMaxC],
      wearLimitPercent: opts.wearLimitPercent,
    },
    stint: {
      currentLap: vehicle.lap,
      lapsThisStint: history.lapsThisStint ?? null,
      stintStartLap: history.stintStartLap ?? null,
      lastLapSec: vehicle.lastLapSec,
      bestLapSec: vehicle.bestLapSec,
    },
    race: raceRemaining(session, vehicle, lapSec),
    tires: out,
    balance: {
      frontAvgC: round(frontAvgC),
      rearAvgC: round(rearAvgC),
      frontMinusRearC: round(frontAvgC - rearAvgC),
      leftAvgC: round(leftAvgC),
      rightAvgC: round(rightAvgC),
      leftMinusRightC: round(leftAvgC - rightAvgC),
      frontWearPerLap: round(avg(m.FL.wearPerLap, m.FR.wearPerLap), 3),
      rearWearPerLap: round(avg(m.RL.wearPerLap, m.RR.wearPerLap), 3),
    },
    projection: limiting
      ? {
          limitingTire: limiting,
          lapsToWearLimit: m[limiting].lapsToWearLimit,
          basis: m[limiting].wearRateSource,
        }
      : null,
  };
}

function raceRemaining(session, vehicle, lapSec) {
  const timeRemainingSec =
    session.endSec > 0 && session.elapsedSec != null && session.endSec < 1e6
      ? Math.max(0, session.endSec - session.elapsedSec)
      : null;
  let lapsRemaining = null;
  if (session.maxLaps && vehicle.lapsCompleted != null) {
    lapsRemaining = Math.max(0, session.maxLaps - vehicle.lapsCompleted);
  } else if (timeRemainingSec != null && lapSec) {
    lapsRemaining = Math.ceil(timeRemainingSec / lapSec);
  }
  return {
    sessionType: session.type,
    timeRemainingSec: round(timeRemainingSec, 0),
    lapsRemaining,
  };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const HEALTH = { type: 'string', enum: ['good', 'fair', 'critical'] };
const CORNER = { type: 'string', enum: WHEEL_KEYS };

const TIRE_SCHEMA = {
  type: 'object',
  properties: {
    health: HEALTH,
    temperature_state: { type: 'string', enum: ['cold', 'warming', 'optimal', 'hot', 'overheating'] },
    note: { type: 'string' },
  },
  required: ['health', 'temperature_state', 'note'],
  additionalProperties: false,
};

const SCHEMA = {
  type: 'object',
  properties: {
    tire_health: HEALTH,
    radio: { type: 'string' },
    analysis: { type: 'string' },
    temperature_analysis: { type: 'string' },
    pressure_adjustment: { type: 'string' },
    pressure_adjustments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tire: CORNER,
          change_psi: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['tire', 'change_psi', 'reason'],
        additionalProperties: false,
      },
    },
    pit_window: { type: 'string' },
    pit_window_laps: {
      anyOf: [
        {
          type: 'object',
          properties: { earliest: { type: 'integer' }, latest: { type: 'integer' } },
          required: ['earliest', 'latest'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    driving_tips: { type: 'array', items: { type: 'string' } },
    tires: {
      type: 'object',
      properties: Object.fromEntries(WHEEL_KEYS.map((k) => [k, TIRE_SCHEMA])),
      required: WHEEL_KEYS,
      additionalProperties: false,
    },
  },
  required: [
    'tire_health',
    'radio',
    'analysis',
    'temperature_analysis',
    'pressure_adjustment',
    'pressure_adjustments',
    'pit_window',
    'pit_window_laps',
    'driving_tips',
    'tires',
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the tire engineer on the pit wall for a Le Mans Ultimate (rFactor 2 physics) entry, talking to your driver. Speak like a professional race engineer on the radio: calm, precise, numbers first, no filler, no hedging beyond what the data warrants.

Each message is a JSON telemetry brief computed from live data:
- tires.<corner>: tread temps in °C (inner/middle/outer edge, avg), carcass temp, hot pressure in PSI, wear % (0 = new), wear per lap (%), laps until the wear limit, 60-second temp and pressure trends, windowState against the reference window
- innerMinusOuterC: positive = inside edge hotter (camber); middleMinusEdgesC: positive = center hotter (over-inflated), negative = edges hotter (under-inflated)
- balance: front vs rear and left vs right temperature and wear
- projection: the tire that limits the stint and its laps to the wear limit
- race: laps or time remaining in the session
- reference: the configured optimal window and wear limit. The window is a generic default, not a manufacturer figure; weigh it against what the data shows.

Assessment rules:
- tire_health: "good" = all tires in or near the window and the wear rate supports the stint; "fair" = one or more tires out of the window, a clear imbalance, or wear that will shorten the stint; "critical" = overheating, a flat or detached tire, fewer than ~3 laps to the wear limit, or anything that risks a failure.
- Rules of thumb: an inner edge up to ~8 °C hotter than the outer is normal with negative camber; beyond ~12 °C suggests too much camber, and outer hotter than inner suggests too little. A middle more than ~4 °C above the edge average points to over-inflation; more than ~4 °C below points to under-inflation.
- Tires below the window early in a stint (lap 1-2 on fresh tires, or trends still rising) are "warming", not a problem; say so.
- Pressure: recommend cold-pressure changes for the next stop in PSI, in 0.1-0.5 PSI steps, naming the tire (e.g. "-0.2 PSI front left, +0.1 PSI rear right"). Base them on temperature distribution and trend, not on a guessed target pressure. If none are needed, use "No change" and an empty pressure_adjustments list.
- pit_window: laps from now, as a range such as "8-12 laps", driven by projection.lapsToWearLimit (start the window a couple of laps before the limit; widen it when the wear rate is extrapolated rather than measured). If there is no wear rate yet, say "Insufficient data - need 1-2 more laps" and set pit_window_laps to null. If the tires will outlast the session, say so (e.g. "Beyond race end (14 laps left)").
- driving_tips: 0-2 technique changes that address the actual symptom (e.g. front overheating -> less trail-brake; rear overheating -> smoother throttle on exit). The brief has no corner-by-corner data, so name corner types, not turn numbers.

Brevity is critical. The driver reads this at a glance while racing, and it will later be spoken over the radio. Every word must earn its place:
- radio: the one message for the driver. 1-2 short sentences, at most 25 words in total. Lead with the action, then the reason, e.g. "Front left overheating. Ease off the brakes into slow right-handers." or "Tires good, stint on target." No preamble, no hedging, no repeating the numbers on the dashboard.
- analysis: one sentence, at most 20 words.
- temperature_analysis: at most 12 words (e.g. "Fronts hot and rising, rears in window.").
- pressure_adjustment: at most 8 words (e.g. "-0.2 PSI front left" or "No change").
- pit_window: at most 6 words (e.g. "8-12 laps").
- driving_tips: each at most 8 words.
- tires.<corner>.note: at most 6 words; empty when the tire is fine.
Use PSI and °C.`;

class TireAnalyzer {
  /**
   * @param {object} opts
   * @param {import('./claudeClient').ClaudeClient} opts.client
   * @param {number} [opts.optimalMinC]
   * @param {number} [opts.optimalMaxC]
   * @param {number} [opts.wearLimitPercent]
   */
  constructor({ client, ...options }) {
    this.client = client;
    this.options = { ...DEFAULTS, ...options };
    this.inFlight = false;
  }

  get enabled() {
    return Boolean(this.client && this.client.enabled);
  }

  /**
   * @returns the analysis, or null when skipped because a request is already running
   */
  async analyze(snapshot, historySummary = {}) {
    if (!this.enabled || this.inFlight) return null;
    this.inFlight = true;
    try {
      const metrics = computeTireMetrics(snapshot, historySummary, this.options);
      const { data, meta } = await this.client.requestJson({
        system: SYSTEM_PROMPT,
        payload: buildBrief(snapshot, metrics),
        schema: SCHEMA,
      });
      return {
        ...normalize(data),
        metrics,
        lap: snapshot.vehicle.lap,
        createdAt: new Date().toISOString(),
        ...meta,
      };
    } finally {
      this.inFlight = false;
    }
  }
}

function buildBrief(snapshot, metrics) {
  const { session, vehicle } = snapshot;
  return {
    car: {
      name: vehicle.name,
      class: vehicle.class,
      frontCompound: vehicle.frontCompound,
      rearCompound: vehicle.rearCompound,
      inPits: vehicle.inPits,
    },
    conditions: {
      track: session.trackName,
      trackTempC: session.trackTempC,
      ambientTempC: session.ambientTempC,
      raining: session.raining,
      wetness: session.avgPathWetness,
    },
    ...metrics,
  };
}

/** Defensive cleanup so the dashboard never has to guard against odd output. */
function normalize(d) {
  const str = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);
  const tires = {};
  for (const k of WHEEL_KEYS) {
    const t = (d.tires && d.tires[k]) || {};
    tires[k] = {
      health: ['good', 'fair', 'critical'].includes(t.health) ? t.health : 'fair',
      temperature_state: t.temperature_state || null,
      note: limitWords(str(t.note), 8),
    };
  }
  const adjustments = Array.isArray(d.pressure_adjustments)
    ? d.pressure_adjustments
        .filter((a) => a && WHEEL_KEYS.includes(a.tire) && Number.isFinite(a.change_psi) && a.change_psi !== 0)
        .map((a) => ({ tire: a.tire, change_psi: round(a.change_psi, 2), reason: str(a.reason) }))
    : [];
  return {
    tire_health: ['good', 'fair', 'critical'].includes(d.tire_health) ? d.tire_health : 'fair',
    pressure_adjustment: limitWords(str(d.pressure_adjustment), 10) || formatAdjustments(adjustments),
    pit_window: limitWords(str(d.pit_window, 'Unknown'), 8),
    radio: limitWords(str(d.radio) || str(d.analysis), 30),
    driving_tips: Array.isArray(d.driving_tips)
      ? d.driving_tips.map((t) => limitWords(str(t), 10)).filter(Boolean).slice(0, 2)
      : [],
    analysis: limitWords(str(d.analysis), 25),
    temperature_analysis: limitWords(str(d.temperature_analysis), 15),
    pressure_adjustments: adjustments,
    pit_window_laps:
      d.pit_window_laps && Number.isFinite(d.pit_window_laps.earliest) && Number.isFinite(d.pit_window_laps.latest)
        ? d.pit_window_laps
        : null,
    tires,
  };
}

function formatAdjustments(adjustments) {
  if (!adjustments.length) return 'No change';
  return adjustments
    .map((a) => `${a.change_psi > 0 ? '+' : ''}${a.change_psi.toFixed(1)} PSI ${CORNER_NAMES[a.tire]}`)
    .join(', ');
}

module.exports = {
  TireAnalyzer,
  computeTireMetrics,
  windowState,
  normalize,
  SCHEMA,
  SYSTEM_PROMPT,
  DEFAULTS,
};
