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

function parseLog(raw: string): { entries: SpendEntry[]; skipped: number } {
  const entries: SpendEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = spendEntry.parse(JSON.parse(line));
      if (seen.has(entry.id)) {
        skipped++;
        continue;
      }
      seen.add(entry.id);
      entries.push(entry);
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

export async function readSpendLog(home = antonHome()): Promise<ReturnType<typeof parseLog>> {
  return parseLog((await readRegularFile(join(home, 'spend.jsonl'))) ?? '');
}

/** Serialize writers across host processes and publish the complete log with one atomic rename. */
export async function recordSpend(entry: SpendEntry, home = antonHome()): Promise<boolean> {
  const validated = spendEntry.parse(entry);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const release = await waitForLockFile(join(home, 'spend.lock'));
  try {
    const path = join(home, 'spend.jsonl');
    const raw = (await readRegularFile(path)) ?? '';
    if (parseLog(raw).entries.some(({ id }) => id === validated.id)) return false;
    const separator = raw && !raw.endsWith('\n') ? '\n' : '';
    await writeFileAtomic(path, raw + separator + JSON.stringify(validated) + '\n');
    return true;
  } finally {
    await release();
  }
}
