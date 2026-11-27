import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activeMonthlyCap, markSpendReconciled, monthlyCapRefusal, reserveSpendUpTo, importLegacyJobSpend, debitSpendReservation, releaseSpendReservation, readSpendLog, recordSpend, reserveSpend, settleSpend, readMonthlySpend, type SpendEntry } from '../../src/core/spend-log.js';

const entry: SpendEntry = {
  id: 'build-1', at: '2026-11-27T10:00:00.000Z', source: 'build',
  project: 'todo-app', jobId: '1-init', stage: 'build', role: 'backend',
  model: 'claude-sonnet-5-5', effort: 'medium', vendor: 'anthropic',
  tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }, usd: 0.01,
};

describe('host spend log', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'anton-spend-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  it('reserves up to what is left under the cap, and refuses below the minimum', async () => {
    await recordSpend({ ...entry, id: 'spent', usd: 2.5 }, home);
    const ask = { ...entry, id: 'next', usd: 5 };
    expect(await reserveSpendUpTo(ask, 3, 0.25, home)).toEqual({ result: 'reserved', usd: 0.5 });
    expect(await reserveSpendUpTo({ ...ask, id: 'after' }, 3, 0.25, home)).toEqual({ result: 'cap', usd: 0 });
    expect(await reserveSpendUpTo({ ...ask, id: 'free' }, undefined, 0.25, home)).toEqual({ result: 'reserved', usd: 5 });
  });

  it('applies the overall cap only after month-to-date spend is reconciled', async () => {
    expect(await activeMonthlyCap(150, home)).toBeUndefined();
    await markSpendReconciled(new Date('2026-11-27T10:00:00.000Z'), home);
    expect(await activeMonthlyCap(150, home)).toBe(150);
    expect(await activeMonthlyCap(undefined, home)).toBeUndefined();
  });

  it('refuses a paid run while the reconciled cap is reached', async () => {
    const now = new Date('2026-11-27T12:00:00.000Z');
    await writeFile(join(home, 'config.yaml'), 'budget:\n  monthlyUsd: 3\n');
    await recordSpend({ ...entry, id: 'spent', usd: 3 }, home);
    expect(await monthlyCapRefusal(now, home)).toBeUndefined();
    await markSpendReconciled(now, home);
    expect(await monthlyCapRefusal(now, home)).toBe('The overall monthly spending cap ($3.00) is reached. Raise budget.monthlyUsd in ~/anton/config.yaml first.');
  });

  it('starts empty and retains each concurrent charge exactly once', async () => {
    expect(await readSpendLog(home)).toEqual({ entries: [], skipped: 0 });
    const other = { ...entry, id: 'chat-2', source: 'chat' } as const;
    const results = await Promise.all([recordSpend(entry, home), recordSpend(other, home), recordSpend(entry, home)]);
    expect(results.filter(Boolean)).toHaveLength(2);
    const log = await readSpendLog(home);
    expect(log.skipped).toBe(0);
    expect(log.entries).toHaveLength(2);
    expect(log.entries).toEqual(expect.arrayContaining([entry, other]));
  });

  it('reports malformed lines and preserves them when recording further spend', async () => {
    await writeFile(join(home, 'spend.jsonl'), 'incomplete row');
    await recordSpend(entry, home);
    expect(await readSpendLog(home)).toEqual({ entries: [entry], skipped: 1 });
  });

  it('rejects negative charges and validates metadata before writing', async () => {
    await expect(recordSpend({ ...entry, usd: -1 }, home)).rejects.toThrow();
    await expect(recordSpend({ ...entry, role: 'invented' } as unknown as SpendEntry, home)).rejects.toThrow();
    expect(await readSpendLog(home)).toEqual({ entries: [], skipped: 0 });
  });

  it('reserves against settled spend and lets only one concurrent request fit', async () => {
    await recordSpend({ ...entry, usd: 0.4 }, home);
    const ids = ['request-1', 'request-2'];
    const results = await Promise.all(ids.map((id) => reserveSpend({ ...entry, id, usd: 0.6 }, 1, home)));
    expect(results.sort()).toEqual(['cap', 'reserved']);
    expect(await readMonthlySpend('2026-11', home)).toEqual({ settledUsd: 0.4, reservedUsd: 0.6 });
  });

  it('settles the original UTC month once and keeps unknown outcomes reserved', async () => {
    const request = { ...entry, id: 'request-1', at: '2026-11-30T23:59:59.900Z', usd: 0.5 };
    expect(await reserveSpend(request, 0, home)).toBe('cap');
    expect(await reserveSpend(request, 1, home)).toBe('reserved');
    expect(await reserveSpend(request, 1, home)).toBe('duplicate');
    expect(await reserveSpend({ ...request, id: 'unknown' }, 1, home)).toBe('reserved');
    expect(await settleSpend('request-1', { usd: 0.2, tokens: entry.tokens }, home)).toBe(true);
    expect(await settleSpend('request-1', { usd: 0.3 }, home)).toBe(false);
    expect(await reserveSpend(request, 1, home)).toBe('duplicate');
    expect(await readMonthlySpend('2026-11', home)).toEqual({ settledUsd: 0.2, reservedUsd: 0.5 });
    expect(await readMonthlySpend('2026-12', home)).toEqual({ settledUsd: 0, reservedUsd: 0 });
    expect(await readSpendLog(home)).toEqual({ entries: [{ ...request, usd: 0.2 }], skipped: 0 });
  });

  it('releases a known unbilled reservation and counts actual cost above the bound', async () => {
    const request = { ...entry, id: 'request-1', usd: 0.6 };
    expect(await reserveSpend(request, 1, home)).toBe('reserved');
    expect(await settleSpend(request.id, { usd: 0 }, home)).toBe(true);
    const next = { ...request, id: 'request-2' };
    expect(await reserveSpend(next, 1, home)).toBe('reserved');
    expect(await settleSpend(next.id, { usd: 1.05 }, home)).toBe(true);
    expect(await reserveSpend({ ...next, id: 'request-3' }, 1, home)).toBe('cap');
    expect(await readMonthlySpend('2026-11', home)).toEqual({ settledUsd: 1.05, reservedUsd: 0 });
  });

  it('reports corrupt records and refuses capped reservations against incomplete data', async () => {
    await writeFile(join(home, 'spend.jsonl'), 'incomplete row');
    expect(await reserveSpend(entry, 1, home)).toBe('unavailable');
    expect(await readSpendLog(home)).toEqual({ entries: [], skipped: 1 });
  });

  it('debits once, counts an overrun, and cannot reuse a released reservation', async () => {
    expect(await reserveSpend({ ...entry, id: 'hold', usd: 0.6 }, 1, home)).toBe('reserved');
    expect(await debitSpendReservation('hold', 'charge', 0.7, home)).toBe(true);
    expect(await debitSpendReservation('hold', 'charge', 0.7, home)).toBe(false);
    expect(await readMonthlySpend('2026-11', home)).toEqual({ settledUsd: 0.7, reservedUsd: 0 });
    expect(await releaseSpendReservation('hold', home)).toBe(true);
    expect(await releaseSpendReservation('hold', home)).toBe(false);
    expect(await reserveSpend({ ...entry, id: 'hold', usd: 0.1 }, 1, home)).toBe('duplicate');
    expect(await reserveSpend({ ...entry, usd: 0.4 }, 1, home)).toBe('cap');
    expect((await readSpendLog(home)).skipped).toBe(0);
  });

  it('imports only the untracked lifetime cost of jobs touched this UTC month', async () => {
    await recordSpend({ ...entry, id: 'prior', at: '2026-10-31T23:59:59.000Z', usd: 1 }, home);
    await recordSpend({ ...entry, id: 'current', usd: 2 }, home);
    await recordSpend({ ...entry, id: 'role-chat', source: 'chat', usd: 1 }, home);
    const now = new Date('2026-11-27T12:00:00.000Z');
    const job = { project: entry.project!, jobId: entry.jobId!, updatedAt: entry.at, spentUsd: 5 };
    expect(await importLegacyJobSpend(job, now, home)).toBe(2);
    expect(await importLegacyJobSpend(job, now, home)).toBe(0);
    expect(await importLegacyJobSpend({ ...job, jobId: '2-fix', updatedAt: '2026-10-31T23:59:59.000Z' }, now, home)).toBe(0);
    expect(await importLegacyJobSpend({ ...job, jobId: '3-fix', updatedAt: '2026-11-27T13:00:00.000Z' }, now, home)).toBe(0);
    expect((await readSpendLog(home)).entries.filter((row) => row.source === 'import')).toMatchObject([
      { project: job.project, jobId: job.jobId, at: job.updatedAt, usd: 2 },
    ]);
    expect(await readMonthlySpend('2026-11', home)).toEqual({ settledUsd: 5, reservedUsd: 0 });
  });
});
