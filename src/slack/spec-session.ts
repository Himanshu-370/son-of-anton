import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { commitAll } from '../core/git.js';
import { createChangeJob, createNewProject } from '../core/job.js';
import { checkpointRevision, loadJob, preflightOr2, reopenSpec, type ActionTarget } from '../core/job-actions.js';
import { antonHome, jobDir as jobDirOf } from '../core/paths.js';
import { getProject } from '../core/registry.js';
import { loadSecrets } from '../core/secrets.js';
import {
  claimSpecRound, holderAlive, listSpecContinuations, markReminded, readSpecContinuation, runClaimedRound, runSpecRound,
  SPEC_REMINDER_MS, specStatus, type SpecJob, type SpecRoundDeps, type SpecRoundResult,
} from '../core/spec-continuation.js';
import { loadState } from '../core/state.js';
import { readProposals, proposalRevision } from '../lessons/proposals.js';
import { loadAcceptedRisks } from '../security/risks.js';
import { SpecDocBaseSchema } from '../stages/spec.js';
import type { ActionResult, NewCard, SlackSpecDeps } from './actions.js';
import { readCheckedFile } from './artifacts.js';
import type { SlackConfig } from './config.js';
import { lessonOccurrenceJob, publishMilestone, type Milestone } from './events.js';
import { renderReview, type ReviewButton, type SlackBlock } from './views.js';

/*
 * The spec conversation from Slack: start work, ask the PM's questions in the job thread, take the owner's
 * answers, revise on request, and remind once. Each paid PM turn runs through the shared spec continuation,
 * so the CLI (`anton spec <project>`) can answer the same round and only one surface ever does.
 */

const slack = (d: Omit<SpecRoundDeps, 'surface'>): SpecRoundDeps => ({ ...d, surface: 'slack' });
const done = (...lines: string[]): ActionResult => ({ status: 'done', lines });

function toAction(r: SpecRoundResult): ActionResult {
  const status = r.status === 'questions' || r.status === 'spec' ? 'done' : r.status === 'stopped' ? 'failed' : r.status;
  return { status, lines: r.lines };
}

/** The spec job for a project's job ID, from its saved description and kind. */
export async function specJobFor(project: string, jobId: string): Promise<SpecJob> {
  const { repoPath } = await getProject(project);
  const dir = jobDirOf(repoPath, jobId);
  const state = await loadState(dir);
  const description = (await readFile(join(dir, 'description.txt'), 'utf8').catch(() => '')).trim();
  return { project, repoPath, jobId, jobDir: dir, description, mode: state.kind };
}

/** First PM turn for a job started from Slack. Persists the questions (or the spec) and returns. */
export async function openSlackSpec(job: SpecJob, deps: Omit<SpecRoundDeps, 'surface'>): Promise<void> {
  await runSpecRound(job, { kind: 'start' }, slack(deps));
}

/** `/anton new`, `/anton change` or a DM instruction: create the job exactly as the CLI does, then ask the PM. */
export async function startSlackJob(
  op: { mode: 'new' | 'change'; project?: string; description: string }, deps: SlackSpecDeps,
): Promise<ActionResult> {
  const lines: string[] = [];
  if ((await preflightOr2({ preflight: deps.preflight, err: (l) => lines.push(l) })) !== 0) return { status: 'refused', lines };
  await deps.ensureImage();
  let job: SpecJob;
  if (op.mode === 'new') {
    const p = await createNewProject(op.description);
    await commitAll(p.repoPath, 'chore: initialize project');
    job = { project: p.name, repoPath: p.repoPath, jobId: p.jobId, jobDir: p.jobDir, description: op.description, mode: 'new' };
  } else {
    // A bad secrets file must fail before createChangeJob creates and switches the branch.
    await loadSecrets(op.project!);
    const p = await createChangeJob(op.project!, op.description);
    job = { project: p.name, repoPath: p.repoPath, jobId: p.jobId, jobDir: p.jobDir, description: op.description, mode: 'change' };
  }
  const r = await runSpecRound(job, { kind: 'start' }, slack(deps));
  return { ...toAction(r), lines: [`Started project ${job.project} (job ${job.jobId}).`, ...r.lines] };
}

/** The owner's answers to one round. The round claim makes a competing or late answer stale. */
export async function submitSpecAnswers(
  target: ActionTarget & { round: number }, answers: string[], deps: Omit<SpecRoundDeps, 'surface'>,
): Promise<ActionResult> {
  const job = await specJobFor(target.project, target.jobId);
  return toAction(await runSpecRound(job, { kind: 'answers', round: target.round, answers }, slack(deps)));
}

/** Request changes on the spec card: back to `spec` under the decision lock, then a revision round. */
export async function reviseSlackSpec(
  target: ActionTarget, notes: string, deps: Omit<SpecRoundDeps, 'surface'>, listTags?: (repo: string, pattern: string) => Promise<string[]>,
): Promise<ActionResult> {
  const job = await specJobFor(target.project, target.jobId);
  const lines: string[] = [];
  const opened = await reopenSpec(target, { err: (l) => lines.push(l), listTags }, async () => {
    const claimed = await claimSpecRound(job, { kind: 'revise', notes }, slack(deps));
    if ('status' in claimed) {
      lines.push(...claimed.lines);
      return undefined;
    }
    return claimed;
  });
  if (opened.outcome.status !== 'done' || !opened.claimed) return { status: opened.outcome.status, lines };
  return toAction(await runClaimedRound(job, opened.claimed, slack(deps)));
}

/** `/anton spec retry`: the owner's explicit order to rerun an interrupted PM turn. */
export async function retrySlackSpec(target: ActionTarget, deps: Omit<SpecRoundDeps, 'surface'>): Promise<ActionResult> {
  const job = await specJobFor(target.project, target.jobId);
  return toAction(await runSpecRound(job, { kind: 'retry' }, slack(deps)));
}

/**
 * Split a thread reply into one answer per question: any text for a single question, otherwise numbered
 * items `1.` (or `1)`) through `n`, each once. Lines after an item belong to it.
 */
export function parseThreadAnswers(text: string, count: number): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed || count < 1) return undefined;
  if (count === 1) return [trimmed.replace(/^1[.)]\s*/, '') || trimmed];
  const answers: string[] = [];
  let current = -1;
  for (const line of trimmed.split('\n')) {
    const m = /^\s*(\d{1,2})[.)]\s*(.*)$/.exec(line);
    if (m && Number(m[1]) === current + 2) {
      current++;
      answers[current] = m[2]!;
    } else if (current >= 0) answers[current] = `${answers[current]}\n${line}`.trim();
    else return undefined;
  }
  return answers.length === count && answers.every((a) => a.trim()) ? answers.map((a) => a.trim()) : undefined;
}

/**
 * Exactly one reminder per waiting round, 24 hours after the questions. Nothing expires. Restart-safe: the
 * flag is on disk and the outbox ignores a repeat of the same occurrence.
 */
export async function remindPendingSpecs(deps: { home?: string; now?: () => number; publish?: (m: Milestone) => Promise<void> } = {}): Promise<number> {
  const home = deps.home ?? antonHome();
  const now = (deps.now ?? Date.now)();
  const publish = deps.publish ?? ((m: Milestone) => publishMilestone(m, { home }));
  let sent = 0;
  for (const c of await listSpecContinuations(home)) {
    if (specStatus(c) !== 'awaiting' || c.reminded || c.askedAt === undefined || now - c.askedAt < SPEC_REMINDER_MS) continue;
    if (holderAlive(c.holder)) continue; // the terminal is asking right now
    const event: Milestone = { scope: 'job', source: 'factory', kind: 'spec-reminder', project: c.project, jobId: c.jobId, occurrence: `round-${c.round}` };
    await publish(event);
    if (await markReminded(c.project, c.jobId, c.round, home)) sent++;
  }
  return sent;
}

export type ComposedMessage = { text: string; blocks: SlackBlock[]; cards?: string[] };
type ComposeDeps = { config: SlackConfig; home?: string; channelId?: string };

function roundQuestions(c: NonNullable<Awaited<ReturnType<typeof readSpecContinuation>>>, round: number): string[] | undefined {
  const asked = c.exchanges.filter((e) => e.reply.kind === 'questions');
  const e = asked[round - 1];
  return e?.reply.kind === 'questions' ? e.reply.questions : undefined;
}

const SpecTitle = SpecDocBaseSchema.pick({ title: true, kit: true, acceptanceChecks: true });
const FindingsSchema = z.object({
  security: z.object({ findings: z.array(z.object({ id: z.string().regex(/^SEC-[A-Za-z0-9-]{1,40}$/), title: z.string().max(500).default('') }).passthrough()).default([]) }).optional(),
});

/**
 * Message content for the outbox: the PM's questions with an owner mention, and the review cards (spec,
 * delivery, paused job, lesson proposals). Cards are registered before posting; the outbox attaches the posted
 * message to them. Returns undefined for milestones that stay plain text.
 */
export async function composeSlackMessage(event: Milestone, deps: ComposeDeps): Promise<ComposedMessage | undefined> {
  const home = deps.home ?? antonHome();
  const { config } = deps;
  const mention = config.ownerId;
  if (event.scope === 'job' && (event.kind === 'spec-questions' || event.kind === 'spec-reminder')) {
    const c = await readSpecContinuation(event.project, event.jobId, home);
    const round = Number(event.occurrence.slice('round-'.length));
    const questions = c ? roundQuestions(c, round) : undefined;
    if (!questions) return undefined;
    const reminder = event.kind === 'spec-reminder';
    const view = renderReview({ kind: reminder ? 'reminder' : 'questions', project: event.project, jobId: event.jobId }, {
      mention,
      title: reminder
        ? 'Reminder: the PM is still waiting for your answers. There is no deadline.'
        : 'The PM has questions about the spec.',
      lines: [
        ...questions.map((q, i) => `${i + 1}. ${q}`),
        '',
        questions.length > 1 ? 'Reply in this thread with numbered answers (1., 2., ...).' : 'Reply in this thread with your answer.',
        `Or answer on the Mac: anton spec ${event.project}`,
      ],
    });
    return { text: view.text, blocks: view.blocks };
  }
  if (!deps.channelId) return undefined;
  const { registerActionCard } = await import('./actions.js');
  const tokens: string[] = [];
  const card = async (c: Omit<NewCard, 'channelId'>, label: string, style?: ReviewButton['style'], confirm?: string): Promise<ReviewButton> => {
    const token = await registerActionCard({ ...c, channelId: deps.channelId! } as NewCard, { config, home });
    tokens.push(token);
    return { label, token, ...(style ? { style } : {}), ...(confirm ? { confirm } : {}) };
  };
  if (event.scope === 'job' && event.kind === 'spec-ready') {
    const job = await loadJob(event.project);
    const raw = await readCheckedFile(job.jobDir, ['spec.json'], 64 * 1024);
    const spec = raw ? SpecTitle.safeParse(JSON.parse(raw.toString('utf8'))) : undefined;
    const target = { project: event.project, jobId: event.jobId, stage: 'awaiting_spec_approval' as const, revision: event.occurrence };
    const buttons = [
      await card({ kind: 'approve', role: 'pm', target }, 'Approve spec', 'primary'),
      await card({ kind: 'spec-revise', role: 'pm', target }, 'Request changes…'),
    ];
    const view = renderReview({ kind: 'spec', project: event.project, jobId: event.jobId }, {
      mention,
      title: `Spec ready for approval: ${spec?.success ? spec.data.title : event.project}`,
      lines: spec?.success ? [`Kit: ${spec.data.kit}`, `Acceptance checks: ${spec.data.acceptanceChecks.length}`, 'The full spec is attached below.'] : [],
      buttons,
    });
    return { ...view, cards: tokens };
  }
  if (event.scope === 'job' && event.kind === 'delivery-ready') {
    const job = await loadJob(event.project);
    const target = { project: event.project, jobId: event.jobId, stage: 'awaiting_final_review' as const, revision: event.occurrence };
    const buttons = [
      await card({ kind: 'approve', role: 'qa', target }, 'Approve delivery', 'primary'),
      await card({ kind: 'reject', role: 'qa', target }, 'Reject…', 'danger'),
    ];
    const raw = await readCheckedFile(job.jobDir, ['evidence', 'results.json'], 1024 * 1024);
    let findings: { id: string; title: string }[] = [];
    try {
      findings = raw ? (FindingsSchema.parse(JSON.parse(raw.toString('utf8'))).security?.findings ?? []) : [];
    } catch {
      findings = [];
    }
    const accepted = new Set((await loadAcceptedRisks(job.jobDir).catch(() => [])).map((r) => r.id));
    const open = findings.filter((f) => !accepted.has(f.id)).slice(0, 5);
    const sections = [];
    for (const f of open) {
      sections.push({ text: `${f.id}: ${f.title}`, buttons: [await card({ kind: 'accept-risk', role: 'qa', target, findingId: f.id }, `Accept risk ${f.id}…`)] });
    }
    const view = renderReview({ kind: 'delivery', project: event.project, jobId: event.jobId }, {
      mention, title: `Delivery ${event.occurrence.slice('delivered-'.length)} is ready for final review`,
      lines: ['Review REPORT.md on the Mac or the evidence in this thread.'], buttons, sections,
    });
    return { ...view, cards: tokens };
  }
  if (event.scope === 'job' && event.kind === 'budget-paused') {
    // Bound to this pause: a card from an earlier pause is stale at a later one.
    const revision = /^paused-\d{1,15}$/.test(event.occurrence) ? event.occurrence : (await checkpointRevision(await loadJob(event.project))) ?? 'paused-0';
    const target = { project: event.project, jobId: event.jobId, stage: 'paused' as const, revision };
    const buttons = [
      await card({ kind: 'resume', role: 'pm', target }, 'Resume…', 'primary'),
      await card({ kind: 'abandon', role: 'pm', target }, 'Abandon', 'danger', 'This abandons the job. It cannot be resumed.'),
    ];
    const view = renderReview({ kind: 'paused', project: event.project, jobId: event.jobId }, {
      mention, title: 'Job paused at the budget limit', lines: ['Resume with a higher budget, or abandon the job.'], buttons,
    });
    return { ...view, cards: tokens };
  }
  if (event.scope === 'workspace' && event.kind === 'lesson-proposed') {
    const { project, jobId } = lessonOccurrenceJob(event.occurrence) ?? {};
    if (!project) return undefined;
    const proposals = (await readProposals(home)).filter((p) => p.project === project && p.jobId === jobId).slice(0, 7);
    if (!proposals.length) return undefined;
    const sections = [];
    for (const p of proposals) {
      const proposal = { id: p.id, revision: proposalRevision(p) };
      const buttons = [await card({ kind: 'lesson-accept', role: 'coach', proposal }, 'Accept', 'primary')];
      if (p.kind === 'lesson') buttons.push(await card({ kind: 'lesson-edit', role: 'coach', proposal }, 'Edit…'));
      buttons.push(await card({ kind: 'lesson-reject', role: 'coach', proposal }, 'Reject'));
      const what = p.kind === 'lesson' ? `Lesson for ${p.target ?? '?'}: ${p.text ?? ''}` : `Plugin for ${p.stage ?? '?'}: ${p.plugin ?? ''}`;
      sections.push({ text: `${what}\nWhy: ${p.why}`, buttons });
    }
    const view = renderReview({ kind: 'lessons' }, {
      mention, title: `The coach proposes ${proposals.length} lesson(s) from ${project}`,
      lines: ['Retro output is untrusted until you accept it.'], sections,
    });
    return { ...view, cards: tokens };
  }
  return undefined;
}
