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
import { runScanners as defaultRunScanners, type ScannerFinding } from './scanners.js';

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
  /** For a kept scanner finding: the `ref` the host gave it in the prompt. */
  ref: z.string().optional(),
});
const OutputSchema = z.object({ findings: z.array(RawFindingSchema) });
const OUTPUT_JSON_SCHEMA = z.toJSONSchema(OutputSchema) as Record<string, unknown>;

export type SecurityReviewDeps = {
  runAgent?: typeof defaultRunAgent;
  runScanners?: typeof defaultRunScanners;
  diffSince?: typeof defaultDiffSince;
};

/** Host-computed handle for a scanner finding: SCN-<sha8(tool \n ruleId \n file)>. */
export function scannerRef(f: Pick<ScannerFinding, 'tool' | 'ruleId' | 'file'>): string {
  return `SCN-${sha8(`${f.tool}\n${f.ruleId}\n${f.file}`)}`;
}

/**
 * Review-sourced findings: SEC-<sha8(source \n tool \n file \n title)>, stable across line shifts
 * as long as the reviewer reuses the title (the prompt lists last round's titles for that).
 * Scanner findings use scannerFindingId instead, which never depends on model text.
 */
export function securityFindingId(f: { source: string; tool?: string; file: string; title: string }): string {
  return `SEC-${sha8(`${f.source}\n${f.tool ?? ''}\n${f.file}\n${f.title}`)}`;
}

/** Scanner findings: SEC-<sha8(ref)>, so the id is stable however the model words the title. */
export function scannerFindingId(ref: string): string {
  return `SEC-${sha8(ref)}`;
}

/** A finding from an earlier round, passed back so the reviewer can reuse its exact title. */
export type PriorFinding = { id: string; title: string; file: string };
export type SecurityReviewContext = { previous?: PriorFinding[]; accepted?: string[] };

export function blocking(findings: SecurityFinding[], accepted: Set<string>): SecurityFinding[] {
  return findings.filter((f) => (f.severity === 'critical' || f.severity === 'high') && !accepted.has(f.id));
}

/** Scanner findings shown to the reviewer; the rest are summarised in a note. */
export const MAX_SCANNER_FINDINGS = 50;
/** Scanner messages are capped (a gitleaks message can quote the secret; huge ones bloat the prompt). */
export const MAX_SCANNER_MESSAGE_CHARS = 300;
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/** Most severe first, top MAX_SCANNER_FINDINGS, messages capped; plus a note naming what was left out. */
function scannerForPrompt(all: Array<ScannerFinding & { ref: string }>): { shown: Array<ScannerFinding & { ref: string }>; note?: string } {
  const sorted = [...all].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const shown = sorted.slice(0, MAX_SCANNER_FINDINGS).map((f) => ({
    ...f,
    message: f.message.length > MAX_SCANNER_MESSAGE_CHARS ? `${f.message.slice(0, MAX_SCANNER_MESSAGE_CHARS - 1)}…` : f.message,
  }));
  const rest = sorted.slice(MAX_SCANNER_FINDINGS);
  if (!rest.length) return { shown };
  const tools = [...new Set(rest.map((f) => f.tool))].join(', ');
  return { shown, note: `${rest.length} more scanner findings not shown; run ${tools} in /workspace to see them.` };
}

function priorSection(prior: SecurityReviewContext): string[] {
  const previous = prior.previous ?? [];
  const accepted = prior.accepted ?? [];
  if (!previous.length && !accepted.length) return [];
  const lines = ['## Earlier security findings', ''];
  if (previous.length) {
    lines.push(
      'These were reported in the previous review. If you report the same problem again, reuse its exact title (and file) so it keeps its id; do not reword it.',
      '',
      ...previous.map((f) => `- ${f.id} | ${f.file} | ${f.title}`),
      '',
    );
  }
  lines.push(accepted.length ? `Accepted risks: ${accepted.join(', ')}.` : 'Accepted risks: none.', '');
  return lines;
}

function renderPrompt(
  spec: SpecDoc,
  plan: Plan,
  scanner: Array<ScannerFinding & { ref: string }>,
  unavailable: string[],
  diff: string,
  prior: SecurityReviewContext,
): string {
  const tasks = plan.tasks.map((t) => `- ${t.id} [${t.area}] ${t.title}`).join('\n');
  const { shown, note } = scannerForPrompt(scanner);
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
    'Each finding has a `ref`. For every scanner finding you keep, copy its `ref` exactly into your output.',
    '',
    JSON.stringify(shown, null, 2),
    '',
    ...(note ? [note, ''] : []),
    ...priorSection(prior),
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
  prior: SecurityReviewContext = {},
): Promise<{ findings: SecurityFinding[]; unavailable: string[]; state: JobState }> {
  const run = deps.runAgent ?? defaultRunAgent;
  const { findings: scanned, unavailable } = await (deps.runScanners ?? defaultRunScanners)(ctx.container);
  const diff = await (deps.diffSince ?? defaultDiffSince)(ctx.repo, baseSha);
  const withRefs = scanned.map((f) => ({ ref: scannerRef(f), ...f }));
  const byRef = new Map(withRefs.map((f) => [f.ref, f]));
  const { model, effort } = ROLE_MODELS.security_reviewer;
  const req: AgentRequest = {
    role: 'security_reviewer',
    model,
    effort,
    systemPrompt: await loadPrompt('security-review.md'),
    prompt: renderPrompt(spec, plan, withRefs, unavailable, diff, prior),
    outputSchema: OUTPUT_JSON_SCHEMA,
    tools: ['Read', 'Grep', 'Glob'],
    maxTurns: 60,
    budgetUsd: remainingUsd(ctx.state),
  };
  const res = await run(ctx, req);
  const out = OutputSchema.parse(res.output);
  // Deduped by id, keeping the most severe finding on a collision (first-seen order is kept).
  const byId = new Map<string, SecurityFinding>();
  for (const { ref, ...f } of out.findings) {
    // Ids never come from the model: a scanner finding's id derives from the host's ref (and its
    // tool/file from the scanner record); a missing or unknown ref makes it a review finding.
    const hit = f.source === 'scanner' && ref !== undefined ? byRef.get(ref) : undefined;
    let finding: SecurityFinding;
    if (hit) {
      finding = { id: scannerFindingId(hit.ref), ...f, source: 'scanner', tool: hit.tool, file: hit.file };
      if (finding.line === undefined && hit.line !== undefined) finding.line = hit.line;
    } else {
      const { tool: _tool, ...rest } = f;
      const review = { ...rest, source: 'review' as const };
      finding = { id: securityFindingId(review), ...review };
    }
    const prev = byId.get(finding.id);
    if (!prev || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[prev.severity]) byId.set(finding.id, finding);
  }
  const findings = [...byId.values()];
  return { findings, unavailable, state: res.state };
}
