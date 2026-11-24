import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runAgent as defaultRunAgent, type StageCtx } from '../agent/host-runner.js';
import type { AgentRequest } from '../agent/protocol.js';
import { writeFileAtomic } from '../core/atomic.js';
import { redact } from '../core/secrets.js';
import { remainingUsd } from '../core/budget.js';
import { ROLE_MODELS } from '../core/config.js';
import type { JobState } from '../core/state.js';
import type { AcceptanceCheck } from '../kits/types.js';
import { loadPrompt } from './prompts.js';

export const MAX_QUESTION_ROUNDS = 5;

const AcceptanceCheckSchema: z.ZodType<AcceptanceCheck> = z.object({ id: z.string().regex(/^AC-\d+$/), text: z.string().min(1) });

/** What the PM agent writes. The kit is not its choice: the spec session picks it (selectKit). */
const agentSpecShape = {
  title: z.string().min(1),
  summary: z.string(),
  outOfScope: z.array(z.string()),
  tech: z.array(z.string()),
  acceptanceChecks: z.array(AcceptanceCheckSchema).min(1),
  /** Outside services the project calls, with the env var names each needs. Default [] keeps older spec.json files parsing. */
  services: z.array(z.object({ name: z.string().min(1), envVars: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env var names only, never values')) })).default([]),
};

export const KIT_NAMES = ['fallback', 'web'] as const;

/** Structure without the id-sequence rule; used when reading human-edited specs. Default kit keeps older spec.json files parsing. */
export const SpecDocBaseSchema = z.object({ ...agentSpecShape, kit: z.enum(KIT_NAMES).default('fallback') });

const AgentSpecSchema = z.object(agentSpecShape).refine(
  (s) => s.acceptanceChecks.every((c, i) => c.id === `AC-${i + 1}`),
  { message: 'acceptance check ids must be sequential AC-1..AC-n' },
);
export type SpecDoc = z.infer<typeof SpecDocBaseSchema>;

const turnShape = {
  kind: z.enum(['questions', 'spec']),
  questions: z.array(z.string().min(1)).optional(),
  spec: AgentSpecSchema.optional(),
};
const SpecTurnSchema = z.object(turnShape).superRefine((t, ctx) => {
  if (t.kind === 'questions' && !t.questions?.length) {
    ctx.addIssue({ code: 'custom', message: 'kind=questions requires non-empty questions', path: ['questions'] });
  }
  if (t.kind === 'spec' && !t.spec) {
    ctx.addIssue({ code: 'custom', message: 'kind=spec requires spec', path: ['spec'] });
  }
});
const SpecOnlyTurnSchema = z.object({ kind: z.literal('spec'), spec: AgentSpecSchema });

export class SpecNotProduced extends Error {
  constructor(message = 'agent did not produce a spec') {
    super(message);
    this.name = 'SpecNotProduced';
  }
}

/** Persistence points around each PM call (the host-side spec continuation). Absent in plain runs. */
export type SpecHooks = {
  /** Before the paid call: `answers` are the owner's answers that produced `prompt` (absent on the first call). */
  beforeCall?: (info: { call: number; prompt: string; final: boolean; answers?: string[] }) => Promise<void>;
  /** After a valid reply, before any question is asked. */
  afterCall?: (info: { call: number; prompt: string; turn: SpecTurn; state: JobState }) => Promise<void>;
};
export type SpecDeps = { runAgent?: typeof defaultRunAgent; hooks?: SpecHooks };

const SPEC_ONLY_JSON_SCHEMA = z.toJSONSchema(SpecOnlyTurnSchema) as Record<string, unknown>;
const SPEC_TURN_JSON_SCHEMA = z.toJSONSchema(z.object(turnShape)) as Record<string, unknown>;

const CHANGE_NOTE = `This is a change to an existing codebase, so the spec covers the change, not the whole project. Read .anton/repo-map.md and the relevant code first. List what must keep working (existing behaviour the change must not break) as acceptance checks. If the repo has few or no tests, propose characterization acceptance checks that pin the current behaviour before the change.`;

export const FINAL_ROUND_NOTE = '\n\nYou have no more question rounds. Please write the spec now.';

/** The first PM prompt for a new project or a change. */
export function initialSpecPrompt(description: string, mode: 'new' | 'change'): string {
  let prompt = mode === 'change' ? `Description of the change:\n\n${description}` : `Description of what to build:\n\n${description}`;
  if (mode === 'change') prompt += `\n\n${CHANGE_NOTE}`;
  return prompt;
}

/** The owner's answers as the PM receives them, from either surface. */
export function answersPrompt(questions: string[], answers: string[]): string {
  return questions.map((q, i) => `Q: ${q}\nA: ${answers[i] ?? '(no answer)'}`).join('\n\n');
}

export type SpecTurn = { kind: 'questions'; questions: string[] } | { kind: 'spec'; spec: SpecDoc };
export type SpecTurnResult = { turn: SpecTurn; state: JobState; sessionId: string; totalUsd: number; usage?: StageCtx['baseUsage'] };

/**
 * One PM call. `resume` continues an SDK session whose transcript is still in the running container; without
 * it the call is a fresh session (zero SDK offset) and the job's persisted spend stays the cost base.
 */
export async function specTurn(
  ctx: StageCtx,
  input: { prompt: string; final: boolean; resume?: { sessionId: string; baseUsd: number } },
  deps: SpecDeps = {},
): Promise<SpecTurnResult> {
  const run = deps.runAgent ?? defaultRunAgent;
  const { model, effort } = ROLE_MODELS.pm;
  const req: AgentRequest = {
    role: 'pm',
    model,
    effort,
    systemPrompt: await loadPrompt('spec.md'),
    prompt: input.prompt,
    outputSchema: input.final ? SPEC_ONLY_JSON_SCHEMA : SPEC_TURN_JSON_SCHEMA,
    ...(input.resume ? { resumeSessionId: input.resume.sessionId, baseUsd: input.resume.baseUsd } : {}),
    maxTurns: 30,
    budgetUsd: remainingUsd(ctx.state),
  };
  const res = await run(ctx, req);
  const parsed = SpecTurnSchema.parse(res.output);
  const turn: SpecTurn = parsed.kind === 'spec'
    ? { kind: 'spec', spec: { ...parsed.spec!, kit: 'fallback' } }
    : { kind: 'questions', questions: parsed.questions! };
  return { turn, state: res.state, sessionId: res.sessionId, totalUsd: res.totalUsd ?? 0, usage: res.usage };
}

/**
 * Question loop. Returns the spec and the latest job state (cost accounting from runAgent).
 */
export async function runSpec(
  ctx: StageCtx,
  description: string,
  ask: (questions: string[]) => Promise<string[]>,
  deps: SpecDeps = {},
  mode: 'new' | 'change' = 'new',
): Promise<{ spec: SpecDoc; state: JobState }> {
  let cur: StageCtx = ctx;
  let sessionId: string | undefined;
  /** The previous call's cumulative SDK total; a resumed session's total continues from it. */
  let baseUsd = 0;
  let prompt = initialSpecPrompt(description, mode);
  let answers: string[] | undefined;

  for (let call = 0; call <= MAX_QUESTION_ROUNDS; call++) {
    const final = call === MAX_QUESTION_ROUNDS;
    if (final) prompt += FINAL_ROUND_NOTE;
    await deps.hooks?.beforeCall?.({ call, prompt, final, ...(answers ? { answers } : {}) });
    const res = await specTurn(cur, { prompt, final, ...(sessionId ? { resume: { sessionId, baseUsd } } : {}) }, deps);
    cur = { ...cur, state: res.state, baseUsage: res.usage };
    sessionId = res.sessionId;
    baseUsd = res.totalUsd;
    await deps.hooks?.afterCall?.({ call, prompt, turn: res.turn, state: res.state });
    if (res.turn.kind === 'spec') return { spec: res.turn.spec, state: res.state };
    if (final) throw new SpecNotProduced();
    const questions = res.turn.questions;
    answers = await ask(questions);
    prompt = answersPrompt(questions, answers);
  }
  throw new SpecNotProduced();
}

export type CostEstimate = { lowUsd: number; highUsd: number; n: number };

function renderSpec(s: SpecDoc, estimate?: CostEstimate): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
  return [
    `# ${s.title}`,
    '',
    `Kit: ${s.kit}`,
    estimate
      ? `Expected cost: $${estimate.lowUsd.toFixed(2)}–$${estimate.highUsd.toFixed(2)} (from ${estimate.n} similar past jobs)`
      : 'Expected cost: no history yet',
    '',
    '## Summary',
    '',
    s.summary,
    '',
    '## Out of scope',
    '',
    list(s.outOfScope),
    '',
    '## Tech',
    '',
    list(s.tech),
    '',
    '## Acceptance checks',
    '',
    s.acceptanceChecks.map((c) => `- **${c.id}**: ${c.text.replace(/\s+/g, ' ').trim()}`).join('\n'),
    '',
    '## Outside services',
    '',
    list((s.services ?? []).map((x) => `${x.name} (env: ${x.envVars.join(', ') || 'none'})`)),
    '',
  ].join('\n');
}

export async function writeSpec(jobDir: string, spec: SpecDoc, secrets?: Record<string, string>, estimate?: CostEstimate): Promise<void> {
  const md = redact(renderSpec(spec, estimate), secrets);
  await writeFileAtomic(join(jobDir, 'spec.json'), redact(JSON.stringify(spec, null, 2) + '\n', secrets));
  await writeFileAtomic(join(jobDir, 'spec.generated.md'), md);
  await writeFileAtomic(join(jobDir, 'spec.md'), md);
}

/** Title, kit and acceptance checks come from (possibly human-edited) spec.md; the rest from spec.json. */
export async function readApprovedSpec(jobDir: string): Promise<SpecDoc> {
  const md = await fsp.readFile(join(jobDir, 'spec.md'), 'utf8');
  const base = JSON.parse(await fsp.readFile(join(jobDir, 'spec.json'), 'utf8')) as unknown;

  const title = /^# (.+)$/m.exec(md)?.[1]?.trim();
  if (!title) throw new Error('spec.md has no "# " title heading');

  // An older spec.md has no Kit line: spec.json's value (default fallback) stands. Only the header
  // (before the first `## `) counts, so a "Kit:" line in the body is plain text.
  const header = md.split(/^## /m)[0]!;
  const kit = /^Kit:[ \t]*(.*?)[ \t]*$/m.exec(header)?.[1]?.trim();
  if (kit !== undefined && !(KIT_NAMES as readonly string[]).includes(kit)) {
    throw new Error(`Unknown kit "${kit}" in spec.md (use fallback or web)`);
  }

  const checks: { id: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const line of md.split('\n')) {
    const m = /^\s*- \*\*(AC-\d+)\*\*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const id = m[1]!;
    if (seen.has(id)) throw new Error(`spec.md has duplicate acceptance check ${id}`);
    seen.add(id);
    checks.push({ id, text: m[2]! });
  }
  if (checks.length === 0) throw new Error('spec.md has no acceptance checks (expected lines like "- **AC-1**: ...")');

  const spec = SpecDocBaseSchema.parse({ ...(base as object), title, acceptanceChecks: checks, ...(kit ? { kit } : {}) });
  await writeFileAtomic(join(jobDir, 'spec.approved.json'), JSON.stringify(spec, null, 2) + '\n');
  return spec;
}
