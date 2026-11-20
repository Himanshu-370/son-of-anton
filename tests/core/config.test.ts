import { describe, expect, it } from 'vitest';
import { AREA_ORDER, DEFAULTS, ROLE_MODELS } from '../../src/core/config.js';

describe('DEFAULTS', () => {
  it('has budget, warn threshold and max rounds', () => {
    expect(DEFAULTS.budgetUsd).toBe(10);
    expect(DEFAULTS.warnAt).toBe(0.8);
    expect(DEFAULTS.maxRounds).toBe(3);
  });
});

describe('ROLE_MODELS', () => {
  it('matches the role table for all 11 roles', () => {
    expect(ROLE_MODELS).toEqual({
      pm: { model: 'claude-opus-5-5', effort: 'high' },
      tech_lead: { model: 'claude-opus-5-5', effort: 'medium' },
      frontend: { model: 'claude-sonnet-5-5', effort: 'medium' },
      backend: { model: 'claude-sonnet-5-5', effort: 'medium' },
      infra: { model: 'claude-sonnet-5-5', effort: 'medium' },
      qa: { model: 'claude-sonnet-5-5', effort: 'medium' },
      code_reviewer: { model: 'claude-sonnet-5-5', effort: 'medium' },
      security_reviewer: { model: 'claude-sonnet-5-5', effort: 'high' },
      coach: { model: 'claude-haiku-5-5', effort: 'low' },
      mapper: { model: 'claude-sonnet-5-5', effort: 'low' },
      browser_tester: { model: 'claude-sonnet-5-5', effort: 'medium' },
    });
  });
});

describe('AREA_ORDER', () => {
  it('builds infra, then backend, then frontend', () => {
    expect(AREA_ORDER).toEqual(['infra', 'backend', 'frontend']);
  });
});
