import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceeded, type StageCtx } from '../../src/agent/host-runner.js';
import { isRunning } from '../../src/core/lock.js';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { registerProject } from '../../src/core/registry.js';
import { loadState, pause, saveState, transition, type JobState } from '../../src/core/state.js';
import type { CheckResult, Kit } from '../../src/kits/types.js';
import { runUnattended, startOrReuseContainer, type RunnerDeps } from '../../src/pipeline/runner.js';
import type { ExecFn } from '../../src/core/exec.js';
import type { Plan } from '../../src/stages/plan.js';
import type { SpecDoc } from '../../src/stages/spec.js';
import type { VerifyResult } from '../../src/stages/verify.js';

const spec: SpecDoc = {
  title: 'Sum CLI', summary: 's', outOfScope: [], kit: 'fallback', tech: [],
  acceptanceChecks: [{ id: 'AC-1', text: 'sums' }],
};
const plan: Plan = {
  commands: { install: 'i', test: 't' },
  tasks: [{ id: 'T1', title: 'x', acceptanceChecks: ['AC-1'], instructions: 'y', area: 'backend' }],
};
const kit: Kit = { name: 'fake', dockerfile: '', detect: () => 1, baseline: async () => ({ passingTests: [], ran: true }), verify: async () => ({ results: [], runOk: true, failureReport: '' }) };

let repo: string;
let dir: string;

async function setup(over: Partial<JobState> = {}): Promise<void> {
  process.env.ANTON_HOME = await mkdtemp(join(tmpdir(), 'anton-runner-'));
  repo = join(process.env.ANTON_HOME, 'projects', 'p');
  dir = jobDirOf(repo, '1-init');
  await mkdir(dir, { recursive: true });
  await registerProject('p', repo);
  await writeFile(join(dir, 'spec.approved.json'), JSON.stringify(spec));
  await saveState(dir, {
    jobId: '1-init', project: 'p', stage: 'plan', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
    warned80: false, completedTasks: [], updatedAt: '', ...over,
  });
}

function fakes(overrides: Partial<RunnerDeps> = {}) {
  const calls: string[] = [];
  const stopped: string[] = [];
  const notify = vi.fn(async () => undefined);
  let verifyCalls = 0;
  const pass: CheckResult = { id: 'AC-1', status: 'pass', tests: ['AC-1: ok'] };
  const fail: CheckResult = { id: 'AC-1', status: 'fail', reason: 'failing', tests: [] };
  const deliverInputs: unknown[] = [];
  const deps: RunnerDeps = {
    startContainer: async (slug) => `anton-${slug}`,
    stopContainer: async (name) => { stopped.push(name); },
    notify,
    kit,
    log: () => undefined,
    runPlan: async (ctx: StageCtx) => { calls.push('plan'); return { plan, state: ctx.state }; },
    runBuild: async (ctx: StageCtx) => {
      calls.push('build');
      const s = transition(ctx.state, 'verify');
      await saveState(ctx.jobDir, s);
      return s;
    },
    runVerify: async (ctx: StageCtx): Promise<VerifyResult> => {
      calls.push('verify');
      verifyCalls++;
      const ok = verifyCalls > 1;
      const s = ok ? transition(ctx.state, 'deliver') : transition(ctx.state, 'build', { round: ctx.state.round + 1 });
      await saveState(ctx.jobDir, s);
      return { state: s, passed: ok, results: [ok ? pass : fail], runOk: true, failureReport: ok ? '' : 'rep' };
    },
    runDeliver: async (ctx: StageCtx, _spec, _plan, input) => {
      calls.push('deliver');
      deliverInputs.push(input);
      const s = transition(ctx.state, 'awaiting_final_review');
      await saveState(ctx.jobDir, s);
      return s;
    },
    ...overrides,
  };
  return { deps, calls, stopped, notify, deliverInputs, pass };
}

describe('runUnattended', () => {
  beforeEach(async () => { await setup(); });

  it('plan → build → verify(fail) → build → verify(pass) → deliver → awaiting_final_review', async () => {
    const f = fakes();
    await runUnattended('p', f.deps);
    expect(f.calls).toEqual(['plan', 'build', 'verify', 'build', 'verify', 'deliver']);
    expect(await loadState(dir)).toMatchObject({ stage: 'awaiting_final_review', round: 2 });
    expect(f.deliverInputs).toEqual([{ results: [f.pass], runOk: true }]);
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.stopped).toEqual(['anton-p']);
    expect(await isRunning(repo)).toEqual({ running: false });
  });

  it('runner routes change jobs plan→baseline→build; new jobs plan→build', async () => {
    const withBaseline = (calls: string[]) => ({
      runBaseline: async (ctx: StageCtx) => {
        calls.push('baseline');
        const s = transition(ctx.state, 'build', { round: 1 });
        await saveState(ctx.jobDir, s);
        return s;
      },
    });
    await setup({ kind: 'change' });
    const c = fakes();
    await runUnattended('p', { ...c.deps, ...withBaseline(c.calls) });
    expect(c.calls.slice(0, 3)).toEqual(['plan', 'baseline', 'build']);
    await setup();
    const n = fakes();
    await runUnattended('p', { ...n.deps, ...withBaseline(n.calls) });
    expect(n.calls.slice(0, 2)).toEqual(['plan', 'build']);
  });

  it('change job on the wrong branch: nothing runs; on the job branch it runs; new jobs skip the check', async () => {
    await setup({ kind: 'change', branch: 'anton/1-init', fromBranch: 'main' });
    const f = fakes();
    await runUnattended('p', { ...f.deps, currentBranch: async () => 'main' });
    expect(f.calls).toEqual([]);
    expect(f.stopped).toEqual([]);
    expect((await loadState(dir)).stage).toBe('paused');
    expect(await isRunning(repo)).toEqual({ running: false });
    await setup({ kind: 'change', branch: 'anton/1-init', fromBranch: 'main' });
    const g = fakes();
    await runUnattended('p', { ...g.deps, currentBranch: async () => 'anton/1-init', runBaseline: async (c: StageCtx) => transition(c.state, 'build', { round: 1 }) });
    expect(g.calls[0]).toBe('plan');
    await setup();
    const h = fakes();
    await runUnattended('p', { ...h.deps, currentBranch: async () => { throw new Error('should not be asked'); } });
    expect(h.calls[0]).toBe('plan');
  });

  it('runner on wrong branch pauses with error and notifies', async () => {
    await setup({ kind: 'change', branch: 'anton/1-init', fromBranch: 'main' });
    const f = fakes();
    await runUnattended('p', { ...f.deps, currentBranch: async () => 'main' });
    expect(await loadState(dir)).toMatchObject({ stage: 'paused', pausedFrom: 'plan', pauseReason: 'error' });
    expect(await readFile(join(dir, 'logs', 'error.log'), 'utf8')).toContain('git switch anton/1-init');
    expect(f.notify).toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it('crash during baseline resumes at baseline without re-running plan', async () => {
    await setup({ kind: 'change' });
    let boom = true;
    const calls: string[] = [];
    const f = fakes({
      runBaseline: async (ctx: StageCtx) => {
        calls.push('baseline');
        if (boom) { boom = false; throw new Error('crash'); }
        const s = transition(ctx.state, 'build', { round: 1 });
        await saveState(ctx.jobDir, s);
        return s;
      },
    });
    await runUnattended('p', f.deps);
    const paused = await loadState(dir);
    expect(paused).toMatchObject({ stage: 'paused', pausedFrom: 'baseline' });
    await writeFile(join(dir, 'plan.json'), JSON.stringify(plan)); // the real runPlan persists it
    await saveState(dir, transition(paused, 'baseline'));
    await runUnattended('p', f.deps);
    expect(f.calls.filter((c) => c === 'plan')).toEqual(['plan']);
    expect(calls).toEqual(['baseline', 'baseline']);
    expect((await loadState(dir)).stage).toBe('awaiting_final_review');
  });

  it('notifies only after the container is stopped and the lock released (review and pause)', async () => {
    for (const over of [{}, { runBuild: async () => { throw new BudgetExceeded(); } }] as Partial<RunnerDeps>[]) {
      await setup();
      const order: string[] = [];
      const f = fakes({
        ...over,
        acquireLock: async () => async () => { order.push('release'); },
        stopContainer: async () => { order.push('stop'); },
        notify: async () => { order.push('notify'); },
      });
      await runUnattended('p', f.deps);
      expect(order).toEqual(['stop', 'release', 'notify']);
    }
  });

  it('verify deps are forwarded', async () => {
    const verifyDeps = { headSha: async () => 'abc' };
    const seen: unknown[] = [];
    const f = fakes({
      verifyDeps,
      runVerify: async (ctx: StageCtx, _k, _s, _p, d): Promise<VerifyResult> => {
        seen.push(d);
        const s = transition(ctx.state, 'deliver');
        await saveState(ctx.jobDir, s);
        return { state: s, passed: true, results: [f.pass], runOk: true, failureReport: '' };
      },
    });
    await runUnattended('p', f.deps);
    expect(seen).toEqual([verifyDeps]);
  });

  describe('pause message', () => {
    const pausing = (reason: 'round_cap' | 'no_progress') => ({
      runVerify: async (ctx: StageCtx): Promise<VerifyResult> => {
        const s = pause(ctx.state, reason);
        await saveState(ctx.jobDir, s);
        return { state: s, passed: false, results: [], runOk: true, failureReport: 'x' };
      },
    });
    const put = async (body: string) => {
      await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
      await mkdir(join(dir, 'evidence'), { recursive: true });
      await writeFile(join(dir, 'evidence', 'failures.json'), body);
    };
    const msg = async (reason: 'round_cap' | 'no_progress') => {
      const f = fakes(pausing(reason));
      await runUnattended('p', f.deps);
      return String(f.notify.mock.calls[0]![1]);
    };

    it('round_cap pause with security failures mentions accept-risk', async () => {
      await setup({ stage: 'verify', round: 3 });
      await put(JSON.stringify([{ area: 'backend', kind: 'security', id: 'SEC-1', text: 't' }]));
      expect(await msg('round_cap')).toContain('anton accept-risk');
      await setup({ stage: 'verify', round: 3 });
      await put(JSON.stringify([{ area: 'backend', kind: 'security', id: 'SEC-1', text: 't' }]));
      expect(await msg('no_progress')).toContain('anton accept-risk');
    });

    it('security pause guidance: accept-risk then plain resume re-verifies; --accept-as-is delivers now', async () => {
      await setup({ stage: 'verify', round: 3 });
      await put(JSON.stringify([{ area: 'backend', kind: 'security', id: 'SEC-1', text: 't' }]));
      const m = await msg('no_progress');
      expect(m).toContain('then: anton resume p (re-verifies; the reviewers run again)');
      expect(m).toContain('anton resume p --accept-as-is delivers now and ships any other blockers too');
      expect(m).not.toContain('Other blockers remain');
    });

    it('security pause with other blockers says accepting risks alone will not pass', async () => {
      await setup({ stage: 'verify', round: 3 });
      await put(JSON.stringify([
        { area: 'backend', kind: 'security', id: 'SEC-1', text: 't' },
        { area: 'frontend', kind: 'review', id: 'CR-1', text: 't' },
      ]));
      expect(await msg('round_cap')).toContain('Other blockers remain, so accepting risks alone will not pass verify.');
    });

    it('does not mention accept-risk without security failures, or when failures.json is missing or corrupt', async () => {
      await setup({ stage: 'verify', round: 3 });
      await put(JSON.stringify([{ area: 'backend', kind: 'check', id: 'AC-1', text: 't' }]));
      expect(await msg('round_cap')).not.toContain('accept-risk');
      await setup({ stage: 'verify', round: 3 });
      expect(await msg('round_cap')).not.toContain('accept-risk');
      await setup({ stage: 'verify', round: 3 });
      await put('{not json');
      expect(await msg('no_progress')).not.toContain('accept-risk');
    });
  });

  it('plan → build sets round 1', async () => {
    let roundAtBuild = -1;
    const f = fakes({
      runBuild: async (ctx: StageCtx) => {
        roundAtBuild = ctx.state.round;
        throw new BudgetExceeded();
      },
    });
    await runUnattended('p', f.deps);
    expect(roundAtBuild).toBe(1);
  });

  it('a throwing stage pauses with error, logs it, releases the lock and stops the container', async () => {
    const f = fakes({ runBuild: async () => { throw new Error('kaboom'); } });
    await runUnattended('p', f.deps);
    expect(await loadState(dir)).toMatchObject({ stage: 'paused', pausedFrom: 'build', pauseReason: 'error' });
    expect(await readFile(join(dir, 'logs', 'error.log'), 'utf8')).toContain('kaboom');
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.stopped).toEqual(['anton-p']);
    expect(await isRunning(repo)).toEqual({ running: false });
  });

  it('BudgetExceeded from build → paused/budget_cap', async () => {
    const f = fakes({ runBuild: async () => { throw new BudgetExceeded(); } });
    await runUnattended('p', f.deps);
    expect(await loadState(dir)).toMatchObject({ stage: 'paused', pausedFrom: 'build', pauseReason: 'budget_cap' });
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0]).toEqual(['Son of Anton', expect.stringContaining('budget')]);
  });

  it('container start failure pauses with error and still releases the lock', async () => {
    const f = fakes({ startContainer: async () => { throw new Error('docker run failed: nope'); } });
    await runUnattended('p', f.deps);
    expect(await loadState(dir)).toMatchObject({ stage: 'paused', pauseReason: 'error' });
    expect(f.calls).toEqual([]);
    expect(await isRunning(repo)).toEqual({ running: false });
  });

  it('deliver after accept-as-is passes no verify result (runDeliver reads results.json)', async () => {
    await setup({ stage: 'deliver', round: 3, completedTasks: ['T1'] });
    await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
    const f = fakes();
    await runUnattended('p', f.deps);
    expect(f.calls).toEqual(['deliver']);
    expect(f.deliverInputs).toEqual([undefined]);
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it('a failing notify on success is not treated as a run error', async () => {
    const f = fakes({ notify: async () => { throw new Error('osascript broke'); } });
    await runUnattended('p', f.deps);
    expect(await loadState(dir)).toMatchObject({ stage: 'awaiting_final_review' });
    await expect(readFile(join(dir, 'logs', 'error.log'), 'utf8')).rejects.toThrow();
    expect(await isRunning(repo)).toEqual({ running: false });
  });

  it('does nothing at a waiting stage', async () => {
    await setup({ stage: 'awaiting_spec_approval' });
    const f = fakes();
    await runUnattended('p', f.deps);
    expect(f.calls).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
  });
});

describe('runner log redaction', () => {
  it('an error message containing a secret is logged redacted', async () => {
    await setup();
    await mkdir(join(process.env.ANTON_HOME!, 'secrets'), { recursive: true });
    await writeFile(join(process.env.ANTON_HOME!, 'secrets', 'p.env'), 'TOKEN=FAKE_SECRET_VALUE_123\n', { mode: 0o600 });
    const lines: string[] = [];
    const f = fakes();
    await runUnattended('p', {
      ...f.deps,
      log: (l) => lines.push(l),
      runPlan: async () => { throw new Error('boom FAKE_SECRET_VALUE_123'); },
    });
    const all = lines.join('\n');
    expect(all).toContain('boom [REDACTED:TOKEN]');
    expect(all).not.toContain('FAKE_SECRET_VALUE_123');
    expect(await readFile(join(dir, 'logs', 'error.log'), 'utf8')).not.toContain('FAKE_SECRET_VALUE_123');
  });
});

describe('startOrReuseContainer', () => {
  beforeEach(async () => { await setup(); });

  function fakeExec(image: string, mounts = '2') {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'inspect' && args[2] === '{{.State.Running}}') return { exitCode: 0, stdout: 'true\n', stderr: '' };
      if (args[0] === 'inspect' && args[2] === '{{.Config.Image}}') return { exitCode: 0, stdout: `${image}\n`, stderr: '' };
      if (args[0] === 'inspect' && args[2] === '{{index .Config.Labels "anton.mounts"}}') return { exitCode: 0, stdout: `${mounts}\n`, stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    return { exec, calls };
  }
  const ensure = async (k: Kit) => `anton/kit-${k.name}:1`;

  it('running container on another image is replaced', async () => {
    const f = fakeExec('anton/kit-fallback:1');
    expect(await startOrReuseContainer('p', repo, { ...kit, name: 'web' }, f.exec, ensure)).toBe('anton-p');
    expect(f.calls).toContainEqual(['rm', '-f', 'anton-p']);
    expect(f.calls.find((a) => a[0] === 'run')).toContain('anton/kit-web:1');
  });

  it('running container on the kit image is reused', async () => {
    const f = fakeExec('anton/kit-web:1');
    expect(await startOrReuseContainer('p', repo, { ...kit, name: 'web' }, f.exec, ensure)).toBe('anton-p');
    expect(f.calls.some((a) => a[0] === 'run' || a[0] === 'rm')).toBe(false);
  });

  it('container without the plugins mount label is replaced', async () => {
    for (const mounts of ['<no value>', '1', '']) {
      const f = fakeExec('anton/kit-web:1', mounts);
      expect(await startOrReuseContainer('p', repo, { ...kit, name: 'web' }, f.exec, ensure)).toBe('anton-p');
      expect(f.calls).toContainEqual(['rm', '-f', 'anton-p']);
      expect(f.calls.find((a) => a[0] === 'run')).toContain('anton.mounts=2');
    }
  });

  it('stage contexts carry the approved spec\'s kit', async () => {
    await writeFile(join(dir, 'spec.approved.json'), JSON.stringify({ ...spec, kit: 'web' }));
    const kits: unknown[] = [];
    const f = fakes({ runPlan: async (ctx: StageCtx) => { kits.push(ctx.kit); return { plan, state: ctx.state }; } });
    await runUnattended('p', f.deps);
    expect(kits).toEqual(['web']);
  });

  it('runner starts the container with the approved spec\'s kit', async () => {
    await writeFile(join(dir, 'spec.approved.json'), JSON.stringify({ ...spec, kit: 'web' }));
    const seen: string[] = [];
    const f = fakes({ kit: undefined, startContainer: async (s, _r, k) => { seen.push(k.name); return `anton-${s}`; } });
    await runUnattended('p', f.deps);
    expect(seen).toEqual(['web']);
  });
});

describe('run record', () => {
  beforeEach(async () => { await setup(); });

  const entry = (name: string, version: string, c: string) => ({
    name, marketplace: 'acme/mkt', url: 'https://github.com/acme/mkt.git', version,
    commit: c.repeat(40), sha256: c.repeat(64), dir: `acme-mkt/${name}/${c.repeat(12)}`,
  });

  it('run-record lists the plugin versions', async () => {
    const home = process.env.ANTON_HOME!;
    await writeFile(join(home, 'config.yaml'), 'stages:\n  build: [cave]\nkits:\n  web: [webby]\nroles:\n  code_reviewer: [revy]\n');
    await writeFile(join(home, 'plugins.lock'), JSON.stringify([entry('cave', '1.0.0', 'a'), entry('webby', '2.0.0', 'b'), entry('unused', '3.0.0', 'c')]));
    await writeFile(join(dir, 'run-record.json'), JSON.stringify({ other: 1 }));
    await runUnattended('p', fakes().deps);
    // fallback kit: the web kit's plugin and a read-only role's plugin are not loadable for this job.
    expect(JSON.parse(await readFile(join(dir, 'run-record.json'), 'utf8'))).toEqual({
      other: 1,
      plugins: [{ name: 'cave', version: '1.0.0', commit: 'a'.repeat(40), sha256: 'a'.repeat(64) }],
    });
  });

  it('a symlinked run-record.json is refused: the job pauses and the target is untouched', async () => {
    const host = join(await mkdtemp(join(tmpdir(), 'anton-host-')), 'host.json');
    await writeFile(host, '{"hostKey":"host-only"}');
    await symlink(host, join(dir, 'run-record.json'));
    const started = vi.fn(async (s: string) => `anton-${s}`);
    await runUnattended('p', fakes({ startContainer: started }).deps);
    expect(started).not.toHaveBeenCalled();
    expect((await loadState(dir)).stage).toBe('paused');
    expect(await readFile(join(dir, 'logs', 'error.log'), 'utf8')).toContain('run-record.json');
    expect(await readFile(host, 'utf8')).toBe('{"hostKey":"host-only"}');
  });

  it('a listed plugin that is not installed pauses the job before any container starts', async () => {
    await writeFile(join(process.env.ANTON_HOME!, 'config.yaml'), 'stages:\n  plan: [ghost]\n');
    const started = vi.fn(async (s: string) => `anton-${s}`);
    await runUnattended('p', fakes({ startContainer: started }).deps);
    expect(started).not.toHaveBeenCalled();
    expect((await loadState(dir)).stage).toBe('paused');
    expect(await readFile(join(dir, 'logs', 'error.log'), 'utf8')).toContain('anton plugins add ghost@<marketplace>');
  });
});
