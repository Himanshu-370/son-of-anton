import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readRegularFile, writeFileAtomic } from './atomic.js';
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
const ledgerRow = z.union([spendEntry, reservationRow]);

function parseLog(raw: string) {
  const settled = new Map<string, SpendEntry>();
  const reserved = new Map<string, SpendEntry>();
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = ledgerRow.parse(JSON.parse(line));
      if ('reserve' in row) {
        const entry = row.reserve;
        if (settled.has(entry.id) || reserved.has(entry.id)) {
          skipped++;
          continue;
        }
        reserved.set(entry.id, entry);
        continue;
      }
      if (settled.has(row.id)) {
        skipped++;
        continue;
      }
      reserved.delete(row.id);
      settled.set(row.id, row);
    } catch {
      skipped++;
    }
  }
  return { settled, reserved, skipped };
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
  return updateLog(home, (log) => log.settled.has(row.id) || log.reserved.has(row.id)
    ? { result: false } : { result: true, row });
}

export type SpendReservationResult = 'reserved' | 'cap' | 'duplicate' | 'unavailable';

/** Hold a maximum before dispatch. A request with unknown usage keeps its hold for its UTC month. */
export async function reserveSpend(
  entry: SpendEntry, limitUsd: number | undefined, home = antonHome(),
): Promise<SpendReservationResult> {
  const row = spendEntry.extend({ usd: z.number().finite().positive() }).parse(entry);
  const limit = z.number().finite().nonnegative().optional().parse(limitUsd);
  return updateLog<SpendReservationResult>(home, (log) => {
    if (log.settled.has(row.id) || log.reserved.has(row.id)) return { result: 'duplicate' };
    if (limit !== undefined) {
      if (log.skipped) return { result: 'unavailable' };
      const { settledUsd, reservedUsd } = monthlyTotals(log, row.at.slice(0, 7));
      if (limit === 0 || settledUsd + reservedUsd + row.usd > limit + 1e-9) return { result: 'cap' };
    }
    return { result: 'reserved', row: { reserve: row } };
  });
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
