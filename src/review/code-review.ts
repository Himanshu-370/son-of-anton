import { z } from 'zod';
import { runAgent as defaultRunAgent, type StageCtx } from '../agent/host-runner.js';
import type { AgentRequest } from '../agent/protocol.js';
import { remainingUsd } from '../core/budget.js';
import { ROLE_MODELS, type Area } from '../core/config.js';
import { diffSince as defaultDiffSince } from '../core/git.js';
import type { JobState } from '../core/state.js';
import { fenceDiff, sha8 } from './shared.js';
import { loadPrompt } from '../stages/prompts.js';
import type { Plan } from '../stages/plan.js';
import type { SpecDoc } from '../stages/spec.js';

export type ReviewFinding = {
  id: string;
  severity: 'blocking' | 'non_blocking';
  area: Area;
  file: string;
  line?: number;
  summary: string;
};

const RawFindingSchema = z.object({
  severity: z.enum(['blocking', 'non_blocking']),
  area: z.enum(['frontend', 'backend', 'infra']),
  file: z.string().min(1),
  line: z.number().int().optional(),
  summary: z.string().min(1),
});
const OutputSchema = z.object({ findings: z.array(RawFindingSchema) });
const OUTPUT_JSON_SCHEMA = z.toJSONSchema(OutputSchema) as Record<string, unknown>;

export type CodeReviewDeps = {
  runAgent?: typeof defaultRunAgent;
  diffSince?: typeof defaultDiffSince;
};

/** Stable across rounds and line shifts: the first 8 hex of sha256(file + '\n' + summary). */
export function findingId(file: string, summary: string): string {
  return `CR-${sha8(`${file}\n${summary}`)}`;
}

function renderPrompt(spec: SpecDoc, plan: Plan, diff: string): string {
  const checks = spec.acceptanceChecks.map((c) => `- ${c.id}: ${c.text}`).join('\n');
  const tasks = plan.tasks.map((t) => `- ${t.id} [${t.area}] ${t.title} (${t.acceptanceChecks.join(', ') || 'no checks'})`).join('\n');
  return [
    `# Spec: ${spec.title}`,
    '',
    spec.summary,
    '',
    '## Acceptance checks',
    '',
    checks,
    '',
    '## Contract',
    '',
    plan.contract?.trim() || '(none)',
    '',
    '## Tasks',
    '',
    tasks,
    '',
    '## Diff of this round',
    '',
    'The full code is readable in `/workspace`; the diff below may be trimmed.',
    '',
    fenceDiff(diff),
  ].join('\n');
}

/** Read-only review of the round's diff. Returns findings with host-computed ids and the latest state. */
export async function runCodeReview(
  ctx: StageCtx,
  spec: SpecDoc,
  plan: Plan,
  baseSha: string,
  deps: CodeReviewDeps = {},
): Promise<{ findings: ReviewFinding[]; state: JobState }> {
  const run = deps.runAgent ?? defaultRunAgent;
  const diff = await (deps.diffSince ?? defaultDiffSince)(ctx.repo, baseSha);
  const { model, effort } = ROLE_MODELS.code_reviewer;
  const req: AgentRequest = {
    role: 'code_reviewer',
    model,
    effort,
    systemPrompt: await loadPrompt('code-review.md'),
    prompt: renderPrompt(spec, plan, diff),
    outputSchema: OUTPUT_JSON_SCHEMA,
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 30,
    budgetUsd: remainingUsd(ctx.state),
  };
  const res = await run(ctx, req);
  const out = OutputSchema.parse(res.output);
  const seen = new Set<string>();
  const findings: ReviewFinding[] = [];
  for (const f of out.findings) {
    const id = findingId(f.file, f.summary);
    if (seen.has(id)) continue;
    seen.add(id);
    findings.push({ id, ...f });
  }
  return { findings, state: res.state };
}
