import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { ALLOWANCE_ORDER, DEFAULT_ALLOWANCES, STAGE_GROUP, type StageGroup } from './anton-config.js';
import { DEFAULTS } from './config.js';
import type { JobState } from './state.js';

export type Allowances = typeof DEFAULT_ALLOWANCES;

export const usd = (n: number) => `$${n.toFixed(2)}`;

/** The allowance group of a runner stage, or undefined when it has none (P4b-R1: own keys only). */
export function stageGroup(stage: string): StageGroup | undefined {
  return Object.hasOwn(STAGE_GROUP, stage) ? STAGE_GROUP[stage] : undefined;
}

/**
 * A group may borrow what earlier groups left: its limit is the cumulative share up to and including
 * it, and its spend is everything those groups spent.
 */
export function allowanceUsage(s: JobState, group: StageGroup, allowances: Allowances = DEFAULT_ALLOWANCES): { spentUsd: number; limitUsd: number } {
  const upTo = ALLOWANCE_ORDER.slice(0, ALLOWANCE_ORDER.indexOf(group) + 1);
  const pct = upTo.reduce((a, g) => a + allowances[g], 0);
  const spentUsd = upTo.reduce((a, g) => a + (s.stageSpentUsd?.[g] ?? 0), 0);
  return { spentUsd, limitUsd: (s.budgetUsd * pct) / 100 };
}

export function allowanceLeftUsd(s: JobState, group: StageGroup, allowances: Allowances = DEFAULT_ALLOWANCES): number {
  const { spentUsd, limitUsd } = allowanceUsage(s, group, allowances);
  return Math.max(0, limitUsd - spentUsd);
}

/**
 * Old jobs (before stage allowances) have no stageSpentUsd: rebuild it from cost.json, which is keyed
 * by runner stage. cost.json is container-writable, so anything but a finite, non-negative number is dropped.
 */
export function seedStageSpend(s: JobState, costJson: unknown): JobState {
  if (s.stageSpentUsd) return s;
  const stageSpentUsd: Record<string, number> = {};
  if (typeof costJson === 'object' && costJson !== null && !Array.isArray(costJson)) {
    for (const [stage, v] of Object.entries(costJson)) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
      const key = stageGroup(stage) ?? stage;
      stageSpentUsd[key] = (stageSpentUsd[key] ?? 0) + v;
    }
  }
  return { ...s, stageSpentUsd };
}

export function remainingUsd(s: JobState): number {
  return Math.max(0, s.budgetUsd - s.spentUsd);
}

/** Pure: returns the new state. Caller persists it and notifies when `crossedWarn`. */
export function recordCost(
  s: JobState,
  stage: string,
  usd: number,
  allowances: Allowances = DEFAULT_ALLOWANCES,
): { state: JobState; crossedWarn: boolean; overCap: boolean; overAllowance: boolean } {
  const spentUsd = s.spentUsd + usd;
  const crossedWarn = !s.warned80 && spentUsd >= DEFAULTS.warnAt * s.budgetUsd;
  const group = stageGroup(stage);
  const key = group ?? stage;
  const stageSpentUsd = { ...s.stageSpentUsd, [key]: (s.stageSpentUsd?.[key] ?? 0) + usd };
  const state: JobState = { ...s, spentUsd, warned80: s.warned80 || crossedWarn, stageSpentUsd };
  let overAllowance = false;
  if (group) {
    const a = allowanceUsage(state, group, allowances);
    overAllowance = a.spentUsd > a.limitUsd;
  }
  return { state, crossedWarn, overCap: spentUsd > s.budgetUsd, overAllowance };
}

export async function appendStageCost(jobDir: string, stage: string, usd: number): Promise<void> {
  const final = join(jobDir, 'cost.json');
  let costs: Record<string, number> = {};
  try {
    costs = JSON.parse(await fsp.readFile(final, 'utf8')) as Record<string, number>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  costs[stage] = (costs[stage] ?? 0) + usd;
  const tmp = `${final}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(costs, null, 2) + '\n');
  await fsp.rename(tmp, final);
}
