import { describe, expect, it } from 'vitest';
import type { SpendEntry } from '../../src/core/spend-log.js';
import type { SpendHomeData } from '../../src/slack/spend-home.js';
import { dueSpendNotices, spendNoticeText } from '../../src/slack/spend-notices.js';

const spend = (id: string, at: string, usd: number, over: Partial<SpendEntry> = {}): SpendEntry =>
  ({ id, at, source: 'build', usd, ...over });

// Wednesday 25 November 2026, local time.
const wednesday = new Date(2026, 10, 25, 10, 0);
const data = (over: Partial<SpendHomeData> = {}): SpendHomeData => ({
  now: wednesday, entries: [], jobs: [], config: {}, readOnly: true, ...over,
});

describe('spend notices', () => {
  it('warns once at 80% of the overall cap, keyed by UTC month', () => {
    expect(dueSpendNotices(data({ overallCapUsd: 100 }), 79.99)).toEqual([]);
    expect(dueSpendNotices(data({ overallCapUsd: 100 }), 80)).toEqual([
      { scope: 'workspace', kind: 'spend-warning', occurrence: `month-${wednesday.toISOString().slice(0, 7)}` },
    ]);
    expect(dueSpendNotices(data(), 500)).toEqual([]); // no cap, no warning
  });

  it('is due for the weekly summary from Monday 09:00 local, keyed by that Monday', () => {
    expect(dueSpendNotices(data({ now: new Date(2026, 10, 30, 8, 59) }), 0)).toEqual([]);
    expect(dueSpendNotices(data({ now: new Date(2026, 10, 30, 9, 0) }), 0)).toEqual([
      { scope: 'workspace', kind: 'spend-summary', occurrence: 'week-2026-11-30' },
    ]);
    expect(dueSpendNotices(data({ now: new Date(2026, 11, 1, 9, 0) }), 0)).toEqual([]); // Tuesday
  });

  it('writes the warning and summary from ledger figures', () => {
    const now = wednesday;
    const entries = [
      spend('a', new Date(now.getTime() - 2 * 86_400_000).toISOString(), 30, { project: 'todo', role: 'backend' }),
      spend('b', new Date(now.getTime() - 9 * 86_400_000).toISOString(), 20, { project: 'blog', role: 'pm' }),
    ];
    const warning = spendNoticeText({ scope: 'workspace', kind: 'spend-warning', occurrence: 'month-2026-11' },
      data({ entries, overallCapUsd: 60 }), 50);
    expect(warning?.title).toBe('Spending has passed 80% of the $60.00 overall monthly cap');
    expect(warning?.lines[0]).toMatch(/^\$50\.00 of \$60\.00 used/);
    const summary = spendNoticeText({ scope: 'workspace', kind: 'spend-summary', occurrence: 'week-2026-11-23' },
      data({ entries }), 50)!;
    expect(summary.title).toBe('Weekly spend summary');
    expect(summary.lines[0]).toBe('Last 7 days: $30.00 (up 50% on the week before).');
    expect(summary.lines).toContain('Top project: todo ($30.00). Top role: backend ($30.00).');
  });
});
