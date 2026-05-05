/**
 * Per-model cost rates and turn cost estimator.
 *
 * Used by the agent_turns telemetry pipeline (T-1778234000000) to
 * compute `est_cost_cents` from the SDK's `usage` event payload.
 *
 * Rates are in **cents per million tokens** (matching the SQLite
 * INTEGER schema downstream — no floating-point accumulation drift).
 *
 * Source: Anthropic public pricing as of early 2026. Cache rates
 * follow Anthropic's documented multipliers (creation = 1.25× input,
 * read = 0.1× input). Update when Anthropic publishes new tiers.
 */

interface ModelCost {
  input: number; // cents per million input tokens
  output: number; // cents per million output tokens
  cache_create: number;
  cache_read: number;
}

const MODEL_COSTS: Record<string, ModelCost> = {
  'claude-opus-4-7': { input: 1500, output: 7500, cache_create: 1875, cache_read: 150 },
  'claude-sonnet-4-6': { input: 300, output: 1500, cache_create: 375, cache_read: 30 },
  'claude-haiku-4-5-20251001': { input: 100, output: 500, cache_create: 125, cache_read: 10 },
  // Older / fallback Haiku
  'claude-haiku-4-5': { input: 100, output: 500, cache_create: 125, cache_read: 10 },
};

/**
 * Estimate cost in cents for a single turn, given token counts.
 * Returns 0 if the model isn't in the rate table — better to under-
 * report than to fabricate. Logs handled by caller (this is a pure
 * computation).
 *
 * `Math.ceil` to err on the side of conservative budget tracking.
 */
export function estimateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number = 0,
  cacheReadTokens: number = 0,
): number {
  const rates = MODEL_COSTS[model];
  if (!rates) return 0;
  const totalCents =
    (rates.input * (inputTokens || 0) +
      rates.output * (outputTokens || 0) +
      rates.cache_create * (cacheCreationTokens || 0) +
      rates.cache_read * (cacheReadTokens || 0)) /
    1_000_000;
  return Math.ceil(totalCents);
}

export function knownModel(model: string): boolean {
  return model in MODEL_COSTS;
}

export function listKnownModels(): string[] {
  return Object.keys(MODEL_COSTS);
}
