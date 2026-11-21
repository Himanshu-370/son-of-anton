import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory, estimateCost, readHistory, type HistoryEntry } from '../../src/core/history.js';

const e = (spentUsd: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  jobId: 'j', project: 'p', kind: 'new', kit: 'fallback', checks: 4, spentUsd, stageUsd: {}, at: '2026-01-01T00:00:00.000Z', ...over,
});
const want = { kind: 'new', kit: 'fallback', checks: 4 } as const;

describe('history', () => {
  it('corrupt history lines are skipped', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anton-hist-'));
    expect(await readHistory(home)).toEqual([]);
    await appendHistory(e(1), home);
    await writeFile(join(home, 'history.jsonl'), (await readFile(join(home, 'history.jsonl'), 'utf8')) + 'not json\n{"jobId":1}\n');
    await appendHistory(e(2), home);
    expect((await readHistory(home)).map((x) => x.spentUsd)).toEqual([1, 2]);
  });

  it('fewer than 3 similar jobs: no estimate', () => {
    expect(estimateCost([e(1), e(2)], want)).toBeUndefined();
  });

  it('estimate uses same kind, kit and ±50% checks', () => {
    const h = [e(1), e(2), e(3), e(100, { kind: 'change' }), e(100, { kit: 'web' }), e(100, { checks: 7 }), e(100, { checks: 1 }), e(4, { checks: 6 }), e(5, { checks: 2 })];
    expect(estimateCost(h, want)?.n).toBe(5);
  });

  it('p25–p75 range', () => {
    const r = estimateCost([e(1), e(2), e(3), e(4), e(5)], want)!;
    expect(r).toEqual({ lowUsd: 2, highUsd: 4, n: 5 });
    const r2 = estimateCost([e(1), e(2), e(3), e(10)], want)!;
    expect(r2.lowUsd).toBeCloseTo(1.75);
    expect(r2.highUsd).toBeCloseTo(4.75);
  });
});
