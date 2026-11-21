import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, type ChildLike, type StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { saveState, type JobState } from '../../src/core/state.js';
import { runBrowserAgent } from '../../src/kits/web/browser.js';
import { addLesson } from '../../src/lessons/store.js';
import { installPlugin } from '../../src/plugins/store.js';
import { updatePlugin } from '../../src/plugins/update.js';
import { runCodeReview } from '../../src/review/code-review.js';
import { runSecurityReview } from '../../src/security/review.js';
import { runBuild } from '../../src/stages/build.js';
import { runPlan, type Plan } from '../../src/stages/plan.js';
import { ensureRepoMap } from '../../src/stages/repo-map.js';
import { runSpec, type SpecDoc } from '../../src/stages/spec.js';
import { fakeClone, marketplace } from '../plugins/fixture.js';

/**
 * §7.1 caching: a stage's system prompt must not change between rounds or with the clock, so the
 * prompt prefix stays cached. Every request below is built by the stage's own code (a fake runAgent
 * captures it); nothing here re-implements prompt building.
 */
const JOB = 'job-7f3a9c';
const CLOCKS = [new Date('2026-03-01T08:00:00.000Z'), new Date('2026-07-15T23:59:59.000Z')];
const ROUNDS = [1, 3];

const spec: SpecDoc = {
  title: 'Shop', summary: 's', outOfScope: [], kit: 'fallback', tech: [], services: [],
  acceptanceChecks: [{ id: 'AC-1', text: 'a' }, { id: 'AC-2', text: 'b' }, { id: 'AC-3', text: 'c' }],
};
const plan: Plan = {
  commands: { install: 'npm i', test: 'npm test', serve: 'npm start', url: 'http://localhost:3000' },
  contract: 'GET /api/items',
  tasks: [
    { id: 'T1', title: 'ui', acceptanceChecks: ['AC-1'], instructions: 'do', area: 'frontend' },
    { id: 'T2', title: 'api', acceptanceChecks: ['AC-2'], instructions: 'do', area: 'backend' },
    { id: 'T3', title: 'docker', acceptanceChecks: ['AC-3'], instructions: 'do', area: 'infra' },
  ],
};

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'anton-stable-'));
  process.env.ANTON_HOME = join(base, 'home');
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

let n = 0;
/** A fresh job folder and context at `round`. */
async function makeCtx(stage: string, round: number, over: Partial<JobState> = {}): Promise<StageCtx> {
  const repo = join(base, `repo-${++n}`);
  const jobDir = join(repo, '.anton', 'jobs', JOB);
  await mkdir(jobDir, { recursive: true });
  const state: JobState = {
    jobId: JOB, project: 'p', stage: 'build', round, maxRounds: 5, budgetUsd: 100, spentUsd: 0,
    warned80: false, completedTasks: [], updatedAt: new Date().toISOString(), ...over,
  };
  await saveState(jobDir, state);
  return { project: 'p', repo, container: 'c', jobDir, stage, state };
}

/** A fake runAgent that records each request and answers with `output(req)`. */
function capture(output: (req: AgentRequest) => unknown) {
  const reqs: AgentRequest[] = [];
  const fn = vi.fn(async (c: StageCtx, req: AgentRequest) => {
    reqs.push(req);
    return { output: output(req), sessionId: 's', totalUsd: 0, state: c.state };
  });
  return { reqs, fn: fn as never };
}

/** Builds the stage's requests once per (round, clock) pair; returns their system prompts, grouped by key. */
async function twice(build: (round: number) => Promise<Map<string, string>>): Promise<Array<Map<string, string>>> {
  const out: Array<Map<string, string>> = [];
  for (let i = 0; i < 2; i++) {
    vi.setSystemTime(CLOCKS[i]!);
    out.push(await build(ROUNDS[i]!));
  }
  return out;
}

function expectStable([a, b]: Array<Map<string, string>>, keys: string[]): void {
  expect([...a!.keys()].sort()).toEqual([...keys].sort());
  for (const k of keys) {
    const sp = a!.get(k)!;
    expect(b!.get(k), k).toBe(sp);
    expect(sp, k).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(sp, k).not.toMatch(/round \d/);
    expect(sp.split('\n').slice(0, -1).join('\n'), k).not.toContain(JOB);
  }
}

const one = (key: string, reqs: AgentRequest[]) => {
  // Every call of a stage (e.g. each spec question turn) must carry the same system prompt.
  expect(new Set(reqs.map((r) => r.systemPrompt)).size, key).toBe(1);
  return new Map([[key, reqs[0]!.systemPrompt]]);
};

describe('prompt stability', () => {
  it('system prompts are stable across rounds and time', async () => {
    // spec: a question turn, then the spec, so one run spans two calls.
    expectStable(await twice(async (round) => {
      const ctx = await makeCtx('spec', round, { stage: 'spec' });
      let call = 0;
      const c = capture(() => (call++ === 0 ? { kind: 'questions', questions: [`q at ${new Date().toISOString()}?`] } : { kind: 'spec', spec }));
      await runSpec(ctx, 'build a shop', async (qs) => qs.map(() => 'yes'), { runAgent: c.fn });
      return one('spec', c.reqs);
    }), ['spec']);

    // plan: fallback and web prompts.
    expectStable(await twice(async (round) => {
      const m = new Map<string, string>();
      for (const kit of ['fallback', 'web'] as const) {
        const ctx = await makeCtx('plan', round);
        const c = capture(() => plan);
        await runPlan(ctx, { ...spec, kit }, { runAgent: c.fn });
        m.set(`plan-${kit}`, one(kit, c.reqs).get(kit)!);
      }
      return m;
    }), ['plan-fallback', 'plan-web']);

    // repo-map: first map.
    expectStable(await twice(async (round) => {
      const ctx = await makeCtx('repo-map', round);
      const c = capture(() => ({ markdown: '# map' }));
      await ensureRepoMap(ctx, { runAgent: c.fn, headSha: async () => `sha-${round}`, diffSince: async () => '' });
      return one('repo-map', c.reqs);
    }), ['repo-map']);

    // build: one session per area, in task mode and in fix mode.
    expectStable(await twice(async (round) => {
      const m = new Map<string, string>();
      for (const mode of ['task', 'fix'] as const) {
        const ctx = await makeCtx('build', round, mode === 'fix' ? { completedTasks: ['T1', 'T2', 'T3'] } : {});
        const c = capture(() => 'ok');
        await runBuild(ctx, spec, plan, mode === 'fix' ? `round ${round} failed` : undefined, { runAgent: c.fn, commitAll: async () => 'sha' });
        for (const area of ['frontend', 'backend', 'infra']) m.set(`${mode}-${area}`, one(area, c.reqs.filter((r) => r.role === area)).get(area)!);
      }
      return m;
    }), ['task-frontend', 'task-backend', 'task-infra', 'fix-frontend', 'fix-backend', 'fix-infra']);

    expectStable(await twice(async (round) => {
      const ctx = await makeCtx('code-review', round);
      const c = capture(() => ({ findings: [] }));
      await runCodeReview(ctx, spec, plan, `base-${round}`, { runAgent: c.fn, diffSince: async () => `diff round ${round}` });
      return one('code-review', c.reqs);
    }), ['code-review']);

    expectStable(await twice(async (round) => {
      const ctx = await makeCtx('security', round);
      const c = capture(() => ({ findings: [] }));
      await runSecurityReview(ctx, spec, plan, `base-${round}`, {
        runAgent: c.fn, runScanners: async () => ({ findings: [], unavailable: [] }), diffSince: async () => `diff round ${round}`,
      });
      return one('security', c.reqs);
    }), ['security']);

    expectStable(await twice(async (round) => {
      const ctx = await makeCtx('verify', round);
      const c = capture(() => ({ checks: [] }));
      await runBrowserAgent(ctx, spec.acceptanceChecks, 'http://localhost:3000', `/workspace/.anton/jobs/${JOB}/evidence/round-${round}`, c.fn);
      return one('browser', c.reqs);
    }), ['browser']);
  });

  it('prompts stay stable with lessons', async () => {
    await addLesson('build-backend', 'Validate input', process.env.ANTON_HOME);
    await addLesson('fallback', 'Keep commits small');
    const ctx = await makeCtx('build', 1);
    const mk = () => ({
      stdout: (async function* () { yield JSON.stringify({ type: 'result', ok: true, output: {}, sessionId: 's', totalUsd: 0, protocolVersion: 4 }) + '\n'; })(),
      kill: vi.fn(),
      then: (ok: (v: { exitCode: number }) => unknown) => Promise.resolve({ exitCode: 0 }).then(ok),
    }) as unknown as ChildLike;
    const req: AgentRequest = { role: 'backend', model: 'm', effort: 'low', systemPrompt: 'rules', prompt: 'p', maxTurns: 1, budgetUsd: 1 };
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(CLOCKS[i]!);
      await runAgent({ ...ctx, kit: 'fallback', state: { ...ctx.state, round: ROUNDS[i]! } }, req, { spawn: mk, notify: vi.fn() });
    }
    const sp = async (f: string) => JSON.parse(await readFile(join(ctx.jobDir, 'requests', f), 'utf8')).systemPrompt as string;
    const a = await sp('build-1.json');
    expect(a).toContain('- Validate input\n- Keep commits small');
    expect(await sp('build-2.json')).toBe(a);
    expectStable([new Map([['final', a]]), new Map([['final', a]])], ['final']);
  });

  it('plugin review system prompt is stable across time', async () => {
    const home = join(base, 'plugin-home');
    const MKT = 'https://github.com/acme/mkt.git';
    const map: Record<string, string> = { [MKT]: await marketplace('cave', { plugin: { 'hooks/run.sh': 'echo v1\n' } }) };
    const clone = vi.fn(fakeClone(map));
    await installPlugin('cave@acme/mkt', { home, clone });
    map[MKT] = await marketplace('cave', { plugin: { 'hooks/run.sh': 'echo v2\n' }, version: '1.1.0' });
    expectStable(await twice(async () => {
      const c = capture(() => ({ verdict: 'ok', findings: [] }));
      await updatePlugin('cave', {
        home, cloneShallow: clone, out: () => undefined, ask: async () => ['n'], isTTY: () => true,
        ensureImage: async () => 'img', startContainer: async (s) => `anton-${s}`, stopContainer: async () => undefined, runAgent: c.fn,
      });
      return one('plugin-review', c.reqs);
    }), ['plugin-review']);
  });

  it('runAgent keeps the final system prompt identical across calls in one job (jobId on the last line only)', async () => {
    const ctx = await makeCtx('build', 1);
    const L = (o: unknown) => JSON.stringify(o) + '\n';
    const spawn = () => {
      const lines = [L({ type: 'result', ok: true, output: {}, sessionId: 's', totalUsd: 0, protocolVersion: 4 })];
      return {
        stdout: (async function* () { yield* lines; })(),
        kill: vi.fn(),
        then: (ok: (v: { exitCode: number }) => unknown) => Promise.resolve({ exitCode: 0 }).then(ok),
      } as unknown as ChildLike;
    };
    const req: AgentRequest = { role: 'backend', model: 'm', effort: 'low', systemPrompt: 'rules', prompt: 'p', maxTurns: 1, budgetUsd: 1 };
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(CLOCKS[i]!);
      await runAgent({ ...ctx, state: { ...ctx.state, round: ROUNDS[i]! } }, req, { spawn, notify: vi.fn() });
    }
    const sp = async (f: string) => JSON.parse(await readFile(join(ctx.jobDir, 'requests', f), 'utf8')).systemPrompt as string;
    const a = await sp('build-1.json');
    expect(await sp('build-2.json')).toBe(a);
    expectStable([new Map([['final', a]]), new Map([['final', a]])], ['final']);
    expect(a.trimEnd().split('\n').at(-1)).toContain(JOB);
  });
});
