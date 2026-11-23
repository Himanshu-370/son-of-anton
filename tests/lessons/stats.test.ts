import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../../src/core/history.js';
import { lessonStats, runSummary } from '../../src/lessons/stats.js';

const run = (i: number, o: Partial<HistoryEntry> = {}): HistoryEntry => ({
  jobId: `j${i}`, project: 'p', kind: 'new', kit: 'web', checks: 3, spentUsd: 1, stageUsd: {},
  at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`, ...o,
});
const L = { id: 'L-aaaaaaaa', text: 'x' };
const files = { web: [L] };
// n runs with the lesson, m without.
const mix = (n: number, m: number, w: Partial<HistoryEntry>, o: Partial<HistoryEntry>) => [
  ...Array.from({ length: n }, (_, i) => run(i, { lessons: [L.id], ...w })),
  ...Array.from({ length: m }, (_, i) => run(n + i, { lessons: [], ...o })),
];

describe('lessonStats', () => {
  it('means with and without a lesson', () => {
    const [s] = lessonStats(mix(2, 2, { spentUsd: 1, rounds: 1 }, { spentUsd: 3, rounds: 3 }), files);
    expect(s.withRuns).toBe(2);
    expect(s.with.costUsd).toBe(1);
    expect(s.without.costUsd).toBe(3);
    expect(s.without.rounds).toBe(3);
  });

  it('kit lesson compares only same-kit jobs', () => {
    const h = [...mix(1, 1, {}, {}), run(5, { kit: 'fallback', lessons: [L.id] }), run(6, { kit: 'fallback', lessons: [] })];
    const [s] = lessonStats(h, files);
    expect(s.withRuns).toBe(1);
    expect(s.withoutRuns).toBe(1);
  });

  it('not enough runs below 5 with / 3 without', () => {
    expect(lessonStats(mix(4, 3, { spentUsd: 1 }, { spentUsd: 9 }), files)[0].verdict).toBe('not_enough_runs');
    expect(lessonStats(mix(5, 2, { spentUsd: 1 }, { spentUsd: 9 }), files)[0].verdict).toBe('not_enough_runs');
  });

  it('runs without a lessons field are excluded', () => {
    const h = [...mix(5, 3, {}, {}), run(20), run(21)];
    expect(lessonStats(h, files)[0].withoutRuns).toBe(3);
  });

  it('no benefit when nothing improves', () => {
    const s = lessonStats(mix(5, 3, { firstTryPass: 0.5, rounds: 3, spentUsd: 2 }, { firstTryPass: 0.5, rounds: 3, spentUsd: 2 }), files)[0];
    expect(s.verdict).toBe('no_benefit');
  });

  it('ok when any metric improves', () => {
    const s = lessonStats(mix(5, 3, { firstTryPass: 0.9, rounds: 3, spentUsd: 2 }, { firstTryPass: 0.5, rounds: 3, spentUsd: 2 }), files)[0];
    expect(s.verdict).toBe('ok');
  });

  it('missing metrics are skipped, not zero', () => {
    const h = [run(0, { lessons: [L.id], rounds: 4 }), run(1, { lessons: [L.id] }), run(2, { lessons: [] })];
    const [s] = lessonStats(h, files);
    expect(s.with.rounds).toBe(4);
    expect(s.with.firstTryPass).toBeUndefined();
    expect(s.without.rounds).toBeUndefined();
  });
});

describe('runSummary', () => {
  it('does not warn on a drop of exactly 15 percentage points', () => {
    const history = Array.from({ length: 10 }, (_, i) => run(i, { cacheHitRate: i < 5 ? 0.9 : 0.75 }));
    expect(runSummary(history).cacheTrend?.dropped).toBe(false);
  });

  it('cache trend warns on a drop over 15 points', () => {
    const rates = [0.9, 0.9, 0.9, 0.9, 0.9, 0.5, 0.5, 0.5, 0.5, 0.5];
    const t = runSummary(rates.map((r, i) => run(i, { cacheHitRate: r }))).cacheTrend!;
    expect(t.dropped).toBe(true);
    expect(t.recent).toBeCloseTo(0.5);
    expect(t.previous).toBeCloseTo(0.9);
    const ok = runSummary(rates.map((_, i) => run(i, { cacheHitRate: i < 5 ? 0.9 : 0.8 }))).cacheTrend!;
    expect(ok.dropped).toBe(false);
  });

  it('no trend with fewer than two windows of data', () => {
    expect(runSummary([run(0, { cacheHitRate: 0.5 })]).cacheTrend).toBeUndefined();
  });
});

describe('fix round 1', () => {
  it('no cache trend with 6-9 rated runs even with a big gap', () => {
    for (let n = 6; n <= 9; n++) {
      const h = Array.from({ length: n }, (_, i) => run(i, { cacheHitRate: i < n - 5 ? 0.95 : 0.2 }));
      expect(runSummary(h).cacheTrend).toBeUndefined();
    }
  });

  it('a metric present on one side only counts as no improvement', () => {
    const s = lessonStats(mix(5, 3, { firstTryPass: 0.9, spentUsd: 2 }, { spentUsd: 2 }), files)[0];
    expect(s.verdict).toBe('no_benefit');
  });
});
