import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS } from './config.js';
import type { JobState } from './state.js';

export function remainingUsd(s: JobState): number {
  return Math.max(0, s.budgetUsd - s.spentUsd);
}

/** Pure: returns the new state. Caller persists it and notifies when `crossedWarn`. */
export function recordCost(
  s: JobState,
  _stage: string,
  usd: number,
): { state: JobState; crossedWarn: boolean; overCap: boolean } {
  const spentUsd = s.spentUsd + usd;
  const crossedWarn = !s.warned80 && spentUsd >= DEFAULTS.warnAt * s.budgetUsd;
  const state: JobState = { ...s, spentUsd, warned80: s.warned80 || crossedWarn };
  return { state, crossedWarn, overCap: spentUsd > s.budgetUsd };
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
