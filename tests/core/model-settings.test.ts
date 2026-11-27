import { describe, expect, it } from 'vitest';
import { AntonConfigSchema } from '../../src/core/anton-config.js';
import { ROLE_MODELS, type Role } from '../../src/core/config.js';
import { resolveModel } from '../../src/core/model-settings.js';

const haiku = { model: 'claude-haiku-5-5', effort: 'medium' } as const;
const sonnet = 'claude-sonnet-5-5';
const opus = 'claude-opus-5-5';
const roles = Object.keys(ROLE_MODELS) as Role[];

describe('model settings', () => {
  it('uses balanced defaults and preserves effort across presets for all roles', () => {
    const economy = [sonnet, sonnet, sonnet, sonnet, sonnet, sonnet, sonnet, sonnet, haiku.model, sonnet, sonnet, sonnet];
    const best = [opus, opus, sonnet, sonnet, sonnet, sonnet, opus, opus, sonnet, opus, sonnet, opus];
    expect(roles.map((role) => resolveModel({}, role))).toEqual(Object.values(ROLE_MODELS));
    for (const [preset, models] of [['economy', economy], ['best', best]] as const) {
      expect(roles.map((role) => resolveModel({ models: { preset } }, role))).toEqual(
        roles.map((role, i) => ({ ...ROLE_MODELS[role], model: models[i] })),
      );
    }
  });

  it('applies a trial only to its role and keeps preset effort when an override omits it', () => {
    const cfg = AntonConfigSchema.parse({ models: {
      preset: 'best',
      roles: { qa: { ...haiku, effort: 'high' }, mapper: { model: haiku.model } },
      trial: { ...haiku, role: 'qa', jobsLeft: 3, revertTo: { ...haiku, effort: 'high' } },
    } });
    expect(resolveModel(cfg, 'qa')).toEqual(haiku);
    expect(resolveModel(cfg, 'mapper')).toEqual({ model: haiku.model, effort: 'low' });
    expect(resolveModel(cfg, 'code_reviewer')).toEqual({ model: opus, effort: 'medium' });
    expect(resolveModel({ models: { ...cfg.models, trial: undefined } }, 'qa')).toEqual({ ...haiku, effort: 'high' });
  });

  it.each([
    { preset: 'fast' },
    { roles: { developers: haiku } },
    { roles: { qa: { model: 'toString' } } },
    { roles: { qa: { effort: 'max' } } },
    { trial: { ...haiku, role: 'qa', jobsLeft: 0, revertTo: haiku } },
    { trial: { ...haiku, role: 'qa', jobsLeft: 3, revertTo: { ...haiku, model: 'unknown' } } },
  ])('rejects invalid model configuration %j', (models) => {
    expect(AntonConfigSchema.safeParse({ models }).success).toBe(false);
  });
});
