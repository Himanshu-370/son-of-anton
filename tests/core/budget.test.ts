import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendStageCost, recordCost, remainingUsd } from '../../src/core/budget.js';
import type { JobState } from '../../src/core/state.js';

const base = (over: Partial<JobState> = {}): JobState => ({
  jobId: 'j1',
  project: 'p',
  stage: 'build',
  round: 1,
  maxRounds: 3,
  budgetUsd: 10,
  spentUsd: 0,
  warned80: false,
  completedTasks: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('recordCost', () => {
  it('crosses the warn threshold once', () => {
    const a = recordCost(base({ spentUsd: 7.9 }), 'build', 0.2);
    expect(a.crossedWarn).toBe(true);
    expect(a.overCap).toBe(false);
    expect(a.state.warned80).toBe(true);
    expect(a.state.spentUsd).toBeCloseTo(8.1);
    const b = recordCost(a.state, 'build', 0.2);
    expect(b.crossedWarn).toBe(false);
  });

  it('flags overCap only when strictly over budget', () => {
    expect(recordCost(base({ spentUsd: 9.9 }), 'build', 0.2).overCap).toBe(true);
    expect(recordCost(base({ spentUsd: 9.9, warned80: true }), 'build', 0.1).overCap).toBe(false);
  });

  it('does not mutate the input state', () => {
    const s = base();
    recordCost(s, 'build', 1);
    expect(s.spentUsd).toBe(0);
  });
});

describe('remainingUsd', () => {
  it('is never negative', () => {
    expect(remainingUsd(base({ spentUsd: 12 }))).toBe(0);
    expect(remainingUsd(base({ spentUsd: 4 }))).toBe(6);
  });
});

describe('appendStageCost', () => {
  it('accumulates per stage in cost.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'budget-'));
    await appendStageCost(dir, 'plan', 0.1);
    await appendStageCost(dir, 'plan', 0.2);
    await appendStageCost(dir, 'build', 1);
    const c = JSON.parse(await readFile(join(dir, 'cost.json'), 'utf8'));
    expect(c.plan).toBeCloseTo(0.3);
    expect(c.build).toBe(1);
  });
});
