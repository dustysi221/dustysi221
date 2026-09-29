'use strict';

/**
 * Race strategy with Claude.
 *
 * 1. computeStrategyMetrics() condenses the session history (SessionTracker)
 *    and the live snapshot into strategy numbers: laps/time remaining, fuel
 *    rate and the last lap you can pit on for fuel, tire wear trend and whether
 *    the tires reach the finish, stint pace and degradation, and pace/gaps to
 *    the cars around you in class.
 * 2. StrategyAnalyzer.analyze() asks Claude, as the strategist on the pit wall,
 *    for the call:
 *
 *    {
 *      pit_recommendation: "Box end of lap 30 for fuel and four tires",
 *      fuel_status: "2.9 L/lap, 45 L in tank = 15.5 laps; need 62 L to finish",
 *      tire_trend: "Wear steady at 1.1 %/lap on the FL; tires reach the flag",
 *      strategy: "One-stop: box lap 30, full fuel, four tires, no splash needed",
 *      confidence: "high" | "medium" | "low",
 *      radio: "Box end of lap 30, fuel only. Tires make the finish.",
 *      call, pit_lap, pit_window_laps, stops_remaining, tires_to_finish,
 *      service, competitor_analysis,
 *      metrics, lap, createdAt, model, latencyMs, usage, totals
 *    }
 */

const { WHEEL_KEYS } = require('./telemetryParser');
const { limitWords } = require('./brevity');

const DEFAULTS = {
  pitLossSec: 35, // time lost for a stop incl. pit lane; configured estimate
  wearLimitPercent: 75,
  fuelReserveLaps: 1,
  lapMarginLaps: 0.25, // don't plan to arrive at the pit entry with less than this in hand
};

const round = (n, d = 1) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Least-squares slope of ys over their index (units per lap). */
function slope(ys) {
  if (ys.length < 3) return null;
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = mean(ys);
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  });
  return den ? num / den : null;
}

/**
 * How many more lap ends (start/finish crossings, i.e. chances to pit) the car
 * can reach with `lapsAvailable` laps of range, given `lapFraction` of the
 * current lap already done.
 */
function lapEndsReachable(lapsAvailable, lapFraction, margin) {
  if (!Number.isFinite(lapsAvailable)) return null;
  const toFirstLine = 1 - lapFraction;
  const usable = lapsAvailable - margin;
  if (usable < toFirstLine) return 0;
  return Math.floor(usable - toFirstLine) + 1;
}

/**
 * @param snapshot  full snapshot (with `field`)
 * @param tracker   SessionTracker
 * @param options   { pitLossSec, wearLimitPercent, fuelReserveLaps, tireAnalysis }
 */
function computeStrategyMetrics(snapshot, tracker, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { session, vehicle, tires } = snapshot;
  // lapDistanceM is already on the new lap when scoring hasn't caught up yet
  const currentLap = (vehicle.lapsCompleted ?? vehicle.lap - 1) + 1 + (vehicle.scoringLapBehind ? 1 : 0);
  const lapFraction =
    vehicle.lapDistanceM != null && session.lapDistanceM ? Math.min(0.999, vehicle.lapDistanceM / session.lapDistanceM) : 0.5;

  // --- pace -------------------------------------------------------------
  const stint = tracker.currentStint;
  const stintNo = stint ? stint.number : null;
  const stintClean = tracker.cleanLaps({ stint: stintNo });
  const recentClean = tracker.cleanLaps({ last: 5 });
  const lapTimes = recentClean.map((l) => l.lapTimeSec).filter(Boolean);
  const avgLapSec = mean(lapTimes.slice(-3)) || vehicle.lastLapSec || vehicle.bestLapSec || null;
  const stintTimes = stintClean.map((l) => l.lapTimeSec).filter(Boolean);

  // --- race length ------------------------------------------------------
  const timeRemainingSec =
    session.endSec > 0 && session.endSec < 1e6 && session.elapsedSec != null
      ? Math.max(0, session.endSec - session.elapsedSec)
      : null;
  let lapsRemaining = null;
  let lapsRemainingBasis = null;
  if (session.maxLaps && vehicle.lapsCompleted != null) {
    lapsRemaining = Math.max(0, session.maxLaps - vehicle.lapsCompleted);
    lapsRemainingBasis = 'lap_limit';
  } else if (timeRemainingSec != null && avgLapSec) {
    // Timed race: finish the lap in progress when the clock hits zero
    lapsRemaining = Math.ceil((timeRemainingSec + lapFraction * avgLapSec) / avgLapSec);
    lapsRemainingBasis = 'timed_estimate';
  }

  // --- fuel -------------------------------------------------------------
  const fuelLaps = tracker.cleanLaps({ last: 5 }).map((l) => l.fuelUsedL).filter((f) => f > 0);
  const perLapL = mean(fuelLaps.slice(-3));
  const lapsOfFuel = perLapL ? vehicle.fuelL / perLapL : null;
  const fuelToFinishL =
    perLapL && lapsRemaining != null
      ? (lapsRemaining - lapFraction + opts.fuelReserveLaps) * perLapL
      : null;
  const shortfallL = fuelToFinishL != null ? Math.max(0, fuelToFinishL - vehicle.fuelL) : null;
  const capacity = vehicle.fuelCapacityL || null;
  const fuelEnds = lapEndsReachable(lapsOfFuel, lapFraction, opts.lapMarginLaps);

  // --- tires ------------------------------------------------------------
  // Wear rate from this stint; right after a stop, fall back to the previous set
  let wearLaps = tracker.cleanLaps({ stint: stintNo }).filter((l) => l.wearDelta);
  let wearBasis = 'this_stint';
  if (wearLaps.length === 0) {
    wearLaps = tracker.cleanLaps().filter((l) => l.wearDelta).slice(-3);
    wearBasis = wearLaps.length ? 'previous_stint' : null;
  }
  const recentWear = wearLaps.slice(-3);
  const earlyWear = wearLaps.slice(0, 3);
  const wearRate = (laps, k) => mean(laps.map((l) => l.wearDelta[k]));
  const perTire = {};
  for (const k of WHEEL_KEYS) {
    const recent = recentWear.length ? wearRate(recentWear, k) : null;
    const early = earlyWear.length ? wearRate(earlyWear, k) : null;
    const toLimit = recent > 0 ? Math.max(0, (opts.wearLimitPercent - tires[k].wearPercent) / recent) : null;
    perTire[k] = {
      wearPercent: tires[k].wearPercent,
      wearPerLapRecent: round(recent, 3),
      wearPerLapStintStart: round(early, 3),
      lapsToWearLimit: round(toLimit, 1),
    };
  }
  const limiting = WHEEL_KEYS.filter((k) => perTire[k].lapsToWearLimit != null).sort(
    (a, b) => perTire[a].lapsToWearLimit - perTire[b].lapsToWearLimit,
  )[0];
  const lim = limiting ? perTire[limiting] : null;
  const tireEnds = lim ? lapEndsReachable(lim.lapsToWearLimit, lapFraction, opts.lapMarginLaps) : null;
  const accelerationRatio =
    lim && wearBasis === 'this_stint' && lim.wearPerLapStintStart > 0 && wearLaps.length >= 4
      ? lim.wearPerLapRecent / lim.wearPerLapStintStart
      : null;
  const newTireStintLaps =
    lim && lim.wearPerLapRecent > 0 ? opts.wearLimitPercent / lim.wearPerLapRecent : null;

  // --- stops needed -----------------------------------------------------
  let stopsForFuel = null;
  if (shortfallL != null && capacity) stopsForFuel = Math.ceil(shortfallL / (capacity * 0.97));
  let stopsForTires = null;
  if (lim && lapsRemaining != null && newTireStintLaps) {
    const beyond = lapsRemaining - lim.lapsToWearLimit;
    stopsForTires = beyond > 0 ? Math.ceil(beyond / newTireStintLaps) : 0;
  }

  const tireAnalysis = opts.tireAnalysis;

  return {
    reference: {
      pitLossSec: opts.pitLossSec,
      pitLossIsEstimate: true,
      wearLimitPercent: opts.wearLimitPercent,
      fuelReserveLaps: opts.fuelReserveLaps,
    },
    race: {
      sessionType: session.type,
      phase: session.phase,
      currentLap,
      lapFraction: round(lapFraction, 2),
      position: vehicle.position,
      classPosition: vehicle.classPosition,
      timeRemainingSec: round(timeRemainingSec, 0),
      lapsRemaining,
      lapsRemainingBasis,
    },
    stint: {
      number: stintNo,
      startLap: stint ? stint.startLap : null,
      lapsInStint: stint ? Math.max(0, currentLap - stint.startLap) : null,
      stintTimeSec: stint && session.elapsedSec != null ? round(session.elapsedSec - stint.startSec, 0) : null,
      pitStopsSoFar: tracker.pitStops.length,
      pitStops: tracker.pitStops.slice(-5),
    },
    pace: {
      lastLapSec: vehicle.lastLapSec,
      bestLapSec: vehicle.bestLapSec,
      avgLast3Sec: round(mean(lapTimes.slice(-3)), 3),
      recentCleanLaps: lapTimes.map((t) => round(t, 3)),
      stintDegradationSecPerLap: round(slope(stintTimes), 3),
      cleanLapsThisStint: stintClean.length,
    },
    fuel: {
      currentL: vehicle.fuelL,
      capacityL: capacity,
      perLapL: round(perLapL, 2),
      lapsOfFuel: round(lapsOfFuel, 1),
      fuelToFinishL: round(fuelToFinishL, 1),
      shortfallL: round(shortfallL, 1),
      lastLapToPitForFuel: fuelEnds != null ? currentLap + fuelEnds - 1 : null,
      maxStintLapsOnFullTank: perLapL && capacity ? round(capacity / perLapL, 1) : null,
      stopsNeededForFuel: stopsForFuel,
      basisLaps: fuelLaps.length,
    },
    tires: {
      perTire,
      limitingTire: limiting || null,
      lapsToWearLimit: lim ? lim.lapsToWearLimit : null,
      lastLapToPitForTires: tireEnds != null ? currentLap + tireEnds - 1 : null,
      lastToFinish: lim && lapsRemaining != null ? lim.lapsToWearLimit >= lapsRemaining : null,
      wearAccelerationRatio: round(accelerationRatio, 2),
      lapsPerNewSet: round(newTireStintLaps, 1),
      stopsNeededForTires: stopsForTires,
      basisLaps: wearLaps.length,
      basis: wearBasis,
      tireEngineer: tireAnalysis
        ? { health: tireAnalysis.tire_health, pitWindow: tireAnalysis.pit_window, lap: tireAnalysis.lap }
        : null,
    },
    competitors: competitorSummary(snapshot, tracker, avgLapSec),
  };
}

function competitorSummary(snapshot, tracker, myPace) {
  const field = snapshot.field || [];
  const me = field.find((c) => c.isPlayer);
  if (!me || field.length < 2) return null;

  const sameClass = field.filter((c) => c.class === me.class).sort((a, b) => a.position - b.position);
  const idx = sameClass.findIndex((c) => c.id === me.id);

  const describe = (car) => {
    if (!car) return null;
    const pace = tracker.competitorPace(car.id);
    const gap =
      Number.isFinite(car.timeBehindLeaderSec) && Number.isFinite(me.timeBehindLeaderSec)
        ? me.timeBehindLeaderSec - car.timeBehindLeaderSec // + = they are ahead of us
        : null;
    return {
      car: car.vehicle,
      driver: car.driver,
      classPosition: sameClass.indexOf(car) + 1,
      overallPosition: car.position,
      gapSec: round(gap, 1),
      lapsDifference: car.lapsCompleted - me.lapsCompleted, // + = they have completed more laps
      avgPaceSec: round(pace, 3),
      paceDeltaSecPerLap: pace && myPace ? round(pace - myPace, 3) : null, // - = they are faster
      pitStops: car.pitStops,
      inPits: car.inPits,
    };
  };

  return {
    playerClass: me.class,
    carsInClass: sameClass.length,
    classLeader: idx > 1 ? describe(sameClass[0]) : null, // only when it isn't the car directly ahead
    ahead: idx > 0 ? describe(sameClass[idx - 1]) : null,
    behind: idx >= 0 && idx < sameClass.length - 1 ? describe(sameClass[idx + 1]) : null,
    note: 'gapSec > 0: that car is ahead of you by that many seconds; paceDeltaSecPerLap < 0: that car is faster',
  };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const LAP_RANGE = {
  anyOf: [
    {
      type: 'object',
      properties: { earliest: { type: 'integer' }, latest: { type: 'integer' } },
      required: ['earliest', 'latest'],
      additionalProperties: false,
    },
    { type: 'null' },
  ],
};

const SCHEMA = {
  type: 'object',
  properties: {
    call: { type: 'string' },
    radio: { type: 'string' },
    pit_recommendation: { type: 'string' },
    fuel_status: { type: 'string' },
    tire_trend: { type: 'string' },
    strategy: { type: 'string' },
    competitor_analysis: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    pit_lap: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    pit_window_laps: LAP_RANGE,
    stops_remaining: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    tires_to_finish: { type: 'string', enum: ['yes', 'marginal', 'no', 'unknown'] },
    service: { type: 'string' },
  },
  required: [
    'call',
    'radio',
    'pit_recommendation',
    'fuel_status',
    'tire_trend',
    'strategy',
    'competitor_analysis',
    'confidence',
    'pit_lap',
    'pit_window_laps',
    'stops_remaining',
    'tires_to_finish',
    'service',
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are the race strategist on the pit wall for a Le Mans Ultimate (rFactor 2 physics) entry, making real-time strategy calls to your driver and crew. You sound like a top endurance strategist on the radio: decisive, numbers-driven, calm, and explicit about the plan and the trigger for changing it.

Each message is a JSON strategy brief computed from live telemetry and the session history:
- race: current lap (the lap in progress), laps/time remaining (lapsRemainingBasis "timed_estimate" means estimated from average pace), positions
- stint: stint number, laps and time in the stint, pit stops made
- pace: recent clean lap times, stint degradation in s/lap (positive = getting slower)
- fuel: consumption per lap from clean laps, laps of fuel in the tank, fuel needed to finish including the reserve, shortfall, lastLapToPitForFuel (the last lap whose end you can safely reach the pit entry), stops needed for fuel
- tires: per-tire wear % and wear per lap now vs at the start of the stint (basis "previous_stint" = no clean lap on this set yet, rate taken from the last set), the limiting tire, laps to the wear limit, lastLapToPitForTires, whether the tires reach the finish, wearAccelerationRatio (>1.15 = wear accelerating), laps a new set lasts, the tire engineer's latest verdict
- competitors: class leader and the cars directly ahead/behind in class: gap, average pace and pace delta per lap vs you, pit stops made, whether they are in the pits
- damage: body damage per zone (0 none, 1 some, 2 heavy), detached parts, flat or detached wheels, engine overheating, seconds since the last impact
- reference: pit loss per stop (a configured estimate, not measured), wear limit, fuel reserve
Lap numbers in pit_lap and pit_window_laps are absolute race laps; "box end of lap N" means entering the pits at the end of lap N.

How to make the call:
- Damage first: if damage shows heavy dents (2), detached parts, a flat or detached wheel, or engine overheating, the call is to box for repairs ("Box this lap, repairs"). Light dents (1) alone don't change the plan.
- Hard limits first: never plan a pit lap later than fuel.lastLapToPitForFuel or tires.lastLapToPitForTires.
- Combine fuel and tires in one stop where possible. Skip the tire change if the current set reaches the finish (tires.lastToFinish) and the tire engineer is not flagging a problem; a fuel-only stop is shorter.
- Use the minimum number of stops that covers both fuel and tire needs (stopsNeededForFuel, stopsNeededForTires). If no stop is needed, the call is to stay out.
- When there is freedom in timing, use the competitors: pit earlier to undercut a car ahead that is close (gap < pit loss) and on older tires; pit later to overcut or to stay out of traffic; cover the car behind if it can undercut you. If there is no competitor data, say "No competitor data" in competitor_analysis.
- Practice or qualifying: give a run plan (fuel load, laps per run) instead of race pit calls.
- confidence: "high" with 3+ clean laps of fuel and wear data and consistent pace; "medium" with 1-2 clean laps, a timed-race lap estimate, or noisy pace; "low" with no clean laps or conflicting data.
- Never invent data. The pit loss is an estimate and timed-race lap counts are estimates; say so when they drive the decision.

Brevity is critical. The driver reads this at a glance while racing, and it will later be spoken over the radio. Every word must earn its place:
- radio: the one message for the driver. 1-2 short sentences, at most 25 words in total. Lead with the call, then the key reason, e.g. "Box end of lap 30, fuel only. Tires make the finish." or "Stay out, plan A. #6 is pulling away, no threat behind." No preamble, no hedging.
- call: at most 8 words (e.g. "Box end of lap 30, fuel only", "Stay out, plan A")
- pit_recommendation: at most 15 words (e.g. "Pit in 5 laps for tires and fuel")
- fuel_status: at most 12 words (e.g. "2.9 L/lap, 15.5 laps in tank, 62 L short")
- tire_trend: at most 12 words (e.g. "FL wear rising, makes the finish")
- strategy: at most 20 words: the plan and the trigger to change it
- competitor_analysis: at most 15 words
- service: at most 6 words (e.g. "Fuel +62 L, four tires", "Fuel only +18 L", "No stop")
- pit_lap / pit_window_laps / stops_remaining: null when unknown or when no stop is needed
Use liters, seconds, and laps.`;

class StrategyAnalyzer {
  /**
   * @param {object} opts
   * @param {import('./claudeClient').ClaudeClient} opts.client
   * @param {import('./sessionTracker').SessionTracker} opts.tracker
   * @param {number} [opts.pitLossSec]
   * @param {number} [opts.wearLimitPercent]
   * @param {number} [opts.fuelReserveLaps]
   */
  constructor({ client, tracker, ...options }) {
    this.client = client;
    this.tracker = tracker;
    this.options = { ...DEFAULTS, ...options };
    this.inFlight = false;
  }

  get enabled() {
    return Boolean(this.client && this.client.enabled);
  }

  /**
   * @param snapshot       full snapshot including `field`
   * @param tireAnalysis   latest TireAnalyzer result, optional
   * @returns the strategy call, or null when skipped because a request is already running
   */
  async analyze(snapshot, tireAnalysis = null) {
    if (!this.enabled || this.inFlight) return null;
    this.inFlight = true;
    try {
      const metrics = computeStrategyMetrics(snapshot, this.tracker, { ...this.options, tireAnalysis });
      const { data, meta } = await this.client.requestJson({
        system: SYSTEM_PROMPT,
        payload: {
          car: { name: snapshot.vehicle.name, class: snapshot.vehicle.class },
          damage: snapshot.damage || null,
          track: snapshot.session.trackName,
          ...metrics,
        },
        schema: SCHEMA,
      });
      return {
        ...normalize(data),
        metrics,
        lap: metrics.race.currentLap,
        createdAt: new Date().toISOString(),
        ...meta,
      };
    } finally {
      this.inFlight = false;
    }
  }
}

function normalize(d) {
  const str = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
  const int = (v) => (Number.isInteger(v) ? v : null);
  const range =
    d.pit_window_laps && Number.isInteger(d.pit_window_laps.earliest) && Number.isInteger(d.pit_window_laps.latest)
      ? { earliest: d.pit_window_laps.earliest, latest: d.pit_window_laps.latest }
      : null;
  return {
    pit_recommendation: limitWords(str(d.pit_recommendation, 'No recommendation'), 20),
    fuel_status: limitWords(str(d.fuel_status, 'Fuel data pending'), 15),
    tire_trend: limitWords(str(d.tire_trend, 'Tire trend pending'), 15),
    strategy: limitWords(str(d.strategy), 25),
    confidence: ['high', 'medium', 'low'].includes(d.confidence) ? d.confidence : 'low',
    call: limitWords(str(d.call), 10),
    radio: limitWords(str(d.radio) || str(d.call) || str(d.pit_recommendation), 30),
    competitor_analysis: limitWords(str(d.competitor_analysis, 'No competitor data'), 20),
    pit_lap: int(d.pit_lap),
    pit_window_laps: range,
    stops_remaining: int(d.stops_remaining),
    tires_to_finish: ['yes', 'marginal', 'no', 'unknown'].includes(d.tires_to_finish) ? d.tires_to_finish : 'unknown',
    service: limitWords(str(d.service), 8),
  };
}

module.exports = {
  StrategyAnalyzer,
  computeStrategyMetrics,
  lapEndsReachable,
  slope,
  normalize,
  SCHEMA,
  SYSTEM_PROMPT,
  DEFAULTS,
};
