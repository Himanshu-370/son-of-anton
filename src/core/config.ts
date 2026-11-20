export type Effort = 'low' | 'medium' | 'high';

export interface ModelConfig {
  model: string;
  effort: Effort;
}

export type Role =
  | 'pm'
  | 'tech_lead'
  | 'frontend'
  | 'backend'
  | 'infra'
  | 'qa'
  | 'code_reviewer'
  | 'security_reviewer'
  | 'coach'
  | 'mapper'
  | 'browser_tester';

export type Area = 'frontend' | 'backend' | 'infra';

/** Developers build one at a time, in this order. */
export const AREA_ORDER: Area[] = ['infra', 'backend', 'frontend'];

export const ROLE_MODELS: Record<Role, ModelConfig> = {
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
};

export const DEFAULTS: {
  budgetUsd: number;
  warnAt: number;
  maxRounds: number;
} = {
  budgetUsd: 10,
  warnAt: 0.8,
  maxRounds: 3,
};
