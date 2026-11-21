import { describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, type ChildLike, type StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { resumeCommand } from '../../src/cli/commands/resume.js';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { registerProject } from '../../src/core/registry.js';
import { loadState, saveState, transition, type JobState } from '../../src/core/state.js';
import { runUnattended, type RunnerDeps } from '../../src/pipeline/runner.js';
import { runDeliver } from '../../src/stages/deliver.js';
import type { CheckResult, Kit } from '../../src/kits/types.js';
import type { Plan } from '../../src/stages/plan.js';
import type { SpecDoc } from '../../src/stages/spec.js';

const spec: SpecDoc = {
  title: 'Sum CLI', summary: 's', outOfScope: [], kit: 'fallback', tech: [],
  acceptanceChecks: [{ id: 'AC-1', text: 'sums' }],
};
const plan: Plan = {
  commands: { install: 'i', test: 't' },
  tasks: [{ id: 'T1', title: 'x', acceptanceChecks: ['AC-1'], instructions: 'y', area: 'backend' }],
};
const kit: Kit = { name: 'fake', dockerfile: '', detect: () => 1, baseline: async () => ({ passingTests: [], ran: true }), verify: async () => ({ results: [], runOk: true, failureReport: '' }) };
const req: AgentRequest = { role: 'builder', model: 'm', effort: 'low', systemPrompt: 's', prompt: 'p', maxTurns: 5, budgetUsd: 5 };

/** A fake container session that reports a fixed cumulative cost, so recordCost and the allowances really run. */
const session = (totalUsd: number): ChildLike => ({
  stdout: (async function* () {
    yield JSON.stringify({ type: 'cost', totalUsd }) + '\n';
    yield JSON.stringify({ type: 'result', ok: true, output: {}, sessionId: 's', totalUsd, protocolVersion: 4 }) + '\n';
  })(),
  kill: vi.fn(),
  then: (ok: (v: { exitCode: number }) => unknown) => Promise.resolve({ exitCode: 0 }).then(ok),
}) as unknown as ChildLike;

describe('money flow', () => {
  it('a $10 job walks plan, build, verify, build, verify with correct shares, pause and resume', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anton-money-'));
    process.env.ANTON_HOME = home;
    const repo = join(home, 'projects', 'p');
    const dir = jobDirOf(repo, '1-init');
    await mkdir(dir, { recursive: true });
    await registerProject('p', repo);
    await writeFile(join(dir, 'spec.approved.json'), JSON.stringify(spec));
    await saveState(dir, {
      jobId: '1-init', project: 'p', stage: 'plan', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
      warned80: false, completedTasks: [], updatedAt: '',
    });

    // Defaults on $10: spec 10%, plan 10%, build 50%, verify 25%. Shares are cumulative, so build may spend up to $7 in all (it borrows spec's and plan's).
    const shares: Array<[string, Record<string, number> | undefined]> = [];
    const charge = async (ctx: StageCtx, usd: number): Promise<JobState> => {
      await runAgent(ctx, req, { spawn: () => session(usd), notify: vi.fn(), plugins: async () => ({ plugins: [], skills: [], mcpServers: {}, used: [] }) });
      const s = await loadState(ctx.jobDir);
      shares.push([ctx.stage, s.stageSpentUsd]);
      return s;
    };
    let builds = 0;
    let verifies = 0;
    const pass: CheckResult = { id: 'AC-1', status: 'pass', tests: ['AC-1: ok'] };
    const fail: CheckResult = { id: 'AC-1', status: 'fail', reason: 'failing', tests: [] };
    const notify = vi.fn(async () => undefined);
    const deps: RunnerDeps = {
      startContainer: async (slug) => `anton-${slug}`,
      stopContainer: async () => undefined,
      notify,
      kit,
      log: () => undefined,
      runPlan: async (ctx) => {
        await writeFile(join(ctx.jobDir, 'plan.json'), JSON.stringify(plan)); // the resumed run reads it back
        return { plan, state: await charge(ctx, 0.8) };
      },
      runBuild: async (ctx) => {
        // Round 1 costs $3. Round 2 first tries $3.50 (over build's $7 share), then $1 after the resume.
        const usd = ++builds === 1 ? 3 : builds === 2 ? 3.5 : 1;
        const s = transition(await charge(ctx, usd), 'verify');
        await saveState(ctx.jobDir, s);
        return s;
      },
      runVerify: async (ctx) => {
        const ok = ++verifies > 1;
        const charged = await charge(ctx, ok ? 1.2 : 1);
        const s = ok ? transition(charged, 'deliver') : transition(charged, 'build', { round: charged.round + 1 });
        await saveState(ctx.jobDir, s);
        return { state: s, passed: ok, results: [ok ? pass : fail], runOk: true, failureReport: ok ? '' : 'rep' };
      },
      runDeliver: (ctx, s, p, input) => runDeliver(ctx, s, p, input, { tag: async () => undefined, listTags: async () => [], home }),
    };

    await runUnattended('p', deps);

    // plan, build, verify, then build goes over its share and pauses.
    expect(shares.map(([stage]) => stage)).toEqual(['plan', 'build', 'verify']);
    expect(shares[0]![1]).toEqual({ plan: 0.8 });
    expect(shares[1]![1]).toMatchObject({ plan: 0.8, build: 3 });
    expect(shares[2]![1]).toMatchObject({ plan: 0.8, build: 3, verify: 1 });
    const paused = await loadState(dir);
    expect(paused).toMatchObject({ stage: 'paused', pausedFrom: 'build', pauseReason: 'allowance' });
    expect(paused.stageSpentUsd).toMatchObject({ plan: 0.8, build: 6.5, verify: 1 });
    expect(notify).toHaveBeenLastCalledWith(
      'Son of Anton',
      'p: paused, build share used: $7.30 of $7.00 (spec through build). Resume with: anton resume p --budget <usd>',
    );

    // Without a bigger budget resume refuses; with --budget 14 it continues (build's share becomes $9.80).
    const out: string[] = [];
    const err: string[] = [];
    const spawned: string[] = [];
    const cli = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), preflight: async () => undefined, spawnRun: (n: string) => { spawned.push(n); }, stopContainer: async () => undefined };
    expect(await resumeCommand('p', {}, cli)).toBe(1);
    expect(err.join('\n')).toContain('--budget');
    expect(await resumeCommand('p', { budget: '14' }, cli)).toBe(0);
    expect(spawned).toEqual(['p']);
    expect(await loadState(dir)).toMatchObject({ stage: 'build', budgetUsd: 14 });

    await runUnattended('p', deps);

    const done = await loadState(dir);
    expect(done.stage).toBe('awaiting_final_review');
    expect(done.spentUsd).toBeCloseTo(10.5);
    expect(done.stageSpentUsd!.plan).toBeCloseTo(0.8);
    expect(done.stageSpentUsd!.build).toBeCloseTo(7.5);
    expect(done.stageSpentUsd!.verify).toBeCloseTo(2.2);

    const line = JSON.parse((await readFile(join(home, 'history.jsonl'), 'utf8')).trim().split('\n').at(-1)!);
    expect(line.jobId).toBe('1-init');
    expect(line.spentUsd).toBeCloseTo(10.5);
    expect(line.stageUsd).toEqual(done.stageSpentUsd);
  });
});
