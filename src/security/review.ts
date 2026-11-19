import { z } from 'zod';
import { runAgent as defaultRunAgent, type StageCtx } from '../agent/host-runner.js';
import type { AgentRequest } from '../agent/protocol.js';
import { remainingUsd } from '../core/budget.js';
import { ROLE_MODELS, type Area } from '../core/config.js';
import { diffSince as defaultDiffSince } from '../core/git.js';
import type { JobState } from '../core/state.js';
import { fenceDiff, sha8 } from '../review/shared.js';
import { loadPrompt } from '../stages/prompts.js';
import type { Plan } from '../stages/plan.js';
import type { SpecDoc } from '../stages/spec.js';
import { runScanners as defaultRunScanners } from './scanners.js';

export type SecurityFinding = {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  area: Area;
  file: string;
  line?: number;
  title: string;
  detail: string;
  source: 'scanner' | 'review';
  tool?: string;
};

const RawFindingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  area: z.enum(['frontend', 'backend', 'infra']),
  file: z.string().min(1),
  line: z.number().int().optional(),
  title: z.string().min(1),
  detail: z.string().min(1),
  source: z.enum(['scanner', 'review']),
  tool: z.string().min(1).optional(),
});
const OutputSchema = z.object({ findings: z.array(RawFindingSchema) });
const OUTPUT_JSON_SCHEMA = z.toJSONSchema(OutputSchema) as Record<string, unknown>;

export type SecurityReviewDeps = {
  runAgent?: typeof defaultRunAgent;
  runScanners?: typeof defaultRunScanners;
  diffSince?: typeof defaultDiffSince;
};

/** Stable across line shifts: SEC-<8 hex of sha256(source \n tool \n file \n title)>. */
export function securityFindingId(f: { source: string; tool?: string; file: string; title: string }): string {
  return `SEC-${sha8(`${f.source}\n${f.tool ?? ''}\n${f.file}\n${f.title}`)}`;
}

export function blocking(findings: SecurityFinding[], accepted: Set<string>): SecurityFinding[] {
  return findings.filter((f) => (f.severity === 'critical' || f.severity === 'high') && !accepted.has(f.id));
}

function renderPrompt(spec: SpecDoc, plan: Plan, scanner: unknown[], unavailable: string[], diff: string): string {
  const tasks = plan.tasks.map((t) => `- ${t.id} [${t.area}] ${t.title}`).join('\n');
  return [
    `# Spec: ${spec.title}`,
    '',
    spec.summary,
    '',
    '## Tasks',
    '',
    tasks,
    '',
    '## Scanner findings',
    '',
    unavailable.length ? `Scanners that did not run: ${unavailable.join(', ')}.` : 'All scanners ran.',
    '',
    JSON.stringify(scanner, null, 2),
    '',
    '## Diff of this round',
    '',
    'The full code is readable in `/workspace`; the diff below may be trimmed.',
    '',
    fenceDiff(diff),
  ].join('\n');
}

/** Runs scanners, then a read-only security-review agent over scanner output plus the round diff. */
export async function runSecurityReview(
  ctx: StageCtx,
  spec: SpecDoc,
  plan: Plan,
  baseSha: string,
  deps: SecurityReviewDeps = {},
): Promise<{ findings: SecurityFinding[]; unavailable: string[]; state: JobState }> {
  const run = deps.runAgent ?? defaultRunAgent;
  const { findings: scanned, unavailable } = await (deps.runScanners ?? defaultRunScanners)(ctx.container);
  const diff = await (deps.diffSince ?? defaultDiffSince)(ctx.repo, baseSha);
  const { model, effort } = ROLE_MODELS.security_reviewer;
  const req: AgentRequest = {
    role: 'security_reviewer',
    model,
    effort,
    systemPrompt: await loadPrompt('security-review.md'),
    prompt: renderPrompt(spec, plan, scanned, unavailable, diff),
    outputSchema: OUTPUT_JSON_SCHEMA,
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 30,
    budgetUsd: remainingUsd(ctx.state),
  };
  const res = await run(ctx, req);
  const out = OutputSchema.parse(res.output);
  const seen = new Set<string>();
  const findings: SecurityFinding[] = [];
  for (const f of out.findings) {
    const id = securityFindingId(f);
    if (seen.has(id)) continue;
    seen.add(id);
    findings.push({ id, ...f });
  }
  return { findings, unavailable, state: res.state };
}
