import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../core/atomic.js';
import { antonHome } from '../core/paths.js';

/** One Retro proposal waiting for `anton lessons review`. Untrusted model output until accepted. */
export const ProposalSchema = z.object({
  id: z.string().min(1),
  project: z.string(),
  jobId: z.string(),
  kind: z.enum(['lesson', 'plugin']),
  target: z.string().optional(),
  text: z.string().optional(),
  plugin: z.string().optional(),
  stage: z.enum(['spec', 'plan', 'build', 'verify']).optional(),
  why: z.string(),
  at: z.string(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const proposalsPath = (home = antonHome()) => join(home, 'lessons', 'proposals.jsonl');

export async function readProposals(home = antonHome()): Promise<Proposal[]> {
  let raw: string;
  try {
    raw = await readFile(proposalsPath(home), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return raw.split('\n').flatMap((line) => {
    try {
      const p = ProposalSchema.safeParse(JSON.parse(line));
      return p.success ? [p.data] : [];
    } catch {
      return [];
    }
  });
}

const write = (ps: Proposal[], home: string) => writeFileAtomic(proposalsPath(home), ps.map((p) => JSON.stringify(p) + '\n').join(''));

/** Adds proposals whose id is not queued yet. */
export async function appendProposals(ps: Proposal[], home = antonHome()): Promise<void> {
  const all = await readProposals(home);
  const ids = new Set(all.map((p) => p.id));
  const fresh = ps.filter((p) => !ids.has(p.id) && ids.add(p.id));
  if (fresh.length) await write([...all, ...fresh], home);
}

export async function removeProposal(id: string, home = antonHome()): Promise<void> {
  await write((await readProposals(home)).filter((p) => p.id !== id), home);
}
