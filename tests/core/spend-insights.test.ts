import { describe, expect, it } from 'vitest';
import {
  cacheSavingsUsd, forecastSpend, modelResults, recommendModel, spendTotals, spendWaste, unusualBurn,
  type InsightJob,
} from '../../src/core/spend-insights.js';
import type { SpendEntry } from '../../src/core/spend-log.js';

const now = new Date('2024-02-11T00:00:00Z');
const sonnet = 'claude-sonnet-5-5';
const haiku = 'claude-haiku-5-5';
const row = (fields: Partial<SpendEntry> = {}): SpendEntry => ({
  id: 'fixture', at: '2024-02-03T00:00:00Z', source: 'build', project: 'app', jobId: '1',
  stage: 'verify', role: 'qa', model: sonnet, usd: 2, ...fields,
});
const job = (fields: Partial<InsightJob> = {}): InsightJob => ({
  project: 'app', jobId: '1', stage: 'done', updatedAt: '2024-02-05T00:00:00Z',
  verifyRounds: 1, reviewFindings: 0, pausedForBudget: false, ...fields,
});

describe('spend insights', () => {
  it('totals UTC months and forecasts over a leap February', () => {
    const totals = spendTotals([
      row({ at: '2023-12-31T23:59:59Z' }), row({ at: '2024-01-31T23:59:59Z', usd: 3 }),
      row({ at: '2024-02-01T00:00:00Z' }), row({ usd: 8, source: 'import', model: undefined, role: undefined }),
      row({ at: '2024-02-11T00:00:01Z' }),
    ], now);
    expect(totals).toMatchObject({ thisMonthUsd: 10, lastMonthUsd: 3 });
    expect(totals.by).toEqual({
      project: new Map([['app', 10]]), stage: new Map([['verify', 10]]), role: new Map([['qa', 2]]),
      model: new Map([[sonnet, 2]]), source: new Map([['build', 2], ['import', 8]]),
    });
    expect(forecastSpend(totals.thisMonthUsd, now, 28)).toEqual({ projectedUsd: 29, capUsd: 28, overCap: true });
    expect(forecastSpend(1, new Date('2024-02-01T00:00:00Z')).projectedUsd).toBe(29);
  });

  it('attributes abandoned spend and rework by project, job, stage and time', () => {
    const from = '2024-02-03T00:00:00Z';
    const until = '2024-02-04T00:00:00Z';
    const result = spendWaste([
      row({ at: from }), row({ stage: 'build' }), row({ at: until }),
      row({ at: '2024-02-02T00:00:00Z' }), row({ project: 'other' }), row({ source: 'import' }),
    ], [job({ stage: 'abandoned', reworkWindows: [
      { stage: 'verify', from, until }, { stage: 'build', from, until },
    ] })]);
    expect(result).toEqual({ abandonedUsd: 10, reworkUsd: 4 });
  });

  it('flags strictly above twice the median after five samples and suppresses repeats', () => {
    const running = job({ jobId: 'running', stage: 'verify' });
    const history = Array.from({ length: 11 }, (_, i) =>
      job({ jobId: String(i), updatedAt: new Date(Date.UTC(2024, 1, i + 1)).toISOString() }));
    const rows = history.map(({ jobId }, i) => row({ jobId, usd: i === 0 ? 100 : 2 }));
    expect(unusualBurn([...rows, row({ jobId: 'running', usd: 5 })], [...history.slice(0, 4), running])).toEqual([]);
    expect(unusualBurn([...rows, row({ jobId: 'running', usd: 4 })], [...history, running])).toEqual([]);
    const entries = [...rows, row({ jobId: 'running', usd: 5 })];
    const alerts = unusualBurn(entries, [...history, running]);
    expect(alerts).toEqual([{ project: 'app', jobId: 'running', stage: 'verify', spentUsd: 5, medianUsd: 2, n: 10 }]);
    expect(unusualBurn(entries, [...history, running], alerts)).toEqual([]);
  });

  it('averages spend once per finished job and reports missing quality data', () => {
    const results = modelResults([
      row(), row({ usd: 4 }), row({ project: 'other', usd: 2 }),
      row({ jobId: '2', usd: 100 }),
    ], [job(), job({ project: 'other', stage: 'abandoned', reviewFindings: undefined, pausedForBudget: true }),
      job({ jobId: '2', stage: 'paused' })]);
    expect(results).toEqual([{
      role: 'qa', model: sonnet, n: 2, tooFewJobs: true, costUsd: { n: 2, value: 4 },
      verifyRounds: { n: 2, value: 1 }, reviewFindings: { n: 1, value: 0 },
      budgetPauseShare: { n: 2, value: 0.5 },
    }]);
  });

  it('uses the model input and cache-read prices', () => {
    const tokens = { input: 100, output: 100, cacheRead: 1_000_000, cacheWrite: 100 };
    expect(cacheSavingsUsd([
      row({ tokens }), row({ tokens, model: haiku }), row({ tokens, model: undefined }),
      row({ tokens, vendor: 'recall' }), row(),
    ])).toBeCloseTo(1.89);
  });

  it('requires enough data, comparable quality, at least $5, and no recent suggestion or dismissal', () => {
    const jobs = Array.from({ length: 6 }, (_, i) =>
      job({ jobId: String(i), verifyRounds: i < 3 ? 1 : 2 }));
    const entries = jobs.map(({ jobId }, i) => row({ jobId, model: i < 3 ? sonnet : haiku, usd: i < 3 ? 2 : 1 }));
    const results = modelResults(entries, jobs);
    const current = { qa: sonnet };
    expect(recommendModel(results, current, { qa: 5 }, now)?.monthlySavingUsd).toBe(5);
    expect(recommendModel(results, current, { qa: 4 }, now)).toBeUndefined();
    for (const changed of [
      jobs.slice(0, -1),
      [...jobs.slice(0, -1), { ...jobs[5], verifyRounds: 3 }],
      [...jobs.slice(0, -1), { ...jobs[5], reviewFindings: 1 }],
      [...jobs.slice(0, -1), { ...jobs[5], pausedForBudget: true }],
      [...jobs.slice(0, -1), { ...jobs[5], pausedForBudget: undefined }],
    ]) {
      expect(recommendModel(modelResults(entries, changed), current, { qa: 5 }, now)).toBeUndefined();
    }
    expect(recommendModel(results, current, { qa: 5 }, now, { lastSuggestedAt: '2024-02-05T00:00:00Z' })).toBeUndefined();
    expect(recommendModel(results, current, { qa: 5 }, now, {
      dismissals: [{ role: 'qa', model: haiku, at: '2024-01-13T00:00:00Z' }],
    })).toBeUndefined();
    expect(recommendModel(results, current, { qa: 5 }, now, {
      lastSuggestedAt: '2024-02-04T00:00:00Z', dismissals: [{ role: 'qa', model: haiku, at: '2024-01-12T00:00:00Z' }],
    })?.candidate.model).toBe(haiku);
  });
});
