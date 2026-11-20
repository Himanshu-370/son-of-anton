import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { StageCtx } from '../agent/host-runner.js';
import { writeFileAtomic } from '../core/atomic.js';
import { headSha as defaultHeadSha, revParse as defaultRevParse } from '../core/git.js';
import { pause, saveState, transition, type JobState } from '../core/state.js';
import type { CheckResult, Kit } from '../kits/types.js';
import { runCodeReview as defaultRunCodeReview, type ReviewFinding } from '../review/code-review.js';
import { blocking, runSecurityReview as defaultRunSecurityReview, type SecurityFinding } from '../security/review.js';
import { loadAcceptedRisks } from '../security/risks.js';
import type { Plan } from './plan.js';
import { attributeFailures, failuresPath, renderFailureReport, type FailureItem } from './qa.js';
import type { SpecDoc } from './spec.js';

export type VerifyResult = {
  state: JobState;
  passed: boolean;
  results: CheckResult[];
  runOk: boolean;
  /** The markdown report written to failureReportPath ('' on pass). */
  failureReport: string;
  failures?: FailureItem[];
};

export type VerifyDeps = {
  runCodeReview?: typeof defaultRunCodeReview;
  runSecurityReview?: typeof defaultRunSecurityReview;
  headSha?: typeof defaultHeadSha;
  revParse?: typeof defaultRevParse;
};

/** Persisted failure report, so a crashed fix round can resume (R11). */
export function failureReportPath(jobDir: string): string {
  return join(jobDir, 'evidence', 'failure-report.md');
}

/** Sorted, de-duplicated `kind:id` entries joined with `|` (one check failing in two areas counts once). */
export function failureSignature(items: FailureItem[]): string {
  return [...new Set(items.map((i) => `${i.kind}:${i.id}`))].sort().join('|');
}

/** The kit's run-failure section when it has one, else a generic pointer. */
function runFailureText(kitReport: string): string {
  const m = /### Run failed[\s\S]*?(?=\n### |$)/.exec(kitReport);
  return m ? m[0].trim() : 'The smoke run (plan `commands.run`) failed. See the check details in the failure report.';
}

function reviewItem(f: ReviewFinding): FailureItem {
  const at = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  return { area: f.area, kind: 'review', id: f.id, text: `Code review (blocking) at ${at}: ${f.summary}` };
}

function securityItem(f: SecurityFinding): FailureItem {
  const at = f.line !== undefined ? `${f.file}:${f.line}` : f.file;
  const src = f.tool ? `${f.source}/${f.tool}` : f.source;
  return {
    area: f.area,
    kind: 'security',
    id: f.id,
    text: `Security (${f.severity}, ${src}) at ${at}: ${f.title}\n${f.detail}`,
  };
}

async function reviewBase(ctx: StageCtx, state: JobState, revParse: typeof defaultRevParse): Promise<string> {
  if (state.reviewedSha) return state.reviewedSha;
  const ref = `anton/${state.jobId}/spec-approved`;
  try {
    return await revParse(ctx.repo, ref);
  } catch (e) {
    throw new Error(`cannot find the review base: no reviewedSha and tag ${ref} does not resolve (${(e as Error).message})`);
  }
}

/**
 * Code-only stage: run the kit; if checks or the smoke run fail, attribute them to areas (QA) and skip
 * the reviewers; otherwise run the code reviewer then the security reviewer over the diff since the last
 * reviewed sha. Record evidence, then decide deliver / build / pause (ruling R1).
 */
export async function runVerify(
  ctx: StageCtx,
  kit: Kit,
  spec: SpecDoc,
  plan: Plan,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const { results, runOk, failureReport: kitReport } = await kit.verify({
    container: ctx.container,
    jobDir: ctx.jobDir,
    checks: spec.acceptanceChecks,
    commands: plan.commands,
  });
  const s = ctx.state;
  let state = s;
  const record: Record<string, unknown> = { round: s.round, results, runOk };

  let failures = attributeFailures(results, runOk, plan, runFailureText(kitReport));
  const checksFailed = failures.length > 0;
  if (!checksFailed) {
    const baseSha = await reviewBase(ctx, state, deps.revParse ?? defaultRevParse);
    const code = await (deps.runCodeReview ?? defaultRunCodeReview)({ ...ctx, state }, spec, plan, baseSha);
    state = code.state;
    const security = await (deps.runSecurityReview ?? defaultRunSecurityReview)({ ...ctx, state }, spec, plan, baseSha);
    state = security.state;
    record.review = { findings: code.findings };
    record.security = { findings: security.findings, unavailable: security.unavailable };
    const accepted = new Set((await loadAcceptedRisks(ctx.jobDir)).map((r) => r.id));
    failures = [
      ...code.findings.filter((f) => f.severity === 'blocking').map(reviewItem),
      ...blocking(security.findings, accepted).map(securityItem),
    ];
  }

  const resultsText = JSON.stringify(record, null, 2) + '\n';
  await writeFileAtomic(join(ctx.jobDir, 'evidence', 'results.json'), resultsText);
  // Per-round copy: lets the report tell which security findings were fixed in a later round.
  await writeFileAtomic(join(ctx.jobDir, 'evidence', `results-round-${s.round}.json`), resultsText);

  const passed = failures.length === 0;
  let report = '';
  if (passed) {
    await rm(failuresPath(ctx.jobDir), { force: true });
    await rm(failureReportPath(ctx.jobDir), { force: true });
    const head = await (deps.headSha ?? defaultHeadSha)(ctx.repo);
    state = transition(state, 'deliver', { reviewedSha: head });
  } else {
    report = renderFailureReport(failures, checksFailed ? kitReport : '');
    await writeFileAtomic(failuresPath(ctx.jobDir), JSON.stringify(failures, null, 2) + '\n');
    await writeFileAtomic(failureReportPath(ctx.jobDir), report);
    const signature = failureSignature(failures);
    if (s.round >= s.maxRounds) state = pause(state, 'round_cap');
    else if (signature === s.lastFailureSignature) state = pause(state, 'no_progress');
    else state = transition(state, 'build', { round: s.round + 1, lastFailureSignature: signature, completedFixAreas: [] });
  }
  await saveState(ctx.jobDir, state);
  return { state, passed, results, runOk, failureReport: report, failures };
}
