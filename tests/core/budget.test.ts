import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowanceLeftUsd, appendStageCost, recordCost, remainingUsd, seedStageSpend } from '../../src/core/budget.js';
import { DEFAULT_ALLOWANCES } from '../../src/core/anton-config.js';
import { JobStateSchema, type JobState } from '../../src/core/state.js';

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

  it('never writes through a planted cost.json.tmp symlink (C2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'budget-'));
    const outside = join(await mkdtemp(join(tmpdir(), 'budget-out-')), 'victim');
    await writeFile(outside, 'keep me\n');
    await symlink(outside, join(dir, 'cost.json.tmp'));
    await appendStageCost(dir, 'plan', 0.5);
    expect(await readFile(outside, 'utf8')).toBe('keep me\n');
    expect(JSON.parse(await readFile(join(dir, 'cost.json'), 'utf8'))).toEqual({ plan: 0.5 });
  });

  it('a symlinked cost.json is not read; it is replaced by a regular file (C2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'budget-'));
    const outside = join(await mkdtemp(join(tmpdir(), 'budget-out-')), 'victim');
    await writeFile(outside, '{"plan": 100}');
    await symlink(outside, join(dir, 'cost.json'));
    await appendStageCost(dir, 'plan', 0.5);
    expect(await readFile(outside, 'utf8')).toBe('{"plan": 100}');
    expect(JSON.parse(await readFile(join(dir, 'cost.json'), 'utf8'))).toEqual({ plan: 0.5 });
  });

  it('corrupt cost.json starts from {}; bad entries are dropped (C2, I5)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'budget-'));
    await writeFile(join(dir, 'cost.json'), 'not json');
    await appendStageCost(dir, 'plan', 0.5);
    expect(JSON.parse(await readFile(join(dir, 'cost.json'), 'utf8'))).toEqual({ plan: 0.5 });
    await writeFile(join(dir, 'cost.json'), '{"build": "lots", "qa": -1, "verify": 1, "plan": [1]}');
    await appendStageCost(dir, 'plan', 0.5);
    expect(JSON.parse(await readFile(join(dir, 'cost.json'), 'utf8'))).toEqual({ verify: 1, plan: 0.5 });
  });
});

describe('stage allowances', () => {
  const A = DEFAULT_ALLOWANCES;

  it('allowance borrows unused earlier shares', () => {
    // $10 cap: spec 10% + plan 10% + build 50% = $7.00 cumulative for build.
    const s = base({ spentUsd: 1.2, stageSpentUsd: { spec: 0.5, plan: 0.2, build: 0.5 } });
    expect(allowanceLeftUsd(s, 'build', A)).toBeCloseTo(7 - (0.5 + 0.2 + 0.5));
    expect(allowanceLeftUsd(s, 'plan', A)).toBeCloseTo(2 - 0.7);
  });

  it('verify spend does not count against build', () => {
    const s = base({ stageSpentUsd: { spec: 1, plan: 1, build: 3, verify: 2 } });
    expect(allowanceLeftUsd(s, 'build', A)).toBeCloseTo(2);
    expect(allowanceLeftUsd(s, 'verify', A)).toBeCloseTo(9.5 - 7);
  });

  it('build round 2 limit after a verify round', () => {
    let s = base({ stageSpentUsd: {} });
    s = recordCost(s, 'build', 3, A).state;
    s = recordCost(s, 'verify', 1.5, A).state;
    s = recordCost(s, 'deliver', 0.2, A).state;
    expect(s.stageSpentUsd).toEqual({ build: 3, verify: 1.7 });
    expect(allowanceLeftUsd(s, 'build', A)).toBeCloseTo(4);
  });

  it('is floored at 0 and recordCost flags overAllowance when strictly over', () => {
    const s = base({ stageSpentUsd: { spec: 1, plan: 1 } });
    expect(allowanceLeftUsd(s, 'plan', A)).toBe(0);
    expect(recordCost(s, 'baseline', 0.01, A).overAllowance).toBe(true);
    expect(recordCost(base({ stageSpentUsd: { plan: 1.9 } }), 'plan', 0.1, A).overAllowance).toBe(false);
  });

  it('a stage outside STAGE_GROUP (and inherited keys) is stored by name and never over allowance (P4b-R1)', () => {
    const s = base({ stageSpentUsd: { spec: 5, plan: 5 } });
    const r = recordCost(s, 'plugin-review', 1, A);
    expect(r.overAllowance).toBe(false);
    expect(r.state.stageSpentUsd).toEqual({ spec: 5, plan: 5, 'plugin-review': 1 });
    expect(recordCost(base(), 'constructor', 1, A).state.stageSpentUsd).toEqual({ constructor: 1 });
  });

  it('built-in key names in cost.json or stage names never read inherited values', () => {
    const cost = JSON.parse('{"constructor":1,"__proto__":2,"toString":"x","build":1.5}');
    const seeded = seedStageSpend(base(), cost);
    expect(seeded.stageSpentUsd).toEqual({ build: 1.5 });
    expect(Object.getPrototypeOf(seeded.stageSpentUsd)).toBe(Object.prototype);
    // Recording on a state that already has stageSpentUsd, under a built-in stage name, stays valid JSON state.
    const r = recordCost(recordCost(seeded, 'constructor', 1, A).state, 'build', 0.5, A);
    expect(r.state.stageSpentUsd).toEqual({ build: 2, constructor: 1 });
    expect(() => JobStateSchema.parse(r.state)).not.toThrow();
    expect(seedStageSpend(r.state, cost)).toBe(r.state);
  });

  it('spec overspend counts only up to its share for later groups (P4b-R2)', () => {
    const s = base({ spentUsd: 3, stageSpentUsd: { spec: 3 } });
    expect(allowanceLeftUsd(s, 'plan', A)).toBeCloseTo(1);
    expect(remainingUsd(s)).toBeCloseTo(7);
    expect(allowanceLeftUsd(s, 'spec', A)).toBe(0);
  });

  it('old state without stageSpentUsd is seeded from cost.json', () => {
    const s = seedStageSpend(base({ spentUsd: 3 }), { spec: 0.5, plan: 0.25, baseline: 0.25, build: 1.5, deliver: 0.5, verify: -1, retro: 'y', 'plugin-review': 1 });
    expect(s.stageSpentUsd).toEqual({ spec: 0.5, plan: 0.5, build: 1.5, verify: 0.5 });
    // Already seeded or corrupt input: left alone / empty.
    expect(seedStageSpend(s, { build: 9 }).stageSpentUsd).toBe(s.stageSpentUsd);
    expect(seedStageSpend(base(), 'junk').stageSpentUsd).toEqual({});
  });
});
