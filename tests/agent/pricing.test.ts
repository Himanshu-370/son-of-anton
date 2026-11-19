import { describe, it, expect } from 'vitest';
import { estimateUsd, priceFor } from '../../src/agent/pricing.js';

describe('pricing', () => {
  it('uses the per-model table with cache multipliers', () => {
    expect(priceFor('claude-sonnet-5-5')).toEqual({ inPerM: 2, outPerM: 10 });
    const usd = estimateUsd('claude-sonnet-5-5', {
      input_tokens: 1_000_000, output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(2 + 10 + 0.2 + 2.5, 10);
  });

  it('matches dated model ids by prefix and falls back to opus prices for unknown models', () => {
    expect(priceFor('claude-haiku-5-5-20261001')).toEqual({ inPerM: 0.1, outPerM: 0.5 });
    expect(priceFor('something-else')).toEqual({ inPerM: 4, outPerM: 20 });
    expect(priceFor(undefined)).toEqual({ inPerM: 4, outPerM: 20 });
  });

  it('treats missing or null cache fields as zero', () => {
    expect(estimateUsd('claude-opus-5-5', { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: null })).toBeCloseTo(0.004, 10);
  });
});
