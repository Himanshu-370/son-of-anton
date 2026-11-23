import { publishJobMilestone } from '../slack/job-milestones.js';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import type { StageCtx } from '../agent/host-runner.js';
import type { TokenTotals } from '../agent/protocol.js';
import { NotRegularFileError, readRegularFile, writeFileAtomic } from '../core/atomic.js';
import { cacheHitRate, parseCosts, parseUsage, totalUsage } from '../core/budget.js';
import { appendHistory } from '../core/history.js';
import { redact } from '../core/secrets.js';
import { listTags as defaultListTags, tag as defaultTag } from '../core/git.js';
import type { ReviewFinding } from '../review/code-review.js';
import { loadAcceptedRisks } from '../security/risks.js';
import type { SecurityFinding } from '../security/review.js';
import { saveState, transition, type JobState } from '../core/state.js';
import type { CheckResult } from '../kits/types.js';
import { failuresPath, FailureItemSchema } from './qa.js';
import { assertEvidenceDir, assertJobDir, listVerifyCopies } from './verify.js';
import type { Plan } from './plan.js';
import type { SpecDoc } from './spec.js';

export type DeliverDeps = {
  tag?: (repo: string, name: string) => Promise<void>;
  listTags?: (repo: string, pattern: string) => Promise<string[]>;
  /** Where history.jsonl lives (default: the anton home). */
  home?: string;
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
  const web = spec.kit === 'web';
  const byId = new Map(results.map((r) => [r.id, r]));
  const rows = spec.acceptanceChecks.map((c) => {
    const r = byId.get(c.id);
    const status = !r ? 'not verified' : r.status === 'pass' ? 'pass' : `fail (${r.reason ?? 'failing'})`;
    const tests = r?.tests.length ? r.tests.map(cell).join('<br>') : '—';
    const browserCell = web ? ` ${r?.browser?.status ?? '-'} |` : '';
    return `| ${c.id} | ${cell(c.text)} | ${status} |${browserCell} ${r?.evidence ?? '—'} | ${tests} | evidence/test-output.txt |`;
  });
  return [
    '## Acceptance checks',
    '',
    'Evidence paths are relative to this job folder; `evidence/results.json` holds the raw results.',
    '',
    web ? '| ID | Check | Status | Browser | Proven against | Tests | Evidence |' : '| ID | Check | Status | Proven against | Tests | Evidence |',
    web ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|',
    ...rows,
  ];
}

/** Web jobs only: paths (relative to the job folder) of the screenshots the browser agent saved. */
function screenshotsSection(spec: SpecDoc, results: CheckResult[]): string[] {
  const shots = spec.kit === 'web' ? results.filter((r) => r.browser?.screenshot) : [];
  if (shots.length === 0) return [];
  return ['', '## Screenshots', '', 'Not redacted: check them before sharing.', '', ...shots.map((r) => `- ${r.id}: evidence/screens/${r.id}.png`)];
}

// shortcut: whole-name word-boundary match on test labels; a builder that omits the exact service name shows "stand-in only", upgrade by recording service per test.
export function serviceIsReal(name: string, realLabels: string[]): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i');
  return realLabels.some((t) => re.test(t));
}

/** A service is real when a passing `[real]` test names it (whole name, case-insensitive); the build prompt asks for that. */
function servicesSection(spec: SpecDoc, results: CheckResult[]): string[] {
  const services = spec.services ?? [];
  if (services.length === 0) return [];
  const real = results.filter((r) => r.evidence === 'real').flatMap((r) => r.tests).filter((t) => t.includes('[real]'));
  return ['', '## Outside services', '', ...services.map((s) => `- ${cell(s.name)}: ${serviceIsReal(s.name, real) ? 'real' : 'stand-in only'}`)];
}

type ReviewSections = {
  reviewedFiles?: string[];
  review?: { findings?: ReviewFinding[] };
  security?: { findings?: SecurityFinding[]; unavailable?: string[] };
};

async function readSections(path: string): Promise<ReviewSections> {
  const raw = await readOptional(path);
  return raw ? (JSON.parse(raw) as ReviewSections) : {};
}

function codeReviewSection(sections: ReviewSections): string[] {
  const lines = ['## Code review', ''];
  if (!sections.review) return [...lines, 'Code review did not run for this delivery.'];
  const findings = sections.review.findings ?? [];
  if (findings.length === 0) return [...lines, 'No findings.'];
  lines.push('| ID | Severity | Area | File | Summary |', '|---|---|---|---|---|');
  for (const f of findings) {
    const file = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`| ${f.id} | ${f.severity} | ${f.area} | ${cell(file)} | ${cell(f.summary)} |`);
  }
  return lines;
}

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

async function securitySection(jobDir: string, sections: ReviewSections, evidenceOk: boolean): Promise<string[]> {
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
  const isOld = (f: SecurityFinding) => f.preexisting === true; // missing on old records counts as new
  for (const sev of SEVERITIES) {
    const group = findings.filter((f) => f.severity === sev && !isOld(f));
    if (group.length) lines.push(`### ${sev}`, '', ...group.map(line), '');
  }
  const old = findings.filter(isOld);
  if (old.length) {
    lines.push('### Pre-existing', '', 'Already in the repo before this change.', '', ...old.map((f) => `${line(f)} [${f.severity}]`), '');
  }

  // No longer reported: in an earlier verify's findings, gone from the latest. Listed only when the
  // absence means something: scanners cover the whole repo every verify, and a review finding counts
  // only if its file was in a later verify's reviewed diff (else the reviewer just did not look again).
  const current = new Set(findings.map((f) => f.id));
  const gone = new Map<string, SecurityFinding>();
  const copies = await Promise.all(
    (evidenceOk ? await listVerifyCopies(jobDir) : []).map(async ({ name }) => readSections(join(jobDir, 'evidence', name))),
  );
  copies.forEach((rec, i) => {
    const laterFiles = new Set(copies.slice(i + 1).flatMap((c) => c.reviewedFiles ?? []));
    for (const f of rec.security?.findings ?? []) {
      if (current.has(f.id)) continue;
      if (f.source === 'scanner' || laterFiles.has(f.file)) gone.set(f.id, f);
    }
  });
  if (gone.size) {
    lines.push(
      '### No longer reported',
      '',
      ...[...gone.values()].map((f) => `- ${f.id} (${f.severity}, ${cell(f.file)}): ${cell(f.title)} — not reported in the latest review`),
      '',
    );
  }
  const unavailable = sec.unavailable ?? [];
  if (unavailable.length) lines.push(`Scanners unavailable: ${unavailable.join(', ')}.`, '');
  while (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Regressions still open at delivery (only an accept-as-is delivery can have any). */
async function regressionsSection(jobDir: string, evidenceOk: boolean): Promise<string[]> {
  // As of the last verify: failures.json is removed when a verify passes.
  const raw = evidenceOk ? await readOptional(failuresPath(jobDir)) : undefined;
  const items = raw ? FailureItemSchema.array().parse(JSON.parse(raw)).filter((i) => i.kind === 'regression') : [];
  return ['## Regressions', '', ...(items.length ? items.map((i) => `- ${i.id}: ${cell(i.text)}`) : ['None.'])];
}

function runSection(plan: Plan): string[] {
  const lines = ['## How to run', '', '```sh', '# install', plan.commands.install, '', '# test', plan.commands.test];
  if (plan.commands.run) lines.push('', '# run', plan.commands.run);
  lines.push('```');
  return lines;
}

function costSection(
  costs: Record<string, number>,
  refused: boolean,
  costsClean: boolean,
  usage: Record<string, TokenTotals>,
  usageRefused: boolean,
): string[] {
  const lines = ['## Cost and time by stage', ''];
  if (refused) return [...lines, 'cost.json was refused (not a regular file).', '', 'Time by stage: not recorded.'];
  const entries = Object.entries(costs);
  const hit = (t: TokenTotals | undefined) => {
    const r = t && cacheHitRate(t);
    return r === undefined ? '-' : `${Math.round(r * 100)}%`;
  };
  if (entries.length === 0) {
    lines.push('No cost recorded.');
  } else {
    const total = entries.reduce((a, [, v]) => a + v, 0);
    const totalHit = hit(totalUsage(usage));
    lines.push(
      '| Stage | Cost | Cache hit |',
      '|---|---|---|',
      ...entries.map(([k, v]) => `| ${k} | ${usd(v)} | ${hit(Object.hasOwn(usage, k) ? usage[k] : undefined)} |`),
      `| **Total** | **${usd(total)}** | ${totalHit === '-' ? '-' : `**${totalHit}**`} |`,
    );
  }
  if (!costsClean) lines.push('', 'cost.json was partly or wholly refused (not valid stage costs).');
  if (usageRefused) lines.push('', 'usage.json was refused (not a regular file).');
  lines.push('', 'Time by stage: not recorded.');
  return lines;
}

/** questions.md as an indented block, so its lines can never become REPORT headings; a refused file gets a note. */
function questionsSection(questions: string | undefined, refused: boolean): string[] {
  const head = ['## Questions and assumptions', ''];
  if (refused) return [...head, 'questions.md was refused because it is not a regular file.', ''];
  if (!questions) return [];
  return [...head, ...questions.split('\n').map((l) => `    ${l}`), ''];
}

function notDoneSection(spec: SpecDoc, results: CheckResult[], runOk: boolean): string[] {
  const text = new Map(spec.acceptanceChecks.map((c) => [c.id, c.text]));
  const items = results
    .filter((r) => r.status === 'fail')
    .map((r) => `- ${r.id}: ${(text.get(r.id) ?? '').replace(/\s+/g, ' ').trim()} (${r.reason ?? 'failing'})`);
  if (!runOk) items.push('- The smoke run command failed (see evidence/test-output.txt and the verify failure report).');
  return ['## Not done', '', ...(items.length ? items : ['Nothing: every acceptance check passed.'])];
}

/** Container-writable files: any problem (missing, symlink, bad JSON, wrong shape) means "unknown", never 0. */
async function readJobJson(path: string): Promise<unknown> {
  try {
    const raw = await readRegularFile(path);
    return raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Share of checks passing in verify round 1, from the container-writable evidence; undefined when unknown. */
export async function readFirstTryPass(jobDir: string): Promise<number | undefined> {
  const rec = await readJobJson(join(jobDir, 'evidence', 'results-verify-1.json'));
  const results = typeof rec === 'object' && rec !== null ? (rec as { results?: unknown }).results : undefined;
  if (!Array.isArray(results) || results.length === 0) return undefined;
  const statuses = results.map((r: { status?: unknown } | null) => r?.status);
  if (statuses.some((status) => status !== 'pass' && status !== 'fail')) return undefined;
  const passed = statuses.filter((status) => status === 'pass').length;
  return passed / results.length;
}

async function readLessonIds(jobDir: string): Promise<string[] | undefined> {
  const rec = await readJobJson(join(jobDir, 'run-record.json'));
  const l = typeof rec === 'object' && rec !== null ? (rec as { lessons?: unknown }).lessons : undefined;
  return Array.isArray(l) && l.every((x) => typeof x === 'string') ? (l as string[]) : undefined;
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
  await assertJobDir(ctx.repo, ctx.jobDir);
  const evidenceOk = await assertEvidenceDir(ctx.repo, ctx.jobDir, { create: false }).then(() => true, () => false);
  let outcome = verifyResult;
  if (!outcome) {
    const raw = evidenceOk ? await readOptional(join(ctx.jobDir, 'evidence', 'results.json')) : undefined;
    outcome = raw ? (JSON.parse(raw) as { results: CheckResult[]; runOk: boolean }) : { results: [], runOk: false };
  }
  // cost.json is container-writable: report-only, cleaned like usage.json, never fatal once verify passed.
  let costs = parseCosts(undefined);
  let costRefused = false;
  try {
    costs = parseCosts(await readRegularFile(join(ctx.jobDir, 'cost.json')));
  } catch (e) {
    if (!(e instanceof NotRegularFileError)) throw e;
    costRefused = true;
  }
  let usage: Record<string, TokenTotals> = {};
  let usageRefused = false;
  try {
    usage = parseUsage(await readRegularFile(join(ctx.jobDir, 'usage.json')));
  } catch (e) {
    if (!(e instanceof NotRegularFileError)) throw e;
    usageRefused = true;
  }
  const sections = evidenceOk ? await readSections(join(ctx.jobDir, 'evidence', 'results.json')) : {};
  let questions: string | undefined;
  let questionsRefused = false;
  try {
    questions = (await readRegularFile(join(ctx.jobDir, 'questions.md')))?.trim();
  } catch (e) {
    if (!(e instanceof NotRegularFileError)) throw e;
    questionsRefused = true;
  }

  const change = ctx.state.kind === 'change' && !!ctx.state.branch;
  const md = [
    `# ${spec.title}`,
    '',
    spec.summary,
    '',
    `Job \`${ctx.state.jobId}\`, delivered after ${ctx.state.round} round(s).`,
    ...(spec.kit === 'web' ? ['', 'Kit: web'] : []),
    ...(change ? ['', `Branch to merge: ${ctx.state.branch}`] : []),
    '',
    ...checksSection(spec, outcome.results),
    ...screenshotsSection(spec, outcome.results),
    ...servicesSection(spec, outcome.results),
    '',
    ...codeReviewSection(sections),
    '',
    ...questionsSection(questions, questionsRefused),
    ...(await securitySection(ctx.jobDir, sections, evidenceOk)),
    '',
    ...(change ? [...(await regressionsSection(ctx.jobDir, evidenceOk)), ''] : []),
    ...runSection(plan),
    '',
    ...costSection(costs.costs, costRefused, costs.clean, usage, usageRefused),
    '',
    ...notDoneSection(spec, outcome.results, outcome.runOk),
    '',
  ].join('\n');
  await writeFileAtomic(join(ctx.jobDir, 'REPORT.md'), redact(md, ctx.secrets));

  // R10: one numbered tag per delivery, so re-delivery after a reject never collides.
  const prefix = `anton/${ctx.state.jobId}/delivered-`;
  const existing = await (deps.listTags ?? defaultListTags)(ctx.repo, `${prefix}*`);
  const deliveryNumber = existing.length + 1;
  await tagFn(ctx.repo, `${prefix}${deliveryNumber}`);
  const hit = cacheHitRate(totalUsage(usage));
  const firstTryPass = evidenceOk ? await readFirstTryPass(ctx.jobDir) : undefined;
  const lessons = await readLessonIds(ctx.jobDir);
  try {
    await appendHistory(
    {
      jobId: ctx.state.jobId, project: ctx.state.project, kind: ctx.state.kind, kit: spec.kit,
      checks: spec.acceptanceChecks.length, spentUsd: ctx.state.spentUsd,
      // Host-owned, zod-checked state (keyed by stage group), not container-writable cost.json.
      stageUsd: ctx.state.stageSpentUsd ?? {},
      ...(hit === undefined ? {} : { cacheHitRate: hit }),
      ...(firstTryPass === undefined ? {} : { firstTryPass }),
      rounds: (evidenceOk ? (await listVerifyCopies(ctx.jobDir)).at(-1)?.n : undefined) ?? ctx.state.round,
      rejects: ctx.state.rejects ?? 0,
      ...(lessons === undefined ? {} : { lessons }),
      ...(ctx.state.bench === undefined ? {} : { bench: ctx.state.bench }),
      at: new Date().toISOString(),
    },
    deps.home,
    );
  } catch (e) {
    // Best effort: failing here would leave a delivered tag without the transition, and a retry would tag again.
    ctx.warn?.(`Could not record job history: ${e instanceof Error ? e.message : String(e)}`);
  }
  const state = transition(ctx.state, 'awaiting_final_review');
  await saveState(ctx.jobDir, state);
  await publishJobMilestone(state, { kind: 'delivery-ready', occurrence: `delivered-${deliveryNumber}` });
  return state;
}
