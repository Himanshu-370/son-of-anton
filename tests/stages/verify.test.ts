import { describe, it, expect, beforeEach } from 'vitest';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StageCtx } from '../../src/agent/host-runner.js';
import { loadState, type JobState } from '../../src/core/state.js';
import type { CheckResult, Kit, VerifyContext, VerifyOutcome } from '../../src/kits/types.js';
import type { Plan } from '../../src/stages/plan.js';
import type { SpecDoc } from '../../src/stages/spec.js';
import { failureSignature, runVerify, type VerifyDeps } from '../../src/stages/verify.js';
import { failuresPath, type FailureItem } from '../../src/stages/qa.js';
import type { ReviewFinding } from '../../src/review/code-review.js';
import type { SecurityFinding } from '../../src/security/review.js';
import { acceptRisk } from '../../src/security/risks.js';

const spec: SpecDoc = {
  title: 'Sum CLI', summary: 's', outOfScope: [], kit: 'fallback', tech: [],
  acceptanceChecks: [{ id: 'AC-1', text: 'a' }, { id: 'AC-2', text: 'b' }],
};
const plan: Plan = {
  commands: { install: 'i', test: 't' },
  tasks: [{ id: 'T1', title: 'x', acceptanceChecks: ['AC-1', 'AC-2'], instructions: 'y', area: 'backend' }],
};
const pass = (id: string): CheckResult => ({ id, status: 'pass', tests: [`${id}: ok`] });
const fail = (id: string, reason: CheckResult['reason'] = 'failing'): CheckResult => ({ id, status: 'fail', reason, tests: [] });

let ctx: StageCtx;
const st = (over: Partial<JobState> = {}): JobState => ({
  jobId: 'j1', project: 'p', stage: 'verify', round: 1, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
  warned80: false, completedTasks: ['T1'], updatedAt: 'x', ...over,
});
beforeEach(async () => {
  const jobDir = await mkdtemp(join(tmpdir(), 'anton-verify-'));
  ctx = { project: 'p', repo: '/r', container: 'c', jobDir, stage: 'verify', state: st() };
});
function kit(outcome: VerifyOutcome, seen: VerifyContext[] = []): Kit {
  return { name: 'fake', dockerfile: '', detect: () => 1, verify: async (c) => { seen.push(c); return outcome; } };
}

const item = (kind: FailureItem['kind'], id: string, area: FailureItem['area'] = 'backend'): FailureItem => ({ area, kind, id, text: 't' });

describe('failureSignature', () => {
  it('sorts kind:id entries and joins with |', () => {
    expect(failureSignature([item('check', 'AC-2:no_test'), item('check', 'AC-1:failing')])).toBe('check:AC-1:failing|check:AC-2:no_test');
  });
  it('includes run and review/security ids; duplicates across areas collapse', () => {
    expect(failureSignature([
      item('run', 'run:failed', 'infra'), item('check', 'AC-1:failing', 'backend'), item('check', 'AC-1:failing', 'frontend'),
      item('security', 'SEC-1'), item('review', 'CR-1'),
    ])).toBe('check:AC-1:failing|review:CR-1|run:run:failed|security:SEC-1');
  });
});

type Calls = { name: string; baseSha: string }[];
function fakeDeps(
  opts: { review?: ReviewFinding[]; security?: SecurityFinding[]; unavailable?: string[]; head?: string } = {},
  calls: Calls = [],
): VerifyDeps {
  return {
    runCodeReview: async (c, _spec, _plan, baseSha) => {
      calls.push({ name: 'code', baseSha });
      return { findings: opts.review ?? [], state: { ...c.state, spentUsd: c.state.spentUsd + 1 } };
    },
    runSecurityReview: async (c, _spec, _plan, baseSha) => {
      calls.push({ name: 'security', baseSha });
      return { findings: opts.security ?? [], unavailable: opts.unavailable ?? [], state: { ...c.state, spentUsd: c.state.spentUsd + 2 } };
    },
    headSha: async () => opts.head ?? 'f'.repeat(40),
    revParse: async (_repo, ref) => {
      if (ref !== 'anton/j1/spec-approved') throw new Error(`unexpected ref ${ref}`);
      return 'a'.repeat(40);
    },
  };
}
const cr = (id: string, severity: ReviewFinding['severity'] = 'blocking', area: ReviewFinding['area'] = 'frontend'): ReviewFinding => ({
  id, severity, area, file: 'src/x.ts', line: 3, summary: `summary ${id}`,
});
const sec = (id: string, severity: SecurityFinding['severity']): SecurityFinding => ({
  id, severity, area: 'backend', file: 'src/db.ts', title: `title ${id}`, detail: 'd', source: 'review',
});
const allPass = (): Kit => kit({ results: [pass('AC-1'), pass('AC-2')], runOk: true, failureReport: '' });
const readJson = async (f: string) => JSON.parse(await readFile(f, 'utf8'));

describe('runVerify', () => {
  it('verify: all pass + runOk → passed, transitions to deliver', async () => {
    const seen: VerifyContext[] = [];
    const r = await runVerify(ctx, kit({ results: [pass('AC-1'), pass('AC-2')], runOk: true, failureReport: '' }, seen), spec, plan, fakeDeps());
    expect(r.passed).toBe(true);
    expect(r.state.stage).toBe('deliver');
    expect((await loadState(ctx.jobDir)).stage).toBe('deliver');
    expect(seen[0]).toEqual({ container: 'c', jobDir: ctx.jobDir, checks: spec.acceptanceChecks, commands: plan.commands });
    const saved = await readJson(join(ctx.jobDir, 'evidence', 'results.json'));
    expect(saved).toEqual({
      round: 1, results: [pass('AC-1'), pass('AC-2')], runOk: true,
      review: { findings: [] }, security: { findings: [], unavailable: [] },
    });
  });

  it('verify: all pass but runOk false → not passed, back to build', async () => {
    const r = await runVerify(ctx, kit({ results: [pass('AC-1'), pass('AC-2')], runOk: false, failureReport: 'run failed' }), spec, plan, fakeDeps());
    expect(r.passed).toBe(false);
    expect(r.state).toMatchObject({ stage: 'build', round: 2, lastFailureSignature: 'run:run:failed' });
  });

  it('verify: first failure → build with round+1 and signature saved', async () => {
    const r = await runVerify(ctx, kit({ results: [fail('AC-1'), pass('AC-2')], runOk: true, failureReport: 'rep' }), spec, plan, fakeDeps());
    expect(r.passed).toBe(false);
    expect(r.failureReport).toContain('rep');
    expect(r.state).toMatchObject({ stage: 'build', round: 2, lastFailureSignature: 'check:AC-1:failing' });
    expect(await loadState(ctx.jobDir)).toMatchObject({ stage: 'build', round: 2, lastFailureSignature: 'check:AC-1:failing' });
  });

  it('verify failure into a new build round resets stale completedFixAreas', async () => {
    ctx.state = st({ round: 2, completedFixAreas: ['backend', 'frontend'], lastFailureSignature: 'other' });
    const r = await runVerify(ctx, kit({ results: [fail('AC-1'), pass('AC-2')], runOk: true, failureReport: 'rep' }), spec, plan, fakeDeps());
    expect(r.state).toMatchObject({ stage: 'build', round: 3, completedFixAreas: [] });
    expect(await loadState(ctx.jobDir)).toMatchObject({ completedFixAreas: [] });
  });

  it('verify failure writes failures.json and a grouped failure-report.md; a later pass removes both', async () => {
    const file = join(ctx.jobDir, 'evidence', 'failure-report.md');
    await runVerify(ctx, kit({ results: [fail('AC-1'), pass('AC-2')], runOk: true, failureReport: 'the report' }), spec, plan, fakeDeps());
    const md = await readFile(file, 'utf8');
    expect(md).toContain('### backend');
    expect(md).toContain('AC-1');
    expect(md).toContain('the report');
    const items = (await readJson(failuresPath(ctx.jobDir))) as FailureItem[];
    expect(items).toEqual([expect.objectContaining({ area: 'backend', kind: 'check', id: 'AC-1:failing' })]);
    ctx.state = st({ round: 2 });
    await runVerify(ctx, allPass(), spec, plan, fakeDeps());
    await expect(access(file)).rejects.toThrow();
    await expect(access(failuresPath(ctx.jobDir))).rejects.toThrow();
  });

  it('verify pass with no failure-report.md present does not throw', async () => {
    await mkdir(join(ctx.jobDir, 'evidence'), { recursive: true });
    await writeFile(join(ctx.jobDir, 'evidence', 'other.txt'), 'x');
    const r = await runVerify(ctx, allPass(), spec, plan, fakeDeps());
    expect(r.passed).toBe(true);
  });

  it('verify: second identical failure signature → paused/no_progress', async () => {
    ctx.state = st({ round: 2, lastFailureSignature: 'check:AC-1:failing' });
    const r = await runVerify(ctx, kit({ results: [fail('AC-1'), pass('AC-2')], runOk: true, failureReport: 'rep' }), spec, plan, fakeDeps());
    expect(r.passed).toBe(false);
    expect(r.state).toMatchObject({ stage: 'paused', pauseReason: 'no_progress', pausedFrom: 'verify' });
    expect((await loadState(ctx.jobDir)).pauseReason).toBe('no_progress');
  });

  it('verify: failure in round 3 of 3 → paused/round_cap', async () => {
    ctx.state = st({ round: 3, lastFailureSignature: 'check:AC-1:failing' });
    const r = await runVerify(ctx, kit({ results: [fail('AC-1'), pass('AC-2')], runOk: true, failureReport: 'rep' }), spec, plan, fakeDeps());
    expect(r.state).toMatchObject({ stage: 'paused', pauseReason: 'round_cap' });
    expect((await loadState(ctx.jobDir)).pauseReason).toBe('round_cap');
    const saved = await readJson(join(ctx.jobDir, 'evidence', 'results.json'));
    expect(saved.round).toBe(3);
  });

  it('checks failing → reviewers not called', async () => {
    const calls: Calls = [];
    await runVerify(ctx, kit({ results: [fail('AC-1'), pass('AC-2')], runOk: true, failureReport: 'rep' }), spec, plan, fakeDeps({}, calls));
    await runVerify({ ...ctx, state: st({ round: 1 }) }, kit({ results: [pass('AC-1'), pass('AC-2')], runOk: false, failureReport: 'rf' }), spec, plan, fakeDeps({}, calls));
    expect(calls).toEqual([]);
    const saved = await readJson(join(ctx.jobDir, 'evidence', 'results.json'));
    expect(saved.review).toBeUndefined();
    expect(saved.security).toBeUndefined();
  });

  it('all pass → code then security reviewer called with baseSha = spec-approved sha on first round and reviewedSha afterwards', async () => {
    const calls: Calls = [];
    const r = await runVerify(ctx, allPass(), spec, plan, fakeDeps({}, calls));
    expect(calls).toEqual([{ name: 'code', baseSha: 'a'.repeat(40) }, { name: 'security', baseSha: 'a'.repeat(40) }]);
    // reviewers' state is carried forward (cost recorded)
    expect(r.state.spentUsd).toBe(3);
    expect((await loadState(ctx.jobDir)).spentUsd).toBe(3);

    const calls2: Calls = [];
    ctx.state = st({ round: 2, reviewedSha: 'b'.repeat(40) });
    await runVerify(ctx, allPass(), spec, plan, fakeDeps({}, calls2));
    expect(calls2).toEqual([{ name: 'code', baseSha: 'b'.repeat(40) }, { name: 'security', baseSha: 'b'.repeat(40) }]);
  });

  it('missing spec-approved tag and no reviewedSha → clear error', async () => {
    const deps = { ...fakeDeps(), revParse: async () => { throw new Error('bad ref'); } };
    await expect(runVerify(ctx, allPass(), spec, plan, deps)).rejects.toThrow(/spec-approved/);
  });

  it('blocking code finding → transitions to build with a review FailureItem', async () => {
    const r = await runVerify(ctx, allPass(), spec, plan, fakeDeps({ review: [cr('CR-aaaa')] }));
    expect(r.passed).toBe(false);
    expect(r.state).toMatchObject({ stage: 'build', round: 2, lastFailureSignature: 'review:CR-aaaa' });
    expect(r.state.spentUsd).toBe(3);
    const items = (await readJson(failuresPath(ctx.jobDir))) as FailureItem[];
    expect(items).toEqual([expect.objectContaining({ area: 'frontend', kind: 'review', id: 'CR-aaaa' })]);
    expect(items[0]!.text).toContain('summary CR-aaaa');
    const md = await readFile(join(ctx.jobDir, 'evidence', 'failure-report.md'), 'utf8');
    expect(md).toContain('### frontend');
    expect(md).toContain('summary CR-aaaa');
  });

  it('high security finding blocks; same id accepted → passes', async () => {
    const r = await runVerify(ctx, allPass(), spec, plan, fakeDeps({ security: [sec('SEC-1', 'high')] }));
    expect(r.passed).toBe(false);
    expect(r.state).toMatchObject({ stage: 'build', lastFailureSignature: 'security:SEC-1' });
    const items = (await readJson(failuresPath(ctx.jobDir))) as FailureItem[];
    expect(items).toEqual([expect.objectContaining({ area: 'backend', kind: 'security', id: 'SEC-1' })]);

    await acceptRisk(ctx.jobDir, 'SEC-1', 'fine');
    ctx.state = st({ round: 2 });
    const r2 = await runVerify(ctx, allPass(), spec, plan, fakeDeps({ security: [sec('SEC-1', 'high')] }));
    expect(r2.passed).toBe(true);
    expect(r2.state.stage).toBe('deliver');
  });

  it('medium/low and non_blocking findings never block', async () => {
    const r = await runVerify(ctx, allPass(), spec, plan, fakeDeps({
      review: [cr('CR-1', 'non_blocking')], security: [sec('SEC-m', 'medium'), sec('SEC-l', 'low')],
    }));
    expect(r.passed).toBe(true);
    expect(r.state.stage).toBe('deliver');
  });

  it('same blocking finding two rounds running → paused no_progress', async () => {
    const r1 = await runVerify(ctx, allPass(), spec, plan, fakeDeps({ review: [cr('CR-x')] }));
    expect(r1.state.stage).toBe('build');
    ctx.state = { ...r1.state, stage: 'verify' };
    const r2 = await runVerify(ctx, allPass(), spec, plan, fakeDeps({ review: [cr('CR-x')] }));
    expect(r2.state).toMatchObject({ stage: 'paused', pauseReason: 'no_progress' });
  });

  it('pass sets reviewedSha to HEAD and removes failures.json', async () => {
    await mkdir(join(ctx.jobDir, 'evidence'), { recursive: true });
    await writeFile(failuresPath(ctx.jobDir), '[]');
    const r = await runVerify(ctx, allPass(), spec, plan, fakeDeps({ head: 'c'.repeat(40) }));
    expect(r.state.reviewedSha).toBe('c'.repeat(40));
    expect((await loadState(ctx.jobDir)).reviewedSha).toBe('c'.repeat(40));
    await expect(access(failuresPath(ctx.jobDir))).rejects.toThrow();
  });

  it('a failing round does not move reviewedSha', async () => {
    ctx.state = st({ reviewedSha: 'b'.repeat(40) });
    const r = await runVerify(ctx, allPass(), spec, plan, fakeDeps({ review: [cr('CR-1')], head: 'c'.repeat(40) }));
    expect(r.state.reviewedSha).toBe('b'.repeat(40));
  });

  it('results.json carries review/security sections incl. unavailable scanners', async () => {
    const review = [cr('CR-1', 'non_blocking')];
    const security = [sec('SEC-l', 'low')];
    await runVerify(ctx, allPass(), spec, plan, fakeDeps({ review, security, unavailable: ['semgrep'] }));
    const saved = await readJson(join(ctx.jobDir, 'evidence', 'results.json'));
    expect(saved.review).toEqual({ findings: review });
    expect(saved.security).toEqual({ findings: security, unavailable: ['semgrep'] });
  });
});
