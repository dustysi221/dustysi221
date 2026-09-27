'use strict';

/**
 * Periodic tire analysis with the Claude API. Every tick it sends the latest
 * tire snapshot plus 1 Hz trends and per-lap wear, and gets back a structured
 * JSON verdict the dashboard can render directly.
 *
 * Guards against runaway cost/latency:
 *  - only one request in flight at a time (a slow response skips ticks)
 *  - ticks are skipped when no dashboard is connected or the car isn't live
 */

const Anthropic = require('@anthropic-ai/sdk');

// USD per million tokens (input, output) for the running cost estimate.
const PRICING = {
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
};

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const TIRE_STATUS = { type: 'string', enum: ['good', 'watch', 'critical'] };
const TIRE_VERDICT = {
  type: 'object',
  properties: {
    status: TIRE_STATUS,
    note: { type: 'string', description: 'Max ~12 words about this tire.' },
  },
  required: ['status', 'note'],
  additionalProperties: false,
};

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    overallStatus: TIRE_STATUS,
    summary: { type: 'string', description: 'One sentence a driver can read at a glance.' },
    tires: {
      type: 'object',
      properties: { FL: TIRE_VERDICT, FR: TIRE_VERDICT, RL: TIRE_VERDICT, RR: TIRE_VERDICT },
      required: ['FL', 'FR', 'RL', 'RR'],
      additionalProperties: false,
    },
    recommendations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 3 short, actionable items, most important first.',
    },
    estimatedLapsRemaining: {
      anyOf: [{ type: 'integer' }, { type: 'null' }],
      description: 'Laps until the most-worn tire needs changing; null if not enough data.',
    },
  },
  required: ['overallStatus', 'summary', 'tires', 'recommendations', 'estimatedLapsRemaining'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a race engineer specializing in tires, watching live telemetry from Le Mans Ultimate (rFactor 2 physics) during a session.

You receive JSON with the current tire state and recent history:
- temps are tread surface temperatures in °C split into inner/middle/outer edges; carcassTempC is the tire core
- pressureKpa is the current hot pressure
- wearPercent is tread worn so far (0 = new, 100 = fully worn)
- history.avgWearPerLapLast3 is wear % per lap for each tire; history.trendLast60s shows how temps, pressures and wear moved in the last minute

How to judge:
- Use the operating windows typical for the car's class and compound in LMU; if you are unsure of the exact window, judge by balance and trends instead of inventing numbers.
- Inner vs outer edge spread points at camber; middle vs edges points at pressure (hot middle = over-inflated, cold middle = under-inflated).
- Compare front vs rear and left vs right to spot balance issues (understeer/oversteer, track-specific loading).
- estimatedLapsRemaining: laps until the most-worn tire reaches about 70% wear at the current per-lap rate; null if no completed laps yet.
- Early in a stint (tires still warming, fewer than 2 laps) keep the verdict provisional and say so.

The driver glances at this on a second monitor while racing, so be brief and concrete. No preamble.`;

class ClaudeAnalyzer {
  constructor({ apiKey, model, effort, useFallbacks = true, logger = console }) {
    this.model = model;
    this.effort = effort;
    this.useFallbacks = useFallbacks;
    this.logger = logger;
    this.inFlight = false;
    this.totals = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.client = apiKey ? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 }) : null;
  }

  get enabled() {
    return this.client !== null;
  }

  /**
   * @param {object} context { snapshot, history }
   * @returns analysis object, or null if skipped because a request is running
   */
  async analyze(context) {
    if (!this.enabled || this.inFlight) return null;
    this.inFlight = true;
    const started = Date.now();
    try {
      const response = await this.#request(context);
      return this.#toAnalysis(response, context, Date.now() - started);
    } finally {
      this.inFlight = false;
    }
  }

  async #request(context) {
    const params = {
      model: this.model,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: this.effort,
        format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(buildPromptPayload(context)) }],
    };

    if (!this.useFallbacks) return this.client.messages.create(params);

    try {
      // If Claude's safety classifiers decline, the API reruns the request on
      // Anthropic's recommended fallback model instead of returning a refusal.
      return await this.client.beta.messages.create({
        ...params,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      });
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) {
        this.logger.warn(`[claude] fallbacks rejected (${err.message}); continuing without them`);
        this.useFallbacks = false;
        return this.client.messages.create(params);
      }
      throw err;
    }
  }

  #toAnalysis(response, context, latencyMs) {
    const usage = response.usage || {};
    const [inPrice, outPrice] = PRICING[this.model] || [0, 0];
    const costUsd = ((usage.input_tokens || 0) * inPrice + (usage.output_tokens || 0) * outPrice) / 1e6;
    this.totals.requests++;
    this.totals.inputTokens += usage.input_tokens || 0;
    this.totals.outputTokens += usage.output_tokens || 0;
    this.totals.costUsd += costUsd;

    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude declined the request (${response.stop_details?.category ?? 'no category'})`);
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('Claude response was cut off (max_tokens)');
    }

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      throw new Error('Claude returned invalid JSON');
    }

    return {
      ...result,
      createdAt: new Date().toISOString(),
      model: response.model,
      latencyMs,
      basedOn: {
        lap: context.snapshot.vehicle.lap,
        sessionElapsedSec: context.snapshot.session.elapsedSec,
      },
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        costUsd: Number(costUsd.toFixed(4)),
      },
      totals: { ...this.totals, costUsd: Number(this.totals.costUsd.toFixed(4)) },
    };
  }
}

/** The data Claude sees: tires, a little car/session context, and history. */
function buildPromptPayload({ snapshot, history }) {
  const { session, vehicle, tires } = snapshot;
  return {
    session: {
      track: session.trackName,
      type: session.type,
      phase: session.phase,
      ambientTempC: session.ambientTempC,
      trackTempC: session.trackTempC,
      raining: session.raining,
    },
    car: {
      name: vehicle.name,
      class: vehicle.class,
      lap: vehicle.lap,
      frontCompound: vehicle.frontCompound,
      rearCompound: vehicle.rearCompound,
      lastLapSec: vehicle.lastLapSec,
      bestLapSec: vehicle.bestLapSec,
      inPits: vehicle.inPits,
    },
    tires: Object.fromEntries(
      Object.entries(tires).map(([k, t]) => [
        k,
        {
          temps: t.temps,
          carcassTempC: t.carcassTempC,
          pressureKpa: t.pressureKpa,
          wearPercent: t.wearPercent,
          brakeTempC: t.brakeTempC,
          flat: t.flat,
        },
      ]),
    ),
    history,
  };
}

module.exports = { ClaudeAnalyzer, buildPromptPayload, ANALYSIS_SCHEMA };
