import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import type { StageCtx } from '../agent/host-runner.js';
import { writeFileAtomic } from '../core/atomic.js';
import { listTags as defaultListTags, tag as defaultTag } from '../core/git.js';
import type { ReviewFinding } from '../review/code-review.js';
import { loadAcceptedRisks } from '../security/risks.js';
import type { SecurityFinding } from '../security/review.js';
import { saveState, transition, type JobState } from '../core/state.js';
import type { CheckResult } from '../kits/types.js';
import type { Plan } from './plan.js';
import type { SpecDoc } from './spec.js';

export type DeliverDeps = {
  tag?: (repo: string, name: string) => Promise<void>;
  listTags?: (repo: string, pattern: string) => Promise<string[]>;
};

/** The outcome to report. When absent (e.g. after accept-as-is), the latest evidence/results.json is used. */
export type DeliverInput = { results: CheckResult[]; runOk: boolean } | undefined;

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

const cell = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
const usd = (n: number) => `$${n.toFixed(2)}`;

function checksSection(spec: SpecDoc, results: CheckResult[]): string[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const rows = spec.acceptanceChecks.map((c) => {
    const r = byId.get(c.id);
    const status = !r ? 'not verified' : r.status === 'pass' ? 'pass' : `fail (${r.reason ?? 'failing'})`;
    const tests = r?.tests.length ? r.tests.map(cell).join('<br>') : '—';
    return `| ${c.id} | ${cell(c.text)} | ${status} | ${tests} | evidence/test-output.txt |`;
  });
  return [
    '## Acceptance checks',
    '',
    'Evidence paths are relative to this job folder; `evidence/results.json` holds the raw results.',
    '',
    '| ID | Check | Status | Tests | Evidence |',
    '|---|---|---|---|---|',
    ...rows,
  ];
}

type ReviewSections = {
  review?: { findings?: ReviewFinding[] };
  security?: { findings?: SecurityFinding[]; unavailable?: string[] };
};

async function readSections(path: string): Promise<ReviewSections> {
  const raw = await readOptional(path);
  return raw ? (JSON.parse(raw) as ReviewSections) : {};
}

function codeReviewSection(sections: ReviewSections): string[] {
  const findings = sections.review?.findings ?? [];
  const lines = ['## Code review', ''];
  if (findings.length === 0) return [...lines, 'No findings.'];
  lines.push('| ID | Severity | Area | File | Summary |', '|---|---|---|---|---|');
  for (const f of findings) {
    const file = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`| ${f.id} | ${f.severity} | ${f.area} | ${cell(file)} | ${cell(f.summary)} |`);
  }
  return lines;
}

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

async function securitySection(jobDir: string, sections: ReviewSections): Promise<string[]> {
  const lines = ['## Security', ''];
  const sec = sections.security;
  if (!sec) return [...lines, 'Security review did not run for this delivery.'];
  const findings = sec.findings ?? [];
  const accepted = new Map((await loadAcceptedRisks(jobDir)).map((r) => [r.id, r.reason]));
  const line = (f: SecurityFinding): string => {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    const base = `- ${f.id} (${f.area}, ${where}): ${cell(f.title)}`;
    const reason = accepted.get(f.id);
    return reason === undefined ? base : `${base} — accepted — ${cell(reason)}`;
  };
  if (findings.length === 0) lines.push('No findings.');
  for (const sev of SEVERITIES) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length) lines.push(`### ${sev}`, '', ...group.map(line), '');
  }

  // Fixed: reported in an earlier round's results, gone from the latest.
  const current = new Set(findings.map((f) => f.id));
  const fixed = new Map<string, SecurityFinding>();
  let names: string[] = [];
  try {
    names = (await fsp.readdir(join(jobDir, 'evidence'))).filter((n) => /^results-round-\d+\.json$/.test(n));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  names.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  for (const n of names) {
    for (const f of (await readSections(join(jobDir, 'evidence', n))).security?.findings ?? []) {
      if (!current.has(f.id)) fixed.set(f.id, f);
    }
  }
  if (fixed.size) {
    lines.push('### Fixed in earlier rounds', '', ...[...fixed.values()].map((f) => `- ${f.id} (${f.severity}): ${cell(f.title)} — fixed`), '');
  }
  const unavailable = sec.unavailable ?? [];
  if (unavailable.length) lines.push(`Scanners unavailable: ${unavailable.join(', ')}.`, '');
  while (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function runSection(plan: Plan): string[] {
  const lines = ['## How to run', '', '```sh', '# install', plan.commands.install, '', '# test', plan.commands.test];
  if (plan.commands.run) lines.push('', '# run', plan.commands.run);
  lines.push('```');
  return lines;
}

function costSection(costs: Record<string, number> | undefined): string[] {
  const lines = ['## Cost and time by stage', ''];
  const entries = Object.entries(costs ?? {});
  if (entries.length === 0) {
    lines.push('No cost recorded.');
  } else {
    const total = entries.reduce((a, [, v]) => a + v, 0);
    lines.push('| Stage | Cost |', '|---|---|', ...entries.map(([k, v]) => `| ${k} | ${usd(v)} |`), `| **Total** | **${usd(total)}** |`);
  }
  lines.push('', 'Time by stage: not recorded.');
  return lines;
}

function notDoneSection(spec: SpecDoc, results: CheckResult[], runOk: boolean): string[] {
  const text = new Map(spec.acceptanceChecks.map((c) => [c.id, c.text]));
  const items = results
    .filter((r) => r.status === 'fail')
    .map((r) => `- ${r.id}: ${(text.get(r.id) ?? '').replace(/\s+/g, ' ').trim()} (${r.reason ?? 'failing'})`);
  if (!runOk) items.push('- The smoke run command failed (see evidence/test-output.txt and the verify failure report).');
  return ['## Not done', '', ...(items.length ? items : ['Nothing: every acceptance check passed.'])];
}

/** Code-only stage: write REPORT.md, tag the delivery (`delivered-<n>`), and wait for final review. */
export async function runDeliver(
  ctx: StageCtx,
  spec: SpecDoc,
  plan: Plan,
  verifyResult: DeliverInput,
  deps: DeliverDeps = {},
): Promise<JobState> {
  const tagFn = deps.tag ?? defaultTag;
  let outcome = verifyResult;
  if (!outcome) {
    const raw = await readOptional(join(ctx.jobDir, 'evidence', 'results.json'));
    outcome = raw ? (JSON.parse(raw) as { results: CheckResult[]; runOk: boolean }) : { results: [], runOk: false };
  }
  const costRaw = await readOptional(join(ctx.jobDir, 'cost.json'));
  const costs = costRaw ? (JSON.parse(costRaw) as Record<string, number>) : undefined;
  const sections = await readSections(join(ctx.jobDir, 'evidence', 'results.json'));
  const questions = (await readOptional(join(ctx.jobDir, 'questions.md')))?.trim();

  const md = [
    `# ${spec.title}`,
    '',
    spec.summary,
    '',
    `Job \`${ctx.state.jobId}\`, delivered after ${ctx.state.round} round(s).`,
    '',
    ...checksSection(spec, outcome.results),
    '',
    ...codeReviewSection(sections),
    '',
    ...(await securitySection(ctx.jobDir, sections)),
    '',
    ...runSection(plan),
    '',
    ...costSection(costs),
    '',
    '## Assumptions',
    '',
    questions || 'No assumptions recorded.',
    '',
    ...notDoneSection(spec, outcome.results, outcome.runOk),
    '',
  ].join('\n');
  await writeFileAtomic(join(ctx.jobDir, 'REPORT.md'), md);

  // R10: one numbered tag per delivery, so re-delivery after a reject never collides.
  const prefix = `anton/${ctx.state.jobId}/delivered-`;
  const existing = await (deps.listTags ?? defaultListTags)(ctx.repo, `${prefix}*`);
  await tagFn(ctx.repo, `${prefix}${existing.length + 1}`);
  const state = transition(ctx.state, 'awaiting_final_review');
  await saveState(ctx.jobDir, state);
  return state;
}
