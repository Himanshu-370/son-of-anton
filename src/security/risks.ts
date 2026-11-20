import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';

export type AcceptedRisk = { id: string; reason: string; acceptedAt: string };

const file = (jobDir: string): string => join(jobDir, 'evidence', 'accepted-risks.json');

export async function loadAcceptedRisks(jobDir: string): Promise<AcceptedRisk[]> {
  let text: string;
  try {
    text = await fsp.readFile(file(jobDir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const parsed = JSON.parse(text) as { risks?: unknown };
  return Array.isArray(parsed.risks) ? (parsed.risks as AcceptedRisk[]) : [];
}

/** Idempotent per id: re-accepting replaces the reason and timestamp. */
export async function acceptRisk(jobDir: string, id: string, reason: string): Promise<void> {
  const risks = (await loadAcceptedRisks(jobDir)).filter((r) => r.id !== id);
  risks.push({ id, reason, acceptedAt: new Date().toISOString() });
  await writeFileAtomic(file(jobDir), JSON.stringify({ risks }, null, 2) + '\n');
}
