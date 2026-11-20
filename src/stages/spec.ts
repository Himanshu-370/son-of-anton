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

const specShape = {
  title: z.string().min(1),
  summary: z.string(),
  outOfScope: z.array(z.string()),
  kit: z.literal('fallback'),
  tech: z.array(z.string()),
  acceptanceChecks: z.array(AcceptanceCheckSchema).min(1),
  /** Outside services the project calls, with the env var names each needs. Default [] keeps older spec.json files parsing. */
  services: z.array(z.object({ name: z.string().min(1), envVars: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'env var names only, never values')) })).default([]),
};

/** Structure without the id-sequence rule; used when reading human-edited specs. */
export const SpecDocBaseSchema = z.object(specShape);

export const SpecDocSchema = SpecDocBaseSchema.refine(
  (s) => s.acceptanceChecks.every((c, i) => c.id === `AC-${i + 1}`),
  { message: 'acceptance check ids must be sequential AC-1..AC-n' },
);
export type SpecDoc = z.infer<typeof SpecDocBaseSchema>;

const turnShape = {
  kind: z.enum(['questions', 'spec']),
  questions: z.array(z.string().min(1)).optional(),
  spec: SpecDocSchema.optional(),
};
const SpecTurnSchema = z.object(turnShape).superRefine((t, ctx) => {
  if (t.kind === 'questions' && !t.questions?.length) {
    ctx.addIssue({ code: 'custom', message: 'kind=questions requires non-empty questions', path: ['questions'] });
  }
  if (t.kind === 'spec' && !t.spec) {
    ctx.addIssue({ code: 'custom', message: 'kind=spec requires spec', path: ['spec'] });
  }
});
const SpecOnlyTurnSchema = z.object({ kind: z.literal('spec'), spec: SpecDocSchema });

export class SpecNotProduced extends Error {
  constructor(message = 'agent did not produce a spec') {
    super(message);
    this.name = 'SpecNotProduced';
  }
}

export type SpecDeps = { runAgent?: typeof defaultRunAgent };

const SPEC_ONLY_JSON_SCHEMA = z.toJSONSchema(SpecOnlyTurnSchema) as Record<string, unknown>;
const SPEC_TURN_JSON_SCHEMA = z.toJSONSchema(z.object(turnShape)) as Record<string, unknown>;

const CHANGE_NOTE = `This is a change to an existing codebase, so the spec covers the change, not the whole project. Read .anton/repo-map.md and the relevant code first. List what must keep working (existing behaviour the change must not break) as acceptance checks. If the repo has few or no tests, propose characterization acceptance checks that pin the current behaviour before the change.`;

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
  const run = deps.runAgent ?? defaultRunAgent;
  const systemPrompt = await loadPrompt('spec.md');
  const { model, effort } = ROLE_MODELS.pm;
  let cur: StageCtx = ctx;
  let sessionId: string | undefined;
  /** The previous call's cumulative SDK total; a resumed session's total continues from it. */
  let baseUsd = 0;
  let prompt = mode === 'change' ? `Description of the change:\n\n${description}` : `Description of what to build:\n\n${description}`;
  if (mode === 'change') prompt += `\n\n${CHANGE_NOTE}`;

  for (let call = 0; call <= MAX_QUESTION_ROUNDS; call++) {
    const final = call === MAX_QUESTION_ROUNDS;
    if (final) prompt += '\n\nYou have no more question rounds. Please write the spec now.';
    const req: AgentRequest = {
      role: 'pm',
      model,
      effort,
      systemPrompt,
      prompt,
      outputSchema: final ? SPEC_ONLY_JSON_SCHEMA : SPEC_TURN_JSON_SCHEMA,
      ...(sessionId ? { resumeSessionId: sessionId, baseUsd } : {}),
      maxTurns: 30,
      budgetUsd: remainingUsd(cur.state),
    };
    const res = await run(cur, req);
    cur = { ...cur, state: res.state };
    sessionId = res.sessionId;
    baseUsd = res.totalUsd ?? 0;
    const turn = SpecTurnSchema.parse(res.output);
    if (turn.kind === 'spec') return { spec: turn.spec!, state: res.state };
    if (final) throw new SpecNotProduced();
    const questions = turn.questions!;
    const answers = await ask(questions);
    prompt = questions.map((q, i) => `Q: ${q}\nA: ${answers[i] ?? '(no answer)'}`).join('\n\n');
  }
  throw new SpecNotProduced();
}

function renderSpec(s: SpecDoc): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
  return [
    `# ${s.title}`,
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

export async function writeSpec(jobDir: string, spec: SpecDoc, secrets?: Record<string, string>): Promise<void> {
  const md = redact(renderSpec(spec), secrets);
  await writeFileAtomic(join(jobDir, 'spec.json'), redact(JSON.stringify(spec, null, 2) + '\n', secrets));
  await writeFileAtomic(join(jobDir, 'spec.generated.md'), md);
  await writeFileAtomic(join(jobDir, 'spec.md'), md);
}

/** Title and acceptance checks come from (possibly human-edited) spec.md; the rest from spec.json. */
export async function readApprovedSpec(jobDir: string): Promise<SpecDoc> {
  const md = await fsp.readFile(join(jobDir, 'spec.md'), 'utf8');
  const base = JSON.parse(await fsp.readFile(join(jobDir, 'spec.json'), 'utf8')) as unknown;

  const title = /^# (.+)$/m.exec(md)?.[1]?.trim();
  if (!title) throw new Error('spec.md has no "# " title heading');

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

  const spec = SpecDocBaseSchema.parse({ ...(base as object), title, acceptanceChecks: checks });
  await writeFileAtomic(join(jobDir, 'spec.approved.json'), JSON.stringify(spec, null, 2) + '\n');
  return spec;
}
