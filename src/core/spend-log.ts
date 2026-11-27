import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { budgetSettings, loadAntonConfig } from './anton-config.js';
import { readRegularFile, writeFileAtomic } from './atomic.js';
import { usd } from './budget.js';
import { ROLE_MODELS, type Role } from './config.js';
import { waitForLockFile } from './lock.js';
import { antonHome } from './paths.js';

const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const roles = Object.keys(ROLE_MODELS) as [Role, ...Role[]];
const count = z.number().int().nonnegative();
const spendEntry = z.strictObject({
  id: label,
  at: z.iso.datetime(),
  source: z.enum(['build', 'chat', 'router', 'call', 'import']),
  project: label.optional(),
  jobId: label.optional(),
  stage: label.optional(),
  role: z.enum(roles).optional(),
  model: label.optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  vendor: z.enum(['anthropic', 'recall', 'deepgram', 'elevenlabs']).optional(),
  tokens: z.strictObject({ input: count, output: count, cacheRead: count, cacheWrite: count }).optional(),
  usd: z.number().finite().nonnegative(),
});

export type SpendEntry = z.infer<typeof spendEntry>;

const reservationRow = z.strictObject({ reserve: spendEntry });
const debit = z.strictObject({ id: label, reservationId: label, usd: z.number().finite().positive() });
const debitRow = z.strictObject({ debit });
const releaseRow = z.strictObject({ release: label });
const ledgerRow = z.union([spendEntry, reservationRow, debitRow, releaseRow]);

function parseLog(raw: string) {
  const settled = new Map<string, SpendEntry>();
  const reserved = new Map<string, SpendEntry>();
  const released = new Set<string>();
  const used = (id: string) => settled.has(id) || reserved.has(id) || released.has(id);
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = ledgerRow.parse(JSON.parse(line));
      if ('reserve' in row) {
        const entry = row.reserve;
        if (used(entry.id)) {
          skipped++;
          continue;
        }
        reserved.set(entry.id, entry);
        continue;
      }
      if ('debit' in row) {
        const { id, reservationId, usd } = row.debit;
        const hold = reserved.get(reservationId);
        if (!hold || used(id)) {
          skipped++;
          continue;
        }
        settled.set(id, { ...hold, id, usd });
        reserved.set(reservationId, { ...hold, usd: Math.max(0, hold.usd - usd) });
        continue;
      }
      if ('release' in row) {
        if (!reserved.delete(row.release)) {
          skipped++;
          continue;
        }
        released.add(row.release);
        continue;
      }
      if (settled.has(row.id) || released.has(row.id)) {
        skipped++;
        continue;
      }
      reserved.delete(row.id);
      settled.set(row.id, row);
    } catch {
      skipped++;
    }
  }
  return { settled, reserved, skipped, used };
}

async function readRaw(home: string): Promise<string> {
  return (await readRegularFile(join(home, 'spend.jsonl'))) ?? '';
}

export async function readSpendLog(home = antonHome()): Promise<{ entries: SpendEntry[]; skipped: number }> {
  const { settled, skipped } = parseLog(await readRaw(home));
  return { entries: [...settled.values()], skipped };
}

function monthlyTotals(log: ReturnType<typeof parseLog>, month: string) {
  const sum = (rows: Iterable<SpendEntry>) => {
    let total = 0;
    for (const row of rows) {
      if (row.at.slice(0, 7) === month) total += row.usd;
    }
    return total;
  };
  return { settledUsd: sum(log.settled.values()), reservedUsd: sum(log.reserved.values()) };
}

export async function readMonthlySpend(month: string, home = antonHome()) {
  return monthlyTotals(parseLog(await readRaw(home)), month);
}

/** Read and update the same snapshot under the host lock shared by every writer. */
async function updateLog<T>(
  home: string,
  update: (log: ReturnType<typeof parseLog>) => { result: T; row?: z.infer<typeof ledgerRow> },
): Promise<T> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const release = await waitForLockFile(join(home, 'spend.lock'));
  try {
    const raw = await readRaw(home);
    const { result, row } = update(parseLog(raw));
    if (row) {
      const separator = raw && !raw.endsWith('\n') ? '\n' : '';
      await writeFileAtomic(join(home, 'spend.jsonl'), raw + separator + JSON.stringify(row) + '\n');
    }
    return result;
  } finally {
    await release();
  }
}

export async function recordSpend(entry: SpendEntry, home = antonHome()): Promise<boolean> {
  const row = spendEntry.parse(entry);
  return updateLog(home, (log) => log.used(row.id)
    ? { result: false } : { result: true, row });
}

export type SpendReservationResult = 'reserved' | 'cap' | 'duplicate' | 'unavailable';

/** Hold a maximum before dispatch. A request with unknown usage keeps its hold for its UTC month. */
export async function reserveSpend(
  entry: SpendEntry, limitUsd: number | undefined, home = antonHome(),
): Promise<SpendReservationResult> {
  const usd = z.number().finite().positive().parse(entry.usd);
  return (await reserveSpendUpTo(entry, limitUsd, usd, home)).result;
}

/**
 * Like reserveSpend, but under a cap it holds what is left of the month when that is less than asked,
 * as long as it is at least `minUsd`. Returns the amount actually held (0 unless reserved).
 */
export async function reserveSpendUpTo(
  entry: SpendEntry, limitUsd: number | undefined, minUsd: number, home = antonHome(),
): Promise<{ result: SpendReservationResult; usd: number }> {
  const row = spendEntry.extend({ usd: z.number().finite().positive() }).parse(entry);
  const limit = z.number().finite().nonnegative().optional().parse(limitUsd);
  const floor = z.number().finite().positive().parse(minUsd);
  return updateLog<{ result: SpendReservationResult; usd: number }>(home, (log) => {
    if (log.used(row.id)) return { result: { result: 'duplicate' as const, usd: 0 } };
    let usd = row.usd;
    if (limit !== undefined) {
      if (log.skipped) return { result: { result: 'unavailable' as const, usd: 0 } };
      const { settledUsd, reservedUsd } = monthlyTotals(log, row.at.slice(0, 7));
      usd = Math.min(usd, limit - settledUsd - reservedUsd);
      if (usd < Math.min(floor, row.usd) - 1e-9) return { result: { result: 'cap' as const, usd: 0 } };
    }
    return { result: { result: 'reserved' as const, usd }, row: { reserve: { ...row, usd } } };
  });
}

/** True when this UTC month's settled and held spend has reached the cap. */
export async function monthlyCapReached(capUsd: number | undefined, now: Date, home = antonHome()): Promise<boolean> {
  if (capUsd === undefined) return false;
  const { settledUsd, reservedUsd } = await readMonthlySpend(now.toISOString().slice(0, 7), home);
  return settledUsd + reservedUsd >= capUsd - 1e-9;
}

const RECONCILED = 'spend-reconciled.json';

/** The overall cap applies only once month-to-date spend from before the spend log was reconciled. */
export async function activeMonthlyCap(monthlyUsd: number | undefined, home = antonHome()): Promise<number | undefined> {
  if (monthlyUsd === undefined) return undefined;
  return (await readRegularFile(join(home, RECONCILED))) === undefined ? undefined : monthlyUsd;
}

/** Why a paid run may not start now, or undefined when it may. */
export async function monthlyCapRefusal(now = new Date(), home = antonHome()): Promise<string | undefined> {
  const cap = await activeMonthlyCap(budgetSettings(await loadAntonConfig(home)).monthlyUsd, home);
  if (!(await monthlyCapReached(cap, now, home))) return undefined;
  return `The overall monthly spending cap (${usd(cap!)}) is reached. Raise budget.monthlyUsd in ~/anton/config.yaml first.`;
}

export async function markSpendReconciled(at: Date, home = antonHome()): Promise<void> {
  await writeFileAtomic(join(home, RECONCILED), JSON.stringify({ at: at.toISOString() }) + '\n');
}

export async function spendReconciled(home = antonHome()): Promise<boolean> {
  return (await readRegularFile(join(home, RECONCILED))) !== undefined;
}

/** Replace the hold with actual cost atomically, including zero for a request known to be unbilled. */
export async function settleSpend(
  id: string, actual: Pick<SpendEntry, 'usd' | 'tokens'>, home = antonHome(),
): Promise<boolean> {
  return updateLog(home, (log) => {
    const held = log.reserved.get(id);
    if (!held) return { result: false };
    const row = spendEntry.parse({ ...held, usd: actual.usd, tokens: actual.tokens });
    return { result: true, row };
  });
}


/** Book an incremental charge and reduce its outstanding hold in the same write. */
export async function debitSpendReservation(
  reservationId: string, id: string, usd: number, home = antonHome(),
): Promise<boolean> {
  const row = debitRow.parse({ debit: { reservationId, id, usd } });
  return updateLog(home, (log) => log.used(id) || !log.reserved.has(reservationId)
    ? { result: false } : { result: true, row });
}

/** Release only unused capacity once a provider's final cost has been booked. */
export async function releaseSpendReservation(id: string, home = antonHome()): Promise<boolean> {
  const row = releaseRow.parse({ release: id });
  return updateLog(home, (log) => log.reserved.has(id) ? { result: true, row } : { result: false });
}


/** Reconcile a quiescent job snapshot against all of its recorded lifetime build charges. */
export async function importLegacyJobSpend(
  job: { project: string; jobId: string; updatedAt: string; spentUsd: number },
  now: Date,
  home = antonHome(),
): Promise<number> {
  const touched = new Date(job.updatedAt);
  if (!Number.isFinite(touched.getTime()) || touched > now) return 0;
  const at = touched.toISOString();
  if (at.slice(0, 7) !== now.toISOString().slice(0, 7)) return 0;
  const { project, jobId, spentUsd } = job;
  const id = 'import:job:' + createHash('sha256').update(JSON.stringify([project, jobId])).digest('hex');
  return updateLog(home, (log) => {
    if (log.skipped) throw new Error('Cannot reconcile build spend with an incomplete spend log.');
    if (log.used(id)) return { result: 0 };
    let recorded = 0;
    for (const row of log.settled.values()) {
      if (row.project === project && row.jobId === jobId && (row.source === 'build' || row.source === 'import')) recorded += row.usd;
    }
    const gap = spentUsd - recorded;
    if (gap <= 1e-9) return { result: 0 };
    const row = spendEntry.parse({ id, source: 'import', project, jobId, at, usd: gap });
    return { result: gap, row };
  });
}
