import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../../src/core/config.js';

describe('DEFAULTS', () => {
  it('has budget, warn threshold and max rounds', () => {
    expect(DEFAULTS.budgetUsd).toBe(10);
    expect(DEFAULTS.warnAt).toBe(0.8);
    expect(DEFAULTS.maxRounds).toBe(3);
  });

  it('has per-stage models', () => {
    expect(DEFAULTS.models.spec).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    expect(DEFAULTS.models.plan).toEqual({ model: 'claude-opus-5-5', effort: 'medium' });
    expect(DEFAULTS.models.build).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
  });
});
