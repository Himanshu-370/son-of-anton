import { join } from 'node:path';
import { z } from 'zod';
import { waitForLockFile } from '../core/lock.js';
import { antonHome } from '../core/paths.js';
import { readSlackFile, slackDirectory, teamIdSchema, writeSlackFile } from './config.js';

/*
 * The monthly pool for paid Slack answers, separate from every build budget. Each answer reserves its
 * conservative upper bound under a lock before the call, and the reported cost replaces that bound exactly
 * once. A call whose outcome or usage is unknown keeps its full reservation for the month.
 */

export const DEFAULT_CHAT_MONTHLY_USD = 5;
export const DEFAULT_CHAT_ANSWER_USD = 0.1;
/** Ledger rows are kept for this many months (the current one and the two before it). */
const KEEP_MONTHS = 3;

export type ChatReservation = { teamId: string; requestId: string; month: string; maxUsd: number };
export type ChatBudgetOptions = { home?: string; monthlyUsd?: number };

const money = z.number().finite().min(0);
const month = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);
const requestIdSchema = z.string().regex(/^[a-f0-9]{32,64}$/);
const rowSchema = z.strictObject({
  teamId: teamIdSchema,
  month,
  maxUsd: money,
  at: z.number(),
  /** reserved: in flight or interrupted; settled: actual cost known; unknown: reconciled without usage. */
  status: z.enum(['reserved', 'settled', 'unknown']),
  actualUsd: money.optional(),
});
const ledgerSchema = z.strictObject({ version: z.literal(1), requests: z.record(requestIdSchema, rowSchema) });
type Ledger = z.infer<typeof ledgerSchema>;
type Row = z.infer<typeof rowSchema>;

/** The UTC calendar month, `YYYY-MM`. */
export function chatMonth(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** What a row counts against the pool: the actual cost once known, otherwise its full upper bound. */
const charged = (row: Row) => (row.status === 'settled' ? row.actualUsd ?? row.maxUsd : row.maxUsd);

function spent(ledger: Ledger, teamId: string, m: string): number {
  return Object.values(ledger.requests).filter((r) => r.teamId === teamId && r.month === m).reduce((sum, r) => sum + charged(r), 0);
}

function prune(ledger: Ledger, now: number): Ledger {
  const d = new Date(now);
  const oldest = chatMonth(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (KEEP_MONTHS - 1), 1));
  return { version: 1, requests: Object.fromEntries(Object.entries(ledger.requests).filter(([, r]) => r.month >= oldest)) };
}

async function withLedger<T>(home: string, body: (ledger: Ledger) => { value: T; write: boolean }, now = Date.now()): Promise<T> {
  const root = (await slackDirectory(home, true))!;
  const release = await waitForLockFile(join(root, 'chat-budget.lock'));
  try {
    const ledger = (await readSlackFile(home, 'chat-budget.json', ledgerSchema)) ?? { version: 1 as const, requests: {} };
    const { value, write } = body(ledger);
    if (write) await writeSlackFile(home, 'chat-budget.json', prune(ledger, now));
    return value;
  } finally {
    await release();
  }
}

const valid = (teamId: string, requestId: string) => teamIdSchema.safeParse(teamId).success && requestIdSchema.safeParse(requestId).success;

/**
 * Reserve `maxUsd` from the team's pool for this UTC month. Undefined when the pool cannot cover it, the
 * amount is not a positive finite number, or this request already has a reservation (a request is paid once).
 */
export async function reserveChatSpend(
  teamId: string, requestId: string, maxUsd: number, now: number, opts: ChatBudgetOptions = {},
): Promise<ChatReservation | undefined> {
  if (!valid(teamId, requestId) || !Number.isFinite(maxUsd) || maxUsd <= 0) return undefined;
  const monthlyUsd = opts.monthlyUsd ?? DEFAULT_CHAT_MONTHLY_USD;
  const m = chatMonth(now);
  return withLedger(opts.home ?? antonHome(), (ledger) => {
    if (ledger.requests[requestId]) return { value: undefined, write: false };
    // A tiny tolerance so that summing cents in floating point never refuses an exact fit.
    if (spent(ledger, teamId, m) + maxUsd > monthlyUsd + 1e-9) return { value: undefined, write: false };
    ledger.requests[requestId] = { teamId, month: m, maxUsd, at: now, status: 'reserved' };
    return { value: { teamId, requestId, month: m, maxUsd }, write: true };
  }, now);
}

/**
 * Reconcile a reservation once. A finite `actualUsd` replaces the upper bound; undefined (no usable usage
 * reported, or the call's outcome is unknown) keeps the full reservation. Returns false if it was already
 * reconciled or is not in the ledger.
 */
export async function settleChatSpend(r: ChatReservation, actualUsd: number | undefined, opts: { home?: string } = {}): Promise<boolean> {
  if (!valid(r.teamId, r.requestId)) return false;
  const known = actualUsd !== undefined && Number.isFinite(actualUsd) && actualUsd >= 0;
  return withLedger(opts.home ?? antonHome(), (ledger) => {
    const row = ledger.requests[r.requestId];
    if (!row || row.teamId !== r.teamId || row.status !== 'reserved') return { value: false, write: false };
    ledger.requests[r.requestId] = known ? { ...row, status: 'settled', actualUsd } : { ...row, status: 'unknown' };
    return { value: true, write: true };
  });
}

/** Whether this request was ever reserved (a redelivered question). */
export async function chatRequestKnown(teamId: string, requestId: string, opts: { home?: string } = {}): Promise<boolean> {
  if (!valid(teamId, requestId)) return false;
  const ledger = await readSlackFile(opts.home ?? antonHome(), 'chat-budget.json', ledgerSchema);
  return ledger?.requests[requestId]?.teamId === teamId;
}

/** This UTC month's charges for the team: actual costs plus the full bound of anything not reconciled. */
export async function chatSpentUsd(teamId: string, now: number, opts: { home?: string } = {}): Promise<number> {
  const ledger = await readSlackFile(opts.home ?? antonHome(), 'chat-budget.json', ledgerSchema);
  return ledger ? spent(ledger, teamId, chatMonth(now)) : 0;
}
