import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../core/atomic.js';
import { waitForLockFile } from '../core/lock.js';
import { antonHome } from '../core/paths.js';
import { addLesson, DuplicateLessonError, KIT_LESSON_FILES, LESSON_FILES } from './store.js';

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

/** The queue is read-modify-write from Retro, the CLI and Slack: serialize every change across processes. */
async function withQueueLock<T>(home: string, body: () => Promise<T>): Promise<T> {
  await mkdir(join(home, 'lessons'), { recursive: true });
  const release = await waitForLockFile(join(home, 'lessons', '.proposals.lock'));
  try {
    return await body();
  } finally {
    await release();
  }
}

/** Adds proposals whose id is not queued yet. */
export async function appendProposals(ps: Proposal[], home = antonHome()): Promise<void> {
  await withQueueLock(home, async () => {
    const all = await readProposals(home);
    const ids = new Set(all.map((p) => p.id));
    const fresh = ps.filter((p) => !ids.has(p.id) && ids.add(p.id));
    if (fresh.length) await write([...all, ...fresh], home);
  });
}

export async function removeProposal(id: string, home = antonHome()): Promise<void> {
  await withQueueLock(home, async () => write((await readProposals(home)).filter((p) => p.id !== id), home));
}

/** Binds a lesson decision to the exact proposal the owner saw. */
export function proposalRevision(p: Proposal): string {
  return createHash('sha256').update(JSON.stringify(p)).digest('hex');
}

const LESSON_TARGETS = [...(Object.values(LESSON_FILES) as string[]), ...KIT_LESSON_FILES];

export type LessonDecision = { proposalId: string; decision: 'accept' | 'reject'; text?: string; revision?: string };
export type LessonOutcome =
  | { status: 'rejected' }
  | { status: 'accepted'; file: string; id: string }
  | { status: 'duplicate'; id: string }
  | { status: 'plugin'; plugin: string; stage: string }
  | { status: 'stale' }
  | { status: 'failed'; message: string };

/**
 * Accept (optionally with edited text) or reject one queued proposal, shared by the CLI and Slack. The
 * check, the lesson write and the queue removal run under the queue lock, so two deciders never both act.
 */
export async function decideProposal(d: LessonDecision, home = antonHome()): Promise<LessonOutcome> {
  return withQueueLock(home, async () => {
    const queue = await readProposals(home);
    const p = queue.find((x) => x.id === d.proposalId);
    if (!p || (d.revision !== undefined && proposalRevision(p) !== d.revision)) return { status: 'stale' };
    const drop = () => write(queue.filter((x) => x.id !== p.id), home);
    if (d.decision === 'reject') {
      await drop();
      return { status: 'rejected' };
    }
    if (p.kind === 'plugin') {
      await drop();
      return { status: 'plugin', plugin: p.plugin ?? '', stage: p.stage ?? '' };
    }
    // The queue file is on disk and editable: only known lesson files are valid targets.
    if (!p.target || !LESSON_TARGETS.includes(p.target)) return { status: 'failed', message: `Unknown lesson file "${p.target ?? ''}"` };
    try {
      const l = await addLesson(p.target, d.text ?? p.text ?? '', home);
      await drop();
      return { status: 'accepted', file: p.target, id: l.id };
    } catch (e) {
      if (e instanceof DuplicateLessonError) {
        // Already in the file: keeping the proposal would ask again forever.
        await drop();
        return { status: 'duplicate', id: e.id };
      }
      return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
  });
}
