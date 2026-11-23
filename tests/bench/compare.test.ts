import { describe, expect, it } from 'vitest';
import { compareBench, previousBench } from '../../src/bench/compare.js';
import type { BenchRun } from '../../src/bench/run.js';

const old: BenchRun = {
  runId: 'baseline', at: '2026-01-01', label: 'Before', configHash: 'aaa',
  results: [{ sample: 'same', outcome: 'delivered', checks: 4, firstTryPass: 1, rounds: 1, spentUsd: 1, cacheHitRate: .3 },
    { sample: 'removed', outcome: 'delivered', checks: 1, rounds: 1, spentUsd: 1 }],
};
const current: BenchRun = {
  runId: 'current', at: '2026-01-02', label: 'After', configHash: 'bbb',
  results: [{ sample: 'same', outcome: 'paused: allowance', checks: 3, firstTryPass: .75, rounds: 2, spentUsd: 1.6, cacheHitRate: .5 },
    { sample: 'added', outcome: 'delivered', checks: 1, rounds: 1, spentUsd: 0 }],
};

describe('bench comparison', () => {
  it('explains the first run', () => {
    expect(compareBench(current)).toContain('First bench run; nothing to compare.');
  });

  it('shows both runs, changes, regressions and totals', () => {
    const report = compareBench(current, old);
    for (const value of ['baseline', 'Before', 'aaa', 'current', 'After', 'bbb', '4 → 3 ▼', '30% → 50% ▲',
      '100% → 75% ▼', 'REGRESSION', 'added | new', 'removed | removed', '$2.00 → $1.60', '2 → 1']) {
      expect(report).toContain(value);
    }
  });

  it('chooses the newest older run or the explicitly requested run', () => {
    const earlier = { ...old, runId: 'earlier', at: '2025-12-31' };
    expect(previousBench(current, [earlier, current, old])).toEqual(old);
    expect(previousBench(current, [old, earlier], 'earlier')).toEqual(earlier);
    expect(() => previousBench(current, [old], 'missing')).toThrow('missing');
  });

  it('allows a cost increase of exactly 50 percent', () => {
    const sample = { ...old.results[0]!, spentUsd: 0.30 };
    const baseline = { ...old, results: [sample] };
    expect(compareBench({ ...current, results: [{ ...sample, spentUsd: 0.45 }] }, baseline)).not.toContain('REGRESSION');
    expect(compareBench({ ...current, results: [{ ...sample, spentUsd: 0.46 }] }, baseline)).toContain('REGRESSION');
  });
});
