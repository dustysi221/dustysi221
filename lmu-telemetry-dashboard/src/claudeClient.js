'use strict';

/**
 * Thin wrapper around the Anthropic SDK shared by the analysis modules:
 * structured JSON output, refusal/truncation handling, optional server-side
 * fallbacks, and a running token/cost tally.
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

class ClaudeClient {
  constructor({ apiKey, model = 'claude-opus-5', effort = 'low', useFallbacks = true, logger = console }) {
    this.model = model;
    this.effort = effort;
    this.useFallbacks = useFallbacks;
    this.logger = logger;
    this.totals = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    this.sdk = apiKey ? new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 }) : null;
  }

  get enabled() {
    return this.sdk !== null;
  }

  /**
   * Sends one request whose answer must match `schema`.
   * @param history  earlier turns ({ role, content } plain-text messages) to send before `payload`
   * @param effort   overrides the client's default effort for this call
   * @returns {{ data: object, meta: { model, latencyMs, usage } }}
   */
  async requestJson({ system, payload, schema, maxTokens = 8000, history = [], effort = this.effort }) {
    if (!this.enabled) throw new Error('Claude API key not configured');

    const params = {
      model: this.model,
      max_tokens: maxTokens,
      output_config: { format: { type: 'json_schema', schema } },
      system,
      messages: [
        ...history,
        { role: 'user', content: typeof payload === 'string' ? payload : JSON.stringify(payload) },
      ],
    };
    // Haiku 4.5 has no adaptive thinking or effort setting; it runs without thinking
    if (!this.model.startsWith('claude-haiku')) {
      params.thinking = { type: 'adaptive' };
      params.output_config.effort = effort;
    }

    const started = Date.now();
    const response = await this.#send(params);
    const latencyMs = Date.now() - started;
    const usage = this.#track(response.usage || {});

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
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Claude returned invalid JSON');
    }

    return { data, meta: { model: response.model, latencyMs, usage, totals: this.totalsRounded() } };
  }

  totalsRounded() {
    return { ...this.totals, costUsd: Number(this.totals.costUsd.toFixed(4)) };
  }

  async #send(params) {
    if (!this.useFallbacks) return this.sdk.messages.create(params);
    try {
      // If Claude's safety classifiers decline, the API reruns the request on
      // Anthropic's recommended fallback model instead of returning a refusal.
      return await this.sdk.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' });
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) {
        this.logger.warn(`[claude] fallbacks rejected (${err.message}); continuing without them`);
        this.useFallbacks = false;
        return this.sdk.messages.create(params);
      }
      throw err;
    }
  }

  #track(usage) {
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const [inPrice, outPrice] = PRICING[this.model] || [0, 0];
    const costUsd = (inputTokens * inPrice + outputTokens * outPrice) / 1e6;
    this.totals.requests++;
    this.totals.inputTokens += inputTokens;
    this.totals.outputTokens += outputTokens;
    this.totals.costUsd += costUsd;
    return { inputTokens, outputTokens, costUsd: Number(costUsd.toFixed(4)) };
  }
}

/** Human-readable message for any error thrown by requestJson(). */
function describeClaudeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Invalid Claude API key (check CLAUDE_API_KEY in .env)';
  if (err instanceof Anthropic.RateLimitError) return 'Claude API rate limit hit; will retry next interval';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API (network)';
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err.message;
}

module.exports = { ClaudeClient, describeClaudeError, PRICING };
