/**
 * Interim cost estimate for in-flight agent calls (ruling R6). The SDK reports USD only on its final
 * result message, and that total stays authoritative. These estimates exist only so the host can warn
 * or kill on budget mid-call.
 *
 * KEEP IN SYNC: update this table whenever Anthropic's prices change or new models are used.
 * Prices are USD per million tokens. Cache reads cost 0.1x input and cache writes 1.25x input.
 */
export type ModelPrice = { inPerM: number; outPerM: number };

export const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { inPerM: 4, outPerM: 20 },
  'claude-sonnet-5-5': { inPerM: 2, outPerM: 10 },
  'claude-haiku-5-5': { inPerM: 0.1, outPerM: 0.5 },
};

/** Unknown models are priced as opus (conservative). */
const FALLBACK = PRICES['claude-opus-5-5'];
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

export type TokenUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/** Exact match, else the longest table key the id starts with (dated ids), else opus. */
export function priceFor(model: string | undefined): ModelPrice {
  if (!model) return FALLBACK;
  if (PRICES[model]) return PRICES[model];
  const key = Object.keys(PRICES)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICES[key] : FALLBACK;
}

export function estimateUsd(model: string | undefined, u: TokenUsage): number {
  const p = priceFor(model);
  const n = (x: number | null | undefined) => x ?? 0;
  return (
    (n(u.input_tokens) * p.inPerM +
      n(u.output_tokens) * p.outPerM +
      n(u.cache_read_input_tokens) * p.inPerM * CACHE_READ_MULT +
      n(u.cache_creation_input_tokens) * p.inPerM * CACHE_WRITE_MULT) /
    1_000_000
  );
}
