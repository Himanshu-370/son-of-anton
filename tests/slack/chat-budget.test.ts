import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chatMonth, chatRequestKnown, chatSpentUsd, reserveChatSpend, settleChatSpend,
  DEFAULT_CHAT_ANSWER_USD, DEFAULT_CHAT_MONTHLY_USD,
} from '../../src/slack/chat-budget.js';

// No model calls here: the ledger only books upper bounds and reconciles reported costs.
const TEAM = 'T0FAKE';
const NOV = Date.UTC(2026, 10, 15, 12);
let home: string;
let n = 0;
const rid = () => (++n).toString(16).padStart(32, '0');

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-chat-budget-'));
});

describe('chat budget ledger', () => {
  it('defaults to $5 a month and $0.10 an answer', () => {
    expect(DEFAULT_CHAT_MONTHLY_USD).toBe(5);
    expect(DEFAULT_CHAT_ANSWER_USD).toBe(0.1);
  });

  it('keys the month by UTC', () => {
    expect(chatMonth(Date.UTC(2026, 10, 30, 23, 59, 59))).toBe('2026-11');
    expect(chatMonth(Date.UTC(2026, 11, 1, 0, 0, 0))).toBe('2026-12');
  });

  it('reserves within the monthly pool and refuses once the upper bounds would exceed it', async () => {
    const opts = { home, monthlyUsd: 0.3 };
    for (let i = 0; i < 3; i++) expect(await reserveChatSpend(TEAM, rid(), 0.1, NOV, opts)).toBeDefined();
    expect(await reserveChatSpend(TEAM, rid(), 0.1, NOV, opts)).toBeUndefined();
    expect(await chatSpentUsd(TEAM, NOV, opts)).toBeCloseTo(0.3);
  });

  it('never over-reserves under concurrent requests', async () => {
    const opts = { home, monthlyUsd: 1 };
    const results = await Promise.all(Array.from({ length: 25 }, () => reserveChatSpend(TEAM, rid(), 0.1, NOV, opts)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await chatSpentUsd(TEAM, NOV, opts)).toBeCloseTo(1);
  });

  it('reconciles the actual cost exactly once by request ID', async () => {
    const opts = { home, monthlyUsd: 1 };
    const r = (await reserveChatSpend(TEAM, rid(), 0.1, NOV, opts))!;
    expect(await settleChatSpend(r, 0.004, opts)).toBe(true);
    expect(await settleChatSpend(r, 0.09, opts)).toBe(false);
    expect(await chatSpentUsd(TEAM, NOV, opts)).toBeCloseTo(0.004);
  });

  it('keeps the full reservation when usage is unknown, and for an interrupted call', async () => {
    const opts = { home, monthlyUsd: 1 };
    const unknown = (await reserveChatSpend(TEAM, rid(), 0.1, NOV, opts))!;
    expect(await settleChatSpend(unknown, undefined, opts)).toBe(true);
    // A later report cannot lower an unknown outcome: it was reconciled once already.
    expect(await settleChatSpend(unknown, 0.001, opts)).toBe(false);
    // Interrupted: reserved and never reconciled.
    await reserveChatSpend(TEAM, rid(), 0.07, NOV, opts);
    expect(await chatSpentUsd(TEAM, NOV, opts)).toBeCloseTo(0.17);
  });

  it('refuses a second reservation for the same request', async () => {
    const opts = { home };
    const id = rid();
    expect(await reserveChatSpend(TEAM, id, 0.05, NOV, opts)).toBeDefined();
    expect(await reserveChatSpend(TEAM, id, 0.05, NOV, opts)).toBeUndefined();
    expect(await chatRequestKnown(TEAM, id, opts)).toBe(true);
    expect(await chatRequestKnown(TEAM, rid(), opts)).toBe(false);
    expect(await chatSpentUsd(TEAM, NOV, opts)).toBeCloseTo(0.05);
  });

  it('starts each UTC month with a fresh pool', async () => {
    const opts = { home, monthlyUsd: 0.1 };
    expect(await reserveChatSpend(TEAM, rid(), 0.1, Date.UTC(2026, 10, 30, 23, 59), opts)).toBeDefined();
    expect(await reserveChatSpend(TEAM, rid(), 0.1, Date.UTC(2026, 10, 30, 23, 59, 30), opts)).toBeUndefined();
    expect(await reserveChatSpend(TEAM, rid(), 0.1, Date.UTC(2026, 11, 1, 0, 0, 1), opts)).toBeDefined();
    expect(await chatSpentUsd(TEAM, Date.UTC(2026, 11, 2), opts)).toBeCloseTo(0.1);
  });

  it('keeps teams apart and rejects bad amounts', async () => {
    const opts = { home, monthlyUsd: 0.1 };
    expect(await reserveChatSpend(TEAM, rid(), 0.1, NOV, opts)).toBeDefined();
    expect(await reserveChatSpend('T0OTHER', rid(), 0.1, NOV, opts)).toBeDefined();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await reserveChatSpend('T0THIRD', rid(), bad, NOV, opts)).toBeUndefined();
    }
  });

  it('stores the ledger privately in the Slack directory', async () => {
    await reserveChatSpend(TEAM, rid(), 0.01, NOV, { home });
    const info = await stat(join(home, 'slack', 'chat-budget.json'));
    expect(info.mode & 0o777).toBe(0o600);
  });
});
