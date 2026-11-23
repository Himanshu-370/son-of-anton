import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { beforeEach, describe, expect, it } from 'vitest';
import { benchProjectName, estimateBench, newRunId, runBench, type BenchRun } from '../../src/bench/run.js';
import { initBench, loadSamples, type BenchSample } from '../../src/bench/samples.js';
import { currentJobId } from '../../src/core/job.js';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { getProject, listProjects, registerProject, unregisterProject } from '../../src/core/registry.js';
import { loadState, pause, saveState, transition } from '../../src/core/state.js';
import type { HistoryEntry } from '../../src/core/history.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-benchrun-'));
  process.env.ANTON_HOME = home;
  await initBench(home);
});

type Seen = { project: string; stage: string; kind: string; approved: unknown; budgetUsd: number; bench?: string; repo: string; branch?: string };

/** Fake runner: checks the job looks approved, then moves it to awaiting_final_review (or pauses / throws). */
function fakeRunner(behave: Record<string, 'deliver' | 'pause' | 'throw'> = {}) {
  const seen: Seen[] = [];
  const run = async (project: string) => {
    const { repoPath: repo } = await getProject(project);
    const dir = jobDirOf(repo, await currentJobId(repo));
    const s = await loadState(dir);
    seen.push({
      project, stage: s.stage, kind: s.kind, budgetUsd: s.budgetUsd, repo, branch: s.branch,
      ...(s.bench ? { bench: s.bench } : {}),
      approved: JSON.parse(await readFile(join(dir, 'spec.approved.json'), 'utf8')),
    });
    const sample = project.split('-').slice(1, 3).join('-');
    const mode = behave[sample] ?? 'deliver';
    if (mode === 'throw') throw new Error('boom: fake crash');
    if (mode === 'pause') {
      await saveState(dir, pause(transition(s, 'build', { round: 1, spentUsd: 1.5 }), 'budget_cap'));
      return;
    }
    await mkdir(join(dir, 'evidence'), { recursive: true });
    const results = { results: [{ id: 'AC-1', status: 'pass' }, { id: 'AC-2', status: 'fail' }] };
    await writeFile(join(dir, 'evidence', 'results-verify-1.json'), JSON.stringify(results));
    await writeFile(join(dir, 'evidence', 'results.json'), JSON.stringify({ results: [{ id: 'AC-1', status: 'pass' }, { id: 'AC-2', status: 'pass' }] }));
    await writeFile(join(dir, 'usage.json'), JSON.stringify({ build: { input: 10, output: 5, cacheRead: 30, cacheWrite: 0 } }));
    let n = transition(s, 'build', { round: 1 });
    n = transition(n, 'verify');
    n = transition(n, 'build', { round: 2 });
    n = transition(n, 'verify');
    n = transition(n, 'deliver');
    await saveState(dir, transition(n, 'awaiting_final_review', { spentUsd: 2.25 }));
  };
  return { seen, run };
}

function deps(r: ReturnType<typeof fakeRunner>) {
  const stopped: string[] = [];
  return { stopped, deps: { runUnattended: r.run, stopContainer: async (n: string) => { stopped.push(n); }, log: () => undefined } };
}

describe('runBench', () => {
  it('each sample becomes a bench job starting at plan with its pre-approved spec', async () => {
    const samples = await loadSamples(home, ['cli-wordcount', 'web-counter']);
    const r = fakeRunner();
    const runId = newRunId();
    await runBench(samples, { runId, deps: deps(r).deps });
    expect(r.seen.map((s) => s.project)).toEqual([`bench-cli-wordcount-${runId.toLowerCase()}`, `bench-web-counter-${runId.toLowerCase()}`]);
    for (const [i, s] of r.seen.entries()) {
      expect(s.stage).toBe('plan');
      expect(s.kind).toBe('new');
      expect(s.budgetUsd).toBe(3);
      expect(s.bench).toBe(runId);
      expect(s.approved).toMatchObject({ title: samples[i]!.spec.title, kit: samples[i]!.kit });
      expect(s.repo).toBe(join(home, 'bench', 'runs', runId, samples[i]!.name));
      const tags = (await execa('git', ['tag', '-l'], { cwd: s.repo })).stdout;
      expect(tags).toContain('anton/1-init/spec-approved');
    }
  });

  it('change sample is a git repo adopted before the change job', async () => {
    const samples = await loadSamples(home, ['change-greeting']);
    const metadata = join(samples[0]!.repoDir!, '.git');
    await mkdir(metadata);
    await writeFile(join(metadata, 'fixture-marker'), 'synthetic metadata');
    const r = fakeRunner();
    const runId = newRunId();
    await runBench(samples, { runId, deps: deps(r).deps });
    const s = r.seen[0]!;
    expect(s.kind).toBe('change');
    expect(s.stage).toBe('plan');
    expect(s.branch).toMatch(/^anton\/1-/);
    const files = (await execa('git', ['ls-files'], { cwd: s.repo })).stdout.split('\n');
    expect(files).toContain('greet.js');
    const log = (await execa('git', ['log', '--format=%s', '--all'], { cwd: s.repo })).stdout;
    expect(log).toContain('chore: bench sample');
    expect(await readdir(join(s.repo, '.git'))).not.toContain('fixture-marker');
  });

  it('a paused sample is recorded and the next still runs', async () => {
    const samples = await loadSamples(home, ['cli-wordcount', 'api-todo']);
    const r = fakeRunner({ 'cli-wordcount': 'pause' });
    const res = await runBench(samples, { runId: newRunId(), deps: deps(r).deps });
    expect(res.results.map((x) => x.outcome)).toEqual(['paused: budget_cap', 'delivered']);
    expect(res.results[0]!.spentUsd).toBe(1.5);
    expect(res.results[1]).toMatchObject({ sample: 'api-todo', checks: 2, firstTryPass: 0.5, rounds: 2, spentUsd: 2.25, cacheHitRate: 0.75 });
  });

  it('a throwing sample is recorded as failed; containers stopped; projects deregistered', async () => {
    const samples = await loadSamples(home, ['cli-wordcount', 'api-todo']);
    const r = fakeRunner({ 'cli-wordcount': 'throw' });
    const d = deps(r);
    const runId = newRunId();
    const res = await runBench(samples, { runId, deps: d.deps });
    expect(res.results[0]).toMatchObject({ sample: 'cli-wordcount', outcome: 'failed: boom: fake crash' });
    expect(res.results[1]!.outcome).toBe('delivered');
    expect(d.stopped).toEqual(samples.map((s) => `anton-bench-${s.name}-${runId.toLowerCase()}`));
    expect(await listProjects()).toEqual([]);
  });

  it('results file has runId, label, configHash and per-sample results', async () => {
    await writeFile(join(home, 'config.yaml'), 'budget:\n  defaultUsd: 5\n');
    const samples = await loadSamples(home, ['api-todo']);
    const runId = newRunId();
    await runBench(samples, { runId, label: 'caveman-on', deps: deps(fakeRunner()).deps });
    const saved = JSON.parse(await readFile(join(home, 'bench', 'results', `${runId}.json`), 'utf8')) as BenchRun;
    expect(saved).toMatchObject({ runId, label: 'caveman-on', results: [{ sample: 'api-todo', outcome: 'delivered' }] });
    expect(saved.configHash).toMatch(/^[0-9a-f]{8}$/);
    expect(typeof saved.at).toBe('string');
  });

  it('configHash is none without config.yaml', async () => {
    const samples = await loadSamples(home, ['api-todo']);
    const res = await runBench(samples, { runId: newRunId(), deps: deps(fakeRunner()).deps });
    expect(res.configHash).toBe('none');
  });

  it('bench never runs retro', async () => {
    const samples = await loadSamples(home, ['api-todo']);
    const r = fakeRunner();
    await runBench(samples, { runId: newRunId(), deps: deps(r).deps });
    const dir = jobDirOf(r.seen[0]!.repo, '1-init');
    expect((await loadState(dir)).stage).toBe('awaiting_final_review');
    expect(await readdir(dir)).not.toContain('retro.json');
    expect(await readdir(home)).not.toContain('lessons');
  });

  it('real registry projects are untouched', async () => {
    await registerProject('mine', '/fake/path/mine');
    const samples = await loadSamples(home, ['api-todo', 'change-greeting']);
    await runBench(samples, { runId: newRunId(), deps: deps(fakeRunner({ 'change-greeting': 'throw' })).deps });
    expect(await listProjects()).toEqual([{ name: 'mine', repoPath: '/fake/path/mine' }]);
  });

  it('preserves an existing registration with the exact generated bench name', async () => {
    const samples = await loadSamples(home, ['api-todo']);
    const runId = newRunId();
    const name = benchProjectName('api-todo', runId);
    await registerProject(name, '/fixture/existing');
    const runner = fakeRunner();
    const d = deps(runner);
    const result = await runBench(samples, { runId, deps: d.deps });
    expect(result.results[0]!.outcome).toMatch(/^failed:.*already exists/);
    expect(await getProject(name)).toEqual({ name, repoPath: '/fixture/existing' });
    expect(runner.seen).toEqual([]);
    expect(d.stopped).toEqual([]);
  });

  it('retains metrics after a runner error and persists cleanup errors while continuing', async () => {
    const samples = await loadSamples(home, ['cli-wordcount', 'api-todo']);
    const runId = newRunId();
    const runner = fakeRunner();
    const d = deps(runner);
    const result = await runBench(samples, { runId, deps: {
      ...d.deps,
      runUnattended: async (p) => {
        await runner.run(p);
        if (p.includes('cli-wordcount')) throw new Error('synthetic runner error');
      },
      stopContainer: async (n) => {
        if (n.includes('cli-wordcount')) throw new Error('synthetic cleanup error');
      },
    } });
    expect(result.results[0]).toMatchObject({
      outcome: 'failed: synthetic runner error',
      checks: 2, firstTryPass: 0.5, rounds: 2, spentUsd: 2.25, cacheHitRate: 0.75,
      cleanupErrors: [expect.stringContaining('synthetic cleanup error')],
    });
    expect(result.results[1]!.outcome).toBe('delivered');
    expect(await listProjects()).toEqual([]);
    expect(JSON.parse(await readFile(join(home, 'bench', 'results', `${runId}.json`), 'utf8'))).toEqual(result);
  });

  it('serializes simultaneous registry writes', async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => registerProject(`fixture-${i}`, `/fixture/${i}`)));
    expect(await listProjects()).toHaveLength(6);
  });

  it('skips cleanup when the registry owner does not match', async () => {
    await registerProject('bench-fixture', '/fixture/repo', 'fixture-owner');
    await unregisterProject('bench-fixture', 'different-fixture-owner', async () => {
      throw new Error('Unexpected container cleanup');
    });
    expect(await getProject('bench-fixture')).toEqual({ name: 'bench-fixture', repoPath: '/fixture/repo' });
  });

  it('reports an invalid evidence directory while keeping independent metrics', async () => {
    const samples = await loadSamples(home, ['api-todo']);
    const result = await runBench(samples, { runId: newRunId(), deps: {
      ...deps(fakeRunner()).deps,
      runUnattended: async (p) => {
        const { repoPath } = await getProject(p);
        const dir = jobDirOf(repoPath, await currentJobId(repoPath));
        const state = await loadState(dir);
        await saveState(dir, pause(transition(state, 'build', { round: 1, spentUsd: 1.5 }), 'budget_cap'));
        await writeFile(join(dir, 'evidence'), 'synthetic file where a directory was expected');
        await writeFile(join(dir, 'usage.json'), JSON.stringify({ build: { input: 10, output: 5, cacheRead: 30, cacheWrite: 0 } }));
      },
    } });
    expect(result.results[0]).toMatchObject({
      outcome: expect.stringContaining('is not a directory'),
      checks: 0, rounds: 1, spentUsd: 1.5, cacheHitRate: 0.75,
    });
    expect(result.results[0]!.firstTryPass).toBeUndefined();
  });

  it('records a Docker removal error but accepts an already absent container', async () => {
    const samples = await loadSamples(home, ['cli-wordcount', 'api-todo']);
    const result = await runBench(samples, { runId: newRunId(), deps: {
      runUnattended: fakeRunner().run,
      log: () => undefined,
      exec: async (_cmd, args) => ({
        exitCode: 1,
        stdout: '',
        stderr: args.at(-1)?.includes('cli-wordcount') ? 'synthetic daemon error' : 'No such container: fixture',
      }),
    } });
    expect(result.results[0]!.cleanupErrors).toEqual([expect.stringContaining('synthetic daemon error')]);
    expect(result.results[1]!.cleanupErrors).toBeUndefined();
    expect(await listProjects()).toEqual([]);
  });
});

describe('estimateBench', () => {
  const sample = (name: string, checks = 2): BenchSample => ({
    name, kind: 'new', kit: 'fallback', budgetUsd: 3, description: 'fake', dir: '/fake',
    spec: { title: 't', summary: 's', outOfScope: [], tech: [], kit: 'fallback', acceptanceChecks: Array.from({ length: checks }, (_, i) => ({ id: `AC-${i + 1}`, text: 'x' })) },
  });
  const hist = (spentUsd: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
    jobId: '1-init', project: `p${spentUsd}`, kind: 'new', kit: 'fallback', checks: 2, spentUsd, stageUsd: {}, at: '2026-01-01', ...over,
  });
  const run = (runId: string, rows: [string, number][]): BenchRun => ({
    runId, configHash: 'none', at: '2026-01-01',
    results: rows.map(([sample, spentUsd]) => ({ sample, outcome: 'delivered', checks: 1, rounds: 1, spentUsd })),
  });

  it('ignores failed attempts when estimating the next run', () => {
    const earlier = run('r1', [['a', 0], ['b', 0]]);
    for (const row of earlier.results) row.outcome = 'failed: setup';
    expect(estimateBench([sample('a')], [], [earlier])).toEqual({ lowUsd: 3, highUsd: 3 });
    expect(estimateBench([sample('b')], [hist(1), hist(2), hist(3)], [earlier]))
      .toEqual({ lowUsd: 1.5, highUsd: 2.5 });
  });

  it('estimate uses earlier bench results, then history, then budget', () => {
    const history = [hist(1), hist(2), hist(3), hist(9, { bench: 'x' })];
    const earlier = [run('r1', [['a', 0.5]]), run('r2', [['a', 1.5]])];
    const e = estimateBench([sample('a'), sample('b'), sample('c', 20)], history, earlier);
    // a: p25/p75 of [0.5, 1.5] = 0.75/1.25; b: history p25/p75 of [1,2,3] = 1.5/2.5; c: no match → budget 3/3
    expect(e.lowUsd).toBeCloseTo(0.75 + 1.5 + 3);
    expect(e.highUsd).toBeCloseTo(1.25 + 2.5 + 3);
  });
});
