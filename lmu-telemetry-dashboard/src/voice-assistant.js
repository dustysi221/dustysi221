'use strict';

/**
 * Answers push-to-talk questions from the driver ("How are my tires looking?")
 * as the race engineer. Each question is sent to Claude together with a compact
 * brief of live telemetry, tire and fuel numbers, rival gaps and the latest
 * tire/strategy calls. The answer is short enough to be spoken over the radio.
 */

const { computeTireMetrics } = require('./tire-analyzer');
const { computeStrategyMetrics } = require('./strategy-analyzer');
const { limitWords } = require('./brevity');
const { SYSTEM_PROMPT, MAX_REPLY_WORDS, HISTORY_TURNS } = require('./voice-prompts');
const { WHEEL_KEYS } = require('./telemetryParser');

const MAX_QUESTION_CHARS = 500;

const SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string' } },
  required: ['reply'],
  additionalProperties: false,
};

class BusyError extends Error {}

class VoiceAssistant {
  /**
   * @param {object} opts
   * @param {import('./claudeClient').ClaudeClient} opts.client
   * @param {() => object} opts.getContext  returns { snapshot, field, tireHistory, tracker, tireAnalysis, strategy, tireOptions, strategyOptions }
   * @param {string} [opts.effort]  Claude effort for voice replies (low keeps them quick)
   */
  constructor({ client, getContext, effort = 'low' }) {
    this.client = client;
    this.getContext = getContext;
    this.effort = effort;
    this.inFlight = false;
    this.history = []; // [{ question, reply }]
  }

  get enabled() {
    return Boolean(this.client && this.client.enabled);
  }

  /**
   * @param {string} question  what the driver said
   * @returns {{ question, reply, lap, createdAt, model, latencyMs, usage, totals }}
   */
  /**
   * @param {string} question  what speech recognition heard (best guess)
   * @param {{alternatives?: string[]}} [opts]  other guesses from speech recognition
   */
  async ask(question, { alternatives = [] } = {}) {
    const text = typeof question === 'string' ? question.trim().slice(0, MAX_QUESTION_CHARS) : '';
    const others = (Array.isArray(alternatives) ? alternatives : [])
      .filter((a) => typeof a === 'string' && a.trim() && a.trim() !== text)
      .map((a) => a.trim().slice(0, MAX_QUESTION_CHARS))
      .slice(0, 3);
    if (!text) throw new Error('Empty question');
    if (!this.enabled) throw new Error('Claude is off: add CLAUDE_API_KEY to .env to use the voice engineer');
    if (this.inFlight) throw new BusyError('Still answering your last question');

    this.inFlight = true;
    try {
      const ctx = this.getContext();
      const brief = buildVoiceBrief(ctx);
      const history = this.history.slice(-HISTORY_TURNS).flatMap((t) => [
        { role: 'user', content: `Driver: ${t.question}` },
        { role: 'assistant', content: JSON.stringify({ reply: t.reply }) },
      ]);

      const { data, meta } = await this.client.requestJson({
        system: SYSTEM_PROMPT,
        payload: {
          driver_question: text,
          ...(others.length ? { other_possible_hearings: others } : {}),
          live_data: brief,
        },
        schema: SCHEMA,
        history,
        effort: this.effort,
        maxTokens: 4000,
      });

      const reply = limitWords(typeof data.reply === 'string' ? data.reply : '', MAX_REPLY_WORDS) || 'Say again?';
      this.history.push({ question: text, reply });
      if (this.history.length > HISTORY_TURNS * 2) this.history.shift();

      return {
        question: text,
        reply,
        lap: brief.car ? brief.car.lap : null,
        createdAt: new Date().toISOString(),
        ...meta,
      };
    } finally {
      this.inFlight = false;
    }
  }

  /** Forget earlier questions (e.g. new session). */
  resetHistory() {
    this.history = [];
  }
}


const MAX_STANDINGS = 30;
const r3 = (n) => (Number.isFinite(n) ? Number(n.toFixed(3)) : null);

/**
 * Leaderboard for questions like "what's P1 doing?": every car's position,
 * class position, lap times and gaps, plus the fastest lap in each class.
 * Big grids are trimmed to the overall top 10, the top 10 of your class and
 * the cars around you.
 */
function buildStandings(field, tracker) {
  if (!field.length) return null;
  const me = field.find((c) => c.isPlayer) || null;
  const byPos = [...field].sort((a, b) => a.position - b.position);

  const classPos = new Map();
  const classCount = {};
  for (const c of byPos) {
    classCount[c.class] = (classCount[c.class] || 0) + 1;
    classPos.set(c.id, classCount[c.class]);
  }

  let cars = byPos;
  if (byPos.length > MAX_STANDINGS && me) {
    const keep = new Set();
    byPos.slice(0, 10).forEach((c) => keep.add(c.id));
    byPos.filter((c) => c.class === me.class).slice(0, 10).forEach((c) => keep.add(c.id));
    byPos.filter((c) => Math.abs(c.position - me.position) <= 3).forEach((c) => keep.add(c.id));
    cars = byPos.filter((c) => keep.has(c.id));
  }

  const leader = byPos[0];
  const classBest = {};
  for (const c of field) {
    if (!(c.bestLapSec > 0)) continue;
    const best = classBest[c.class];
    if (!best || c.bestLapSec < best.bestLapSec) {
      classBest[c.class] = { car: c.vehicle, driver: c.driver, bestLapSec: r3(c.bestLapSec), you: c.isPlayer || undefined };
    }
  }

  return {
    totalCars: field.length,
    note: 'pos = overall position, classPos = position in class. gapToLeaderSec is to the overall leader; lapsDown > 0 means laps behind the leader.',
    classBest,
    cars: cars.map((c) => ({
      pos: c.position,
      classPos: classPos.get(c.id),
      class: c.class,
      car: c.vehicle,
      driver: c.driver,
      you: c.isPlayer || undefined,
      lastLapSec: r3(c.lastLapSec),
      bestLapSec: r3(c.bestLapSec),
      avgPaceSec: tracker ? r3(tracker.competitorPace(c.id)) : null,
      gapToLeaderSec: c.id === leader.id ? 0 : r3(c.timeBehindLeaderSec),
      lapsDown: c.lapsBehindLeader || 0,
      pitStops: c.pitStops,
      inPits: c.inPits || undefined,
    })),
  };
}

/** Track status for the engineer: which flag is out and which cars are slow. */
function flagBrief(flags, field) {
  if (!flags) return null;
  const names = new Map((field || []).map((c) => [c.id, c.vehicle]));
  return {
    status: flags.state, // green | localYellow | fcy | safetyCar | fullCourse | other
    yellowSectors: flags.sectorYellow.map((on, i) => (on ? i + 1 : null)).filter(Boolean),
    fullCourseStage: flags.yellowState,
    safetyCarOut: flags.state === 'safetyCar' ? true : flags.rulesAvailable ? false : null,
    slowCars: flags.slowCars.map((id) => names.get(id) || id),
  };
}

/** Compact live-data brief for a voice question. Works with partial or no telemetry. */
function buildVoiceBrief(ctx = {}) {
  const { snapshot, field, tireHistory, tracker, tireAnalysis, strategy } = ctx;
  if (!snapshot) {
    return { note: 'No live telemetry: the car is not on track or the game is not running.' };
  }
  const { vehicle, session } = snapshot;

  const tireMetrics = computeTireMetrics(snapshot, tireHistory ? tireHistory.summary() : {}, ctx.tireOptions);
  let strat = null;
  if (tracker) {
    try {
      strat = computeStrategyMetrics({ ...snapshot, field: field || [] }, tracker, ctx.strategyOptions);
    } catch {
      strat = null; // not enough history yet
    }
  }

  const tires = {};
  for (const k of WHEEL_KEYS) {
    const t = tireMetrics.tires[k];
    tires[k] = {
      tempsC: { inner: t.innerC, middle: t.middleC, outer: t.outerC },
      state: t.windowState,
      pressurePsi: t.pressurePsi,
      wearPercent: t.wearPercent,
      wearPerLap: t.wearPerLap,
      lapsToWearLimit: t.lapsToWearLimit,
      flat: t.flat || undefined,
    };
  }

  const location = vehicle.inGarage ? 'garage' : vehicle.inPits ? 'pit lane' : 'on track';
  const damage = snapshot.damage || null;

  const rival = (c) =>
    c ? { car: c.car, gapSec: c.gapSec, paceDeltaSecPerLap: c.paceDeltaSecPerLap, inPits: c.inPits } : null;

  return {
    car: {
      name: vehicle.name,
      class: vehicle.class,
      lap: vehicle.lap,
      position: vehicle.position,
      classPosition: vehicle.classPosition,
      speedKph: vehicle.speedKph,
      rpm: vehicle.rpm,
      gear: vehicle.gear,
      fuelL: vehicle.fuelL,
      lastLapSec: vehicle.lastLapSec,
      bestLapSec: vehicle.bestLapSec,
      frontCompound: vehicle.frontCompound,
      rearCompound: vehicle.rearCompound,
      location,
      stopped: Number.isFinite(vehicle.speedKph) ? vehicle.speedKph < 5 : null,
    },
    damage,
    session: {
      type: session.type,
      phase: session.phase,
      track: session.trackName,
      trackTempC: session.trackTempC,
      airTempC: session.ambientTempC,
      raining: session.raining,
      trackWetness: session.avgPathWetness,
      flags: flagBrief(snapshot.flags, field),
    },
    tires,
    tireBalance: {
      frontMinusRearC: tireMetrics.balance.frontMinusRearC,
      leftMinusRightC: tireMetrics.balance.leftMinusRightC,
    },
    fuel: strat
      ? {
          perLapL: strat.fuel.perLapL,
          lapsOfFuel: strat.fuel.lapsOfFuel,
          fuelToFinishL: strat.fuel.fuelToFinishL,
          shortfallL: strat.fuel.shortfallL,
          lastLapToPitForFuel: strat.fuel.lastLapToPitForFuel,
          stopsNeededForFuel: strat.fuel.stopsNeededForFuel,
        }
      : null,
    race: strat
      ? {
          lapsRemaining: strat.race.lapsRemaining,
          timeRemainingSec: strat.race.timeRemainingSec,
          lapsInStint: strat.stint.lapsInStint,
          pitStopsSoFar: strat.stint.pitStopsSoFar,
          stintDegradationSecPerLap: strat.pace.stintDegradationSecPerLap,
        }
      : null,
    rivals: strat && strat.competitors
      ? { ahead: rival(strat.competitors.ahead), behind: rival(strat.competitors.behind) }
      : null,
    standings: buildStandings(field || [], tracker),
    latest_calls: {
      tire_engineer: tireAnalysis
        ? {
            lap: tireAnalysis.lap,
            health: tireAnalysis.tire_health,
            radio: tireAnalysis.radio,
            pressure_adjustment: tireAnalysis.pressure_adjustment,
            pit_window: tireAnalysis.pit_window,
          }
        : null,
      strategist: strategy
        ? {
            lap: strategy.lap,
            radio: strategy.radio,
            service: strategy.service,
            pit_lap: strategy.pit_lap,
            confidence: strategy.confidence,
          }
        : null,
    },
  };
}

module.exports = { VoiceAssistant, BusyError, buildVoiceBrief, buildStandings, SCHEMA };
