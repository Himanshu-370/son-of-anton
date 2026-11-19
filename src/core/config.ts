export type Effort = 'low' | 'medium' | 'high';
export type Stage = 'spec' | 'plan' | 'build';

export interface ModelConfig {
  model: string;
  effort: Effort;
}

export const DEFAULTS: {
  budgetUsd: number;
  warnAt: number;
  maxRounds: number;
  models: Record<Stage, ModelConfig>;
} = {
  budgetUsd: 10,
  warnAt: 0.8,
  maxRounds: 3,
  models: {
    spec: { model: 'claude-opus-5-5', effort: 'high' },
    plan: { model: 'claude-opus-5-5', effort: 'medium' },
    build: { model: 'claude-sonnet-5-5', effort: 'medium' },
  },
};
