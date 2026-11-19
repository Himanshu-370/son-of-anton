import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StageCtx } from '../../src/agent/host-runner.js';
import { loadState, type JobState } from '../../src/core/state.js';
import type { CheckResult, Kit, VerifyContext, VerifyOutcome } from '../../src/kits/types.js';
import type { Plan } from '../../src/stages/plan.js';
import type { SpecDoc } from '../../src/stages/spec.js';
import { failureSignature, runVerify } from '../../src/stages/verify.js';

const spec: SpecDoc = {
  title: 'Sum CLI', summary: 's', outOfScope: [], kit: 'fallback', tech: [],
  acceptanceChecks: [{ id: 'AC-1', text: 'a' }, { id: 'AC-2', text: 'b' }],
};
const plan: Plan = {
  commands: { install: 'i', test: 't' },
  tasks: [{ id: 'T1', title: 'x', acceptanceChecks: ['AC-1', 'AC-2'], instructions: 'y' }],
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

describe('failureSignature', () => {
  it('sorts failing id:reason pairs and joins with |', () => {
    expect(failureSignature([fail('AC-2', 'no_test'), pass('AC-3'), fail('AC-1')])).toBe('AC-1:failing|AC-2:no_test');
  });
});

describe('runVerify', () => {
  it('verify: all pass + runOk → passed, transitions to deliver', async () => {
    const seen: VerifyContext[] = [];
    const r = await runVerify(ctx, kit({ results: [pass('AC-1'), pass('AC-2')], runOk: true, failureReport: '' }, seen), spec, plan);
    expect(r.passed).toBe(true);
    expect(r.state.stage).toBe('deliver');
    expect((await loadState(ctx.jobDir)).stage).toBe('deliver');
    expect(seen[0]).toEqual({ container: 'c', jobDir: ctx.jobDir, checks: spec.acceptanceChecks, commands: plan.commands });
    const saved = JSON.parse(await readFile(join(ctx.jobDir, 'evidence', 'results.json'), 'utf8'));
    expect(saved).toEqual({ round: 1, results: [pass('AC-1'), pass('AC-2')], runOk: true });
  });

  it('verify: all pass but runOk false → not passed, back to build', async () => {
    const r = await runVerify(ctx, kit({ results: [pass('AC-1'), pass('AC-2')], runOk: false, failureReport: 'run failed' }), spec, plan);
    expect(r.passed).toBe(false);
    expect(r.state).toMatchObject({ stage: 'build', round: 2 });
  });

  it('verify: first failure → build with round+1 and signature saved', async () => {
    const r = await runVerify(ctx, kit({ results: [fail('AC-1'), pass('AC-2')], runOk: true, failureReport: 'rep' }), spec, plan);
    expect(r.passed).toBe(false);
    expect(r.failureReport).toBe('rep');
    expect(r.state).toMatchObject({ stage: 'build', round: 2, lastFailureSignature: 'AC-1:failing' });
    expect(await loadState(ctx.jobDir)).toMatchObject({ stage: 'build', round: 2, lastFailureSignature: 'AC-1:failing' });
  });

  it('verify: second identical failure signature → paused/no_progress', async () => {
    ctx.state = st({ round: 2, lastFailureSignature: 'AC-1:failing' });
    const r = await runVerify(ctx, kit({ results: [fail('AC-1'), pass('AC-2')], runOk: true, failureReport: 'rep' }), spec, plan);
    expect(r.passed).toBe(false);
    expect(r.state).toMatchObject({ stage: 'paused', pauseReason: 'no_progress', pausedFrom: 'verify' });
    expect((await loadState(ctx.jobDir)).pauseReason).toBe('no_progress');
  });

  it('verify: failure in round 3 of 3 → paused/round_cap', async () => {
    ctx.state = st({ round: 3, lastFailureSignature: 'AC-1:failing' });
    const r = await runVerify(ctx, kit({ results: [fail('AC-1'), pass('AC-2')], runOk: true, failureReport: 'rep' }), spec, plan);
    expect(r.state).toMatchObject({ stage: 'paused', pauseReason: 'round_cap' });
    expect((await loadState(ctx.jobDir)).pauseReason).toBe('round_cap');
    const saved = JSON.parse(await readFile(join(ctx.jobDir, 'evidence', 'results.json'), 'utf8'));
    expect(saved.round).toBe(3);
  });
});
