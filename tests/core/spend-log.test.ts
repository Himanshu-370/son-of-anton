import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSpendLog, recordSpend, type SpendEntry } from '../../src/core/spend-log.js';

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
});
