import { z } from 'zod';
import { NoJobs } from '../core/job.js';
import { checkpointRevision, loadJob, readJobFinding, resumeRunnerAvailable, stopTarget, targetOf, type ActionTarget, type LoadedJob } from '../core/job-actions.js';
import { readSpecContinuation, specContinuationDigest, specStatus } from '../core/spec-continuation.js';
import type { Stage } from '../core/state.js';
import { ACTIVE_STAGES } from '../pipeline/runner.js';
import { ANSWER_LIMIT, DESCRIPTION_LIMIT, NOTES_LIMIT, REASON_LIMIT, type Operation } from './actions.js';
import { jobId, projectId } from './events.js';
import { sanitizeSlackText } from './inbound.js';

const fields = {
  project: projectId,
  jobId,
  description: z.string().min(1).max(DESCRIPTION_LIMIT),
  notes: z.string().min(1).max(NOTES_LIMIT),
  budgetUsd: z.number().positive(),
  acceptAsIs: z.boolean(),
  riskId: z.string().regex(/^SEC-[A-Za-z0-9-]{1,40}$/),
  reason: z.string().min(1).max(REASON_LIMIT),
  answers: z.array(z.string().min(1).max(ANSWER_LIMIT)).min(1).max(20),
  clarify: z.string().min(1).max(300),
};
type Args = Partial<{ [K in keyof typeof fields]: z.infer<(typeof fields)[K]> }>;
type Field = keyof Args;
type TargetOperation = Extract<Operation, { target: ActionTarget }>;
type JobIntent = {
  description: string;
  fields: readonly Field[];
  required?: Partial<Record<Field, string>>;
  stages: readonly Stage[];
  check?: (job: LoadedJob, args: Args) => string | undefined;
  toOperation: (target: ActionTarget, args: Args, round?: number) => TargetOperation;
};

const reviewStages = ['awaiting_spec_approval', 'awaiting_final_review'] as const;
const terminalStages = ['done', 'abandoned'] as const;
const notesRequired = { notes: 'What changes should the PM make?' };
const jobIntent = (entry: JobIntent) => ({ ...entry, fields: ['project', 'jobId', ...entry.fields] as Field[] });

export const intentRegistry = {
  status: { description: 'Show progress or budget from the current job records.', fields: ['project', 'jobId'] },
  question: { description: 'Answer a question about a project.', fields: ['project', 'jobId'] },
  help: { description: 'Explain what the PM can do.', fields: [] },
  lessons: { description: 'List pending lessons for review.', fields: [] },
  unclear: { description: 'Ask one short question when the request is ambiguous.', fields: ['clarify'] },
  start_new: { description: 'Start a new project. Extract the requested description.', fields: ['description'] },
  start_change: { description: 'Start work on an existing project. Extract the requested description.', fields: ['project', 'jobId', 'description'] },
  approve: jobIntent({
    description: 'Approve the waiting spec or final delivery.', fields: [], stages: reviewStages,
    toOperation: (target) => ({ kind: 'approve', target }),
  }),
  reject: jobIntent({
    description: 'Reject a waiting review and extract the requested changes as notes.', fields: ['notes'],
    required: notesRequired, stages: reviewStages,
    toOperation: (target, args) => ({
      kind: target.stage === 'awaiting_spec_approval' ? 'spec-revise' : 'reject', target, notes: args.notes!,
    }),
  }),
  revise_spec: jobIntent({
    description: 'Request changes to the waiting spec and extract those changes as notes.', fields: ['notes'],
    required: notesRequired, stages: ['awaiting_spec_approval'],
    toOperation: (target, args) => ({ kind: 'spec-revise', target, notes: args.notes! }),
  }),
  spec_retry: jobIntent({
    description: 'Retry an interrupted PM spec turn.', fields: [], stages: ['spec'],
    toOperation: (target) => ({ kind: 'spec-retry', target }),
  }),
  spec_answer: jobIntent({
    description: 'Answer the pending spec questions. Extract answers in question order.', fields: ['answers'], stages: ['spec'],
    required: { answers: 'What are your answers to the spec questions?' },
    toOperation: (target, args, round) => ({ kind: 'spec-answer', target, round: round!, answers: args.answers! }),
  }),
  resume: jobIntent({
    description: 'Resume a job. Extract an optional total budget in USD or an explicit request to accept as-is.',
    fields: ['budgetUsd', 'acceptAsIs'], stages: ['paused', ...ACTIVE_STAGES],
    check: ({ state }, { budgetUsd, acceptAsIs }) => {
      if (acceptAsIs && !(state.stage === 'paused' && (state.pausedFrom === 'build' || state.pausedFrom === 'verify'))) {
        return 'Accept as-is is available when the job paused during build or verify.';
      }
      if (budgetUsd !== undefined && budgetUsd <= state.spentUsd) return 'The new budget must exceed the amount already spent.';
      return undefined;
    },
    toOperation: (target, args) => ({ kind: 'resume', target, budget: args.budgetUsd, acceptAsIs: args.acceptAsIs }),
  }),
  stop: jobIntent({
    description: 'Stop the current runner and pause the job.', fields: [], stages: ACTIVE_STAGES,
    toOperation: (target) => ({ kind: 'stop', target }),
  }),
  abandon: jobIntent({
    description: 'Give up on the current job permanently.', fields: [],
    stages: ['spec', ...reviewStages, 'paused', ...ACTIVE_STAGES],
    toOperation: (target) => ({ kind: 'abandon', target }),
  }),
  accept_risk: jobIntent({
    description: 'Accept a security finding. Extract its riskId and the reason explicitly given by the Owner.',
    fields: ['riskId', 'reason'], stages: ['paused', 'awaiting_final_review'],
    required: { riskId: 'Which finding ID are you accepting?', reason: 'Why are you accepting that finding?' },
    toOperation: (target, args) => ({ kind: 'accept-risk', target, findingId: args.riskId!, reason: args.reason! }),
  }),
} satisfies Record<string, { description: string; fields: readonly Field[] } | (JobIntent & { fields: Field[] })>;

const names = Object.keys(intentRegistry) as (keyof typeof intentRegistry)[];
export const intentDescriptions = names.map((name) => {
  const { description, fields } = intentRegistry[name];
  return `- ${name}: ${description}${fields.length ? ` Fields: ${fields.join(', ')}.` : ''}`;
}).join('\n');

const optionalFields = Object.fromEntries(
  (Object.keys(fields) as Field[]).map((name) => [name, fields[name].optional()]),
) as { [K in Field]: z.ZodOptional<(typeof fields)[K]> };

export const intentSchema = z.strictObject({ intent: z.enum(names), ...optionalFields }).superRefine((value, ctx) => {
  const { intent, ...args } = value;
  const allowed: readonly Field[] = intentRegistry[intent].fields;
  for (const name of Object.keys(args) as Field[]) {
    if (args[name] !== undefined && !allowed.includes(name)) {
      ctx.addIssue({ code: 'custom', path: [name], message: `Field does not apply to ${intent}` });
    }
  }
});

export type Intent = z.infer<typeof intentSchema>;
type ReadOnly = 'help' | 'lessons' | 'status' | 'question';
export type IntentResolution =
  | { kind: 'read-only'; intent: ReadOnly; project?: string }
  | { kind: 'operation'; operation: Exclude<Operation, { kind: 'status' }>; target?: ActionTarget; specTurn?: string }
  | { kind: 'clarification' | 'refused'; text: string };

export type IntentContext = {
  projects: readonly string[];
  channelProject?: string;
  home?: string;
  loadJob?: typeof loadJob;
  listTags?: Parameters<typeof checkpointRevision>[1];
};

const clarify = (text: string): IntentResolution => ({ kind: 'clarification', text });
const refuse = (text: string): IntentResolution => ({ kind: 'refused', text });

/** Resolve only against current registered projects and job state. Produces a preview, with no effects. */
export async function resolveIntent(value: Intent, context: IntentContext): Promise<IntentResolution> {
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) return clarify('What would you like the PM to do?');
  const { intent, ...args } = parsed.data;
  const textLimits = { notes: NOTES_LIMIT, reason: REASON_LIMIT, description: DESCRIPTION_LIMIT, clarify: 300 };
  for (const key of Object.keys(textLimits) as (keyof typeof textLimits)[]) {
    args[key] = sanitizeSlackText(args[key], textLimits[key]) || undefined;
  }
  if (args.answers) {
    args.answers = args.answers.map((answer) => sanitizeSlackText(answer, ANSWER_LIMIT));
    if (args.answers.some((answer) => !answer)) args.answers = undefined;
  }
  if (intent === 'unclear') return clarify(args.clarify ?? 'What would you like the PM to do?');
  if (intent === 'help' || intent === 'lessons') return { kind: 'read-only', intent };
  if (intent === 'start_new' || intent === 'start_change') {
    if (!args.description) return clarify('What work would you like to start?');
    if (intent === 'start_new') return { kind: 'operation', operation: { kind: 'start', mode: 'new', description: args.description } };
  }

  const entry = intentRegistry[intent];
  if ('stages' in entry) {
    for (const [field, question] of Object.entries(entry.required ?? {})) {
      if (!args[field as Field]) return clarify(question);
    }
  }

  const projects = [...new Set(context.projects.filter((name) => projectId.safeParse(name).success))];
  if (args.project && !projects.includes(args.project)) return refuse(`There is no registered project named ${args.project}.`);
  let project = args.project ?? projects.find((name) => name === context.channelProject);
  if (intent === 'status' && !project && !args.jobId) return { kind: 'read-only', intent };
  if (!project && projects.length === 1) project = projects[0];
  const readJob = async (name: string): Promise<LoadedJob | undefined> => {
    try {
      return await (context.loadJob ?? loadJob)(name, { allowBench: true });
    } catch (e) {
      if (e instanceof NoJobs || (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  };

  let job: LoadedJob | undefined;
  const eligibleCheckpoints = 'stages' in entry ? reviewStages.filter((stage) => entry.stages.includes(stage)) : [];
  if (!project && projects.length > 1 && (args.jobId || eligibleCheckpoints.length)) {
    const candidates = (await Promise.all(projects.map(readJob))).filter((job): job is LoadedJob =>
      job !== undefined && job.state.bench === undefined && (args.jobId ? job.jobId === args.jobId : eligibleCheckpoints.some((stage) => stage === job.state.stage)),
    );
    if (candidates.length === 1) {
      job = candidates[0]!;
      project = job.name;
    }
  }
  if (!project) {
    if (!projects.length) return refuse('There are no registered projects yet.');
    return clarify(`Which project? ${projects.slice(0, 8).join(', ')}.`);
  }
  if ((intent === 'status' || intent === 'question') && !args.jobId) return { kind: 'read-only', intent, project };

  job ??= await readJob(project);
  if (args.jobId && job?.jobId !== args.jobId) return refuse(`${args.jobId} is no longer the current job for ${project}.`);
  if (intent === 'status' || intent === 'question') return { kind: 'read-only', intent, project };

  if (job?.state.bench !== undefined) return refuse('Bench jobs are managed by anton bench.');
  if (intent === 'start_change') {
    const stage = job?.state.stage;
    if (job && !terminalStages.some((terminal) => terminal === stage)) return refuse(`${project} already has an active job (${job.jobId}).`);
    return {
      kind: 'operation',
      operation: { kind: 'start', mode: 'change', project, description: args.description! },
      ...(job ? { target: targetOf(job) } : {}),
    };
  }
  if (!job) return refuse(`${project} has no current job.`);
  if (!('stages' in entry)) return refuse('This action is unavailable.');
  if (!entry.stages.includes(job.state.stage)) return refuse(`${project}: this action is unavailable at stage ${job.state.stage}.`);
  const reason = entry.check?.(job, args);
  if (reason) return refuse(reason);
  if (intent === 'resume') {
    if (!(await resumeRunnerAvailable(job))) return refuse('A runner is already active or starting for this project.');

  }
  if (intent === 'stop') {
    const target = await stopTarget(job);
    return target
      ? { kind: 'operation', operation: entry.toOperation(target, args) }
      : refuse('There is no identifiable runner to stop.');
  }
  if (intent === 'accept_risk' && !(await readJobFinding(job.jobDir, args.riskId!))) {
    return refuse(`No finding named ${args.riskId} is recorded for this job.`);
  }

  let round: number | undefined;
  let specTurn: string | undefined;
  if (intent === 'spec_retry' || intent === 'spec_answer') {
    const continuation = await readSpecContinuation(project, job.jobId, context.home);
    const status = continuation && specStatus(continuation);
    if (intent === 'spec_retry' && (status !== 'stopped' || !continuation?.pending)) return refuse('There is no interrupted spec turn to retry.');
    if (intent === 'spec_answer') {
      if (status !== 'awaiting' || !continuation?.questions?.length) return refuse('There are no pending spec questions.');
      if (args.answers?.length !== continuation.questions.length) return clarify(`Please give all ${continuation.questions.length} answers in order.`);
      round = continuation.round;
    }
    if (continuation) specTurn = specContinuationDigest(continuation);
  }

  const revision = await checkpointRevision(job, context.listTags);
  if (reviewStages.some((stage) => stage === job.state.stage) && !revision) return refuse('The current checkpoint could not be verified.');
  const target = { ...targetOf(job), ...(revision === undefined ? {} : { revision }) };
  return { kind: 'operation', operation: entry.toOperation(target, args, round), ...(specTurn ? { specTurn } : {}) };
}
