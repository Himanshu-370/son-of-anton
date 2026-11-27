import type { AntonConfig } from './anton-config.js';
import { ROLE_MODELS, type ModelConfig, type Role } from './config.js';

type Preset = NonNullable<NonNullable<AntonConfig['models']>['preset']>;

const presetModels: Record<Preset, Partial<Record<Role, string>>> = {
  balanced: {},
  economy: {
    pm: ROLE_MODELS.qa.model,
    tech_lead: ROLE_MODELS.qa.model,
  },
  best: {
    code_reviewer: ROLE_MODELS.pm.model,
    security_reviewer: ROLE_MODELS.pm.model,
    plugin_reviewer: ROLE_MODELS.pm.model,
    mapper: ROLE_MODELS.pm.model,
    coach: ROLE_MODELS.qa.model,
  },
};

export function resolveModel(cfg: AntonConfig, role: Role): ModelConfig {
  const settings = cfg.models;
  const trial = settings?.trial;
  if (trial?.role === role) return { model: trial.model, effort: trial.effort };

  const defaults = ROLE_MODELS[role];
  const override = settings?.roles?.[role];
  return {
    model: override?.model ?? presetModels[settings?.preset ?? 'balanced'][role] ?? defaults.model,
    effort: override?.effort ?? defaults.effort,
  };
}
