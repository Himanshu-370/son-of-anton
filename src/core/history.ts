import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { antonHome } from './paths.js';

/** Numbers, ids, the project name and the kit only: never a description, spec text or secret. */
const HistoryEntrySchema = z.object({
  jobId: z.string(),
  project: z.string(),
  kind: z.enum(['new', 'change']),
  kit: z.enum(['fallback', 'web']),
  checks: z.number(),
  spentUsd: z.number(),
  stageUsd: z.record(z.string(), z.number()),
  cacheHitRate: z.number().optional(),
  at: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

const file = (home: string) => join(home, 'history.jsonl');

/** One whole line per call (O_APPEND), so a crash cannot leave a half line in the middle. */
export async function appendHistory(entry: HistoryEntry, home = antonHome()): Promise<void> {
  await fsp.mkdir(home, { recursive: true });
  // appendFile (O_APPEND), not writeFileAtomic: one small line, and read-modify-write would race between concurrent jobs.
  let lead = '';
  try {
    const fh = await fsp.open(file(home), 'r');
    try {
      const { size } = await fh.stat();
      if (size > 0) {
        const b = Buffer.alloc(1);
        await fh.read(b, 0, 1, size - 1);
        if (b[0] !== 0x0a) lead = '\n'; // a crash left a half line: do not fuse with it
      }
    } finally {
      await fh.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await fsp.appendFile(file(home), lead + JSON.stringify(entry) + '\n');
}

export async function readHistory(home = antonHome()): Promise<HistoryEntry[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(file(home), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out = new Map<string, HistoryEntry>(); // a re-delivery appends again: the last line per job wins
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = HistoryEntrySchema.safeParse(JSON.parse(line));
      if (r.success) out.set(r.data.jobId, r.data);
    } catch {
      // corrupt line: skip
    }
  }
  return [...out.values()];
}

const quantile = (sorted: number[], p: number): number => {
  const i = p * (sorted.length - 1);
  const lo = Math.floor(i);
  return sorted[lo]! + (sorted[Math.min(lo + 1, sorted.length - 1)]! - sorted[lo]!) * (i - lo);
};

export function estimateCost(
  history: HistoryEntry[],
  want: { kind: 'new' | 'change'; kit: 'fallback' | 'web'; checks: number },
): { lowUsd: number; highUsd: number; n: number } | undefined {
  const costs = history
    .filter((h) => h.kind === want.kind && h.kit === want.kit && h.checks >= want.checks * 0.5 && h.checks <= want.checks * 1.5)
    .map((h) => h.spentUsd)
    .sort((a, b) => a - b);
  if (costs.length < 3) return undefined;
  return { lowUsd: quantile(costs, 0.25), highUsd: quantile(costs, 0.75), n: costs.length };
}
