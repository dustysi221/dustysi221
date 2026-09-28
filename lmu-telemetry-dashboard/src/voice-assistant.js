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
  async ask(question) {
    const text = typeof question === 'string' ? question.trim().slice(0, MAX_QUESTION_CHARS) : '';
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
        payload: { driver_question: text, live_data: brief },
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
      inPits: vehicle.inPits,
    },
    session: {
      type: session.type,
      phase: session.phase,
      track: session.trackName,
      trackTempC: session.trackTempC,
      raining: session.raining,
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

module.exports = { VoiceAssistant, BusyError, buildVoiceBrief, SCHEMA };
