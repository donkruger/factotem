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
  'claude-opus-4-7': {
    input: 1500,
    output: 7500,
    cache_create: 1875,
    cache_read: 150,
  },
  'claude-sonnet-4-6': {
    input: 300,
    output: 1500,
    cache_create: 375,
    cache_read: 30,
  },
  'claude-haiku-4-5-20251001': {
    input: 100,
    output: 500,
    cache_create: 125,
    cache_read: 10,
  },
  // Older / fallback Haiku
  'claude-haiku-4-5': {
    input: 100,
    output: 500,
    cache_create: 125,
    cache_read: 10,
  },
  // Gemini via the OpenAI-compat endpoint. Cache rates are 0 because
  // the compat layer doesn't expose Gemini's native caching. Source:
  // https://ai.google.dev/pricing — re-verify at every release.
  // The OAI container's per-build PRICE_TABLE is the primary source
  // of truth; this fallback covers legacy containers that don't emit
  // `cost_micros` in the OUTPUT envelope. See PROVIDER_PLAYBOOK § 4.1.
  'gemini/gemini-2.5-pro': {
    input: 125,
    output: 500,
    cache_create: 0,
    cache_read: 0,
  },
  'gemini/gemini-2.5-flash': {
    input: 7.5,
    output: 30,
    cache_create: 0,
    cache_read: 0,
  },
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

/**
 * Container OUTPUT-envelope shape we care about for cost. Subset of
 * `ContainerOutput` — duplicated here to avoid an import cycle with
 * `container-runner.ts`. When ContainerOutput's shape changes, this
 * type updates too.
 */
interface CostFromContainerInput {
  cost_micros?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Cost in cents for a single turn.
 *
 * Prefers the container's own `cost_micros` when present and positive
 * — the container reads provider rates from `setup/providers.json` at
 * build time and knows the authoritative price for that turn's exact
 * model. Falls back to the orchestrator's token-derived estimate when
 * the container didn't emit `cost_micros` (legacy `nanoclaw-agent`
 * Claude image; or any new image we add before its build script
 * learns the cost calculation).
 *
 * `Math.round` rather than `Math.ceil` here because the container's
 * `cost_micros` is already precise — rounding up would over-bill.
 * The fallback path keeps `Math.ceil` (via `estimateCostCents`) for
 * conservative budget tracking.
 *
 * See PROVIDER_PLAYBOOK § 4.1 (Container contract — cost_micros) and
 * docs/implementation/multi-agent-completion-blueprint.md § 3.1.
 */
export function costCentsFromContainer(
  output: CostFromContainerInput,
  model: string,
): number {
  if (typeof output.cost_micros === 'number' && output.cost_micros > 0) {
    // 1 cent = 10_000 micro-USD.
    return Math.round(output.cost_micros / 10_000);
  }
  return estimateCostCents(
    model,
    output.usage?.input_tokens ?? 0,
    output.usage?.output_tokens ?? 0,
    output.usage?.cache_creation_input_tokens ?? 0,
    output.usage?.cache_read_input_tokens ?? 0,
  );
}
