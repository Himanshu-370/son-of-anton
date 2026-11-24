import { z } from 'zod';
import type { SlackConfig, SlackRole } from './config.js';
import { antonHome } from '../core/paths.js';

export { specRevision } from './artifacts.js';

export const projectId = z.string().max(72).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const jobId = z.string().max(72).regex(/^[1-9]\d*-[a-z0-9]+(?:-[a-z0-9]+)*$/);
const occurrence = z.string().max(96).regex(/^[A-Za-z0-9]+(?:[-_:.][A-Za-z0-9]+)*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const checkId = z.string().regex(/^AC-[1-9]\d{0,5}$/);
const deliveryId = z.string().regex(/^delivered-[1-9]\d{0,14}$/);
const count = z.number().int().min(0).max(1_000_000).optional();
const counts = { count, passed: count, failed: count };
const job = { scope: z.literal('job'), source: z.enum(['factory', 'bench']), project: projectId, jobId, ...counts };
const workspace = { scope: z.literal('workspace'), occurrence, ...counts };

export const MilestoneSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...job, kind: z.literal('spec-ready'), occurrence: digest }),
  z.strictObject({ ...job, kind: z.literal('delivery-ready'), occurrence: deliveryId }),
  z.strictObject({
    ...job, kind: z.literal('screenshot-ready'),
    occurrence: z.string().regex(/^AC-[1-9]\d{0,5}:[a-f0-9]{64}$/),
    checkId, sha256: digest,
  }).refine(({ occurrence, checkId, sha256 }) => occurrence === `${checkId}:${sha256}`),
  z.strictObject({ ...job, kind: z.literal('build-handoff'), occurrence, role: z.enum(['frontend', 'backend', 'infra']) }),
  z.strictObject({ ...job, kind: z.enum(['spec-questions', 'spec-reminder']), occurrence: z.string().regex(/^round-[1-9]\d{0,5}$/) }),
  z.strictObject({ ...job, kind: z.literal('spec-stopped'), occurrence: z.string().uuid() }),
  z.strictObject({
    ...job, occurrence,
    kind: z.enum(['plan-ready', 'checks-complete', 'code-review-complete', 'security-review-complete', 'budget-warning', 'budget-paused']),
  }),
  z.strictObject({ ...workspace, kind: z.enum(['lesson-proposed', 'bench-summary', 'plugin-updated']) }),
]);

export type Milestone = z.infer<typeof MilestoneSchema>;

/** A Retro's lesson-proposed occurrence names its job; the coach card lists that job's queued proposals. */
export const lessonOccurrence = (project: string, jobId: string) => `${project}:${jobId}`;
export function lessonOccurrenceJob(occurrence: string): { project: string; jobId: string } | undefined {
  const [project, jobId, ...rest] = occurrence.split(':');
  return project && jobId && !rest.length && projectId.safeParse(project).success && jobId.length <= 72 ? { project, jobId } : undefined;
}

const milestones = {
  'spec-ready': ['pm', 'Spec was prepared for approval'],
  'spec-questions': ['pm', 'The PM has questions about the spec'],
  'spec-reminder': ['pm', 'Reminder: the PM is still waiting for your answers'],
  'spec-stopped': ['pm', 'The PM turn stopped. Nothing was repeated; check the CLI'],
  'plan-ready': ['tech_lead', 'Build plan ready'],
  'build-handoff': [null, 'Build handoff complete'],
  'checks-complete': ['qa', 'Verification checks complete'],
  'delivery-ready': ['qa', 'Delivery was prepared for final review'],
  'screenshot-ready': ['qa', 'QA evidence selected for sharing'],
  'code-review-complete': ['code_reviewer', 'Code review complete'],
  'security-review-complete': ['security_reviewer', 'Security review complete'],
  'budget-warning': ['pm', 'Budget warning'],
  'budget-paused': ['pm', 'Job paused at the budget limit'],
  'lesson-proposed': ['coach', 'Lesson proposed'],
  'bench-summary': ['pm', 'Benchmark summary'],
  'plugin-updated': ['pm', 'Plugin configuration updated'],
} as const satisfies Record<Milestone['kind'], readonly [SlackRole | null, string]>;

export function eventRole(event: Milestone): SlackRole {
  return event.kind === 'build-handoff' ? event.role : milestones[event.kind][0];
}

export function eventText(event: Milestone): string {
  const [, title] = milestones[event.kind];
  const counts = (['count', 'passed', 'failed'] as const).flatMap((name) =>
    event[name] === undefined ? [] : [`${name}: ${event[name]}`]);
  const text = counts.length ? `${title} (${counts.join(', ')})` : title;
  return event.kind === 'spec-ready' || event.kind === 'delivery-ready'
    ? `${text}. Check the CLI for current status.`
    : text;
}

export interface PublishMilestoneDeps {
  /** Anton's data directory, the same argument accepted by configuration loading. */
  home?: string;
  loadConfig?: (home?: string) => Promise<SlackConfig | undefined>;
}

export async function configuredSlack(deps: PublishMilestoneDeps): Promise<SlackConfig | undefined> {
  const load = deps.loadConfig ?? (await import('./config.js')).loadSlackConfig;
  return load(deps.home ?? antonHome());
}

/** Local intake is optional for every caller. A stable checkpoint can be recovered from disk. */
export async function publishMilestone(event: Milestone, deps: PublishMilestoneDeps = {}): Promise<void> {
  try {
    const parsed = MilestoneSchema.safeParse(event);
    if (!parsed.success || (parsed.data.scope === 'job' && parsed.data.source === 'bench')) return;
    const config = await configuredSlack(deps);
    if (!config) return;
    const { enqueueMilestone } = await import('./outbox.js');
    await enqueueMilestone(parsed.data, { config, home: deps.home });
  } catch {
    // The factory continues when Slack is unconfigured or its local queue is unavailable.
  }
}
