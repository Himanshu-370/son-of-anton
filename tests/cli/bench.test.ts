import { mkdtemp, readFile, readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { benchCommand } from '../../src/cli/commands/bench.js';
import { buildProgram } from '../../src/cli/index.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { initBench } from '../../src/bench/samples.js';
import { currentJobId } from '../../src/core/job.js';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { getProject, listProjects } from '../../src/core/registry.js';
import { loadState, saveState, transition } from '../../src/core/state.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-benchcli-'));
  process.env.ANTON_HOME = home;
});

function harness(extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: string[] = [];
  const asked: string[] = [];
  const deps: CliDeps = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    preflight: async () => undefined,
    stopContainer: async () => undefined,
    isTTY: () => true,
    ask: async (q) => { asked.push(...q); return ['y']; },
    runUnattended: async (p) => {
      ran.push(p);
      const { repoPath } = await getProject(p);
      const dir = jobDirOf(repoPath, await currentJobId(repoPath));
      const s = await loadState(dir);
      let n = transition(s, 'build', { round: 1 });
      n = transition(transition(n, 'verify'), 'deliver');
      await saveState(dir, transition(n, 'awaiting_final_review', { spentUsd: 1 }));
    },
    retro: { env: {} },
    ...extra,
  };
  return { deps, out, err, ran, asked, text: () => out.join('\n'), errText: () => err.join('\n') };
}

describe('anton bench', () => {
  it('registers bench --init on the real CLI', async () => {
    const exitCodes: number[] = [];
    const h = harness({ exit: (code) => { exitCodes.push(code); } });
    await buildProgram(h.deps).exitOverride().parseAsync(['bench', '--init'], { from: 'user' });
    expect(exitCodes).toEqual([]);
    expect(await readdir(join(home, 'bench'))).toContain('manifest.json');
  });

  it('without samples asks for --init', async () => {
    const h = harness();
    expect(await benchCommand({}, h.deps)).toBe(1);
    expect(h.errText()).toContain('Run anton bench --init first.');
  });

  it('with a missing sample spec asks for --init', async () => {
    await initBench(home);
    await unlink(join(home, 'bench', 'api-todo', 'spec.json'));
    const h = harness();
    expect(await benchCommand({ only: 'api-todo', yes: true }, h.deps)).toBe(1);
    expect(h.errText()).toContain('Run anton bench --init first.');
    expect(h.ran).toEqual([]);
  });

  it.each(['', ' , , '])('rejects an empty --only selection %j', async (only) => {
    await initBench(home);
    const h = harness();
    expect(await benchCommand({ only, yes: true }, h.deps)).toBe(1);
    expect(h.errText()).toContain('--only');
    expect(h.ran).toEqual([]);
  });

  it('--init copies the samples', async () => {
    const h = harness();
    expect(await benchCommand({ init: true }, h.deps)).toBe(0);
    expect(await readdir(join(home, 'bench'))).toContain('manifest.json');
  });

  it('prints samples and estimate, asks, then runs', async () => {
    await initBench(home);
    const h = harness();
    expect(await benchCommand({ only: 'cli-wordcount,api-todo' }, h.deps)).toBe(0);
    expect(h.text()).toContain('cli-wordcount');
    expect(h.asked).toEqual(['Run the bench now (est. $6.00–$6.00)? [y/N]']);
    expect(h.ran).toHaveLength(2);
    expect(await readdir(join(home, 'bench', 'results'))).toHaveLength(2);
    expect(await listProjects()).toEqual([]);
  });

  it('no TTY without --yes refuses; --yes runs', async () => {
    await initBench(home);
    const h = harness({ isTTY: () => false });
    expect(await benchCommand({ only: 'api-todo' }, h.deps)).toBe(1);
    expect(h.ran).toEqual([]);
    expect(h.asked).toEqual([]);
    expect(h.errText()).toContain('--yes');
    const h2 = harness({ isTTY: () => false });
    expect(await benchCommand({ only: 'api-todo', yes: true }, h2.deps)).toBe(0);
    expect(h2.asked).toEqual([]);
    expect(h2.ran).toHaveLength(1);
  });

  it('answer other than y declines', async () => {
    await initBench(home);
    for (const a of ['', 'n', 'yep', 'no']) {
      const h = harness({ ask: async () => [a] });
      expect(await benchCommand({ only: 'api-todo' }, h.deps)).toBe(0);
      expect(h.ran).toEqual([]);
      expect(h.text()).toContain('Bench not started.');
    }
    const h = harness({ ask: async () => [' YES '] });
    await benchCommand({ only: 'api-todo' }, h.deps);
    expect(h.ran).toHaveLength(1);
  });

  it('unknown --only name is an error', async () => {
    await initBench(home);
    const h = harness();
    expect(await benchCommand({ only: 'nope' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('Unknown bench sample "nope"');
  });

  it('Ctrl-C mid-run stops the container and deregisters bench projects', async () => {
    await initBench(home);
    let handler: (() => Promise<void> | void) | undefined;
    const stopped: string[] = [];
    const codes: number[] = [];
    const h = harness({
      onSigint: (fn) => { handler = fn; return () => { handler = undefined; }; },
      exit: (c) => { codes.push(c); },
      stopContainer: async (n) => { stopped.push(n); },
      runUnattended: async (p) => {
        expect((await listProjects()).map((x) => x.name)).toEqual([p]);
        await handler!();
      },
    });
    await benchCommand({ only: 'api-todo', yes: true }, h.deps);
    expect(codes).toEqual([130]);
    expect(stopped[0]).toMatch(/^anton-bench-api-todo-/);
    expect(await listProjects()).toEqual([]);
  });
});

it('compares with the requested baseline and saves the report', async () => {
  await initBench(home);
  const opts = { only: 'api-todo', yes: true };
  expect(await benchCommand({ ...opts, label: 'Before' }, harness().deps)).toBe(0);
  const dir = join(home, 'bench', 'results');
  const first = (await readdir(dir)).find((name) => name.endsWith('.json'))!;
  const next = harness();
  expect(await benchCommand({ ...opts, compare: first.slice(0, -5), label: 'After' }, next.deps)).toBe(0);
  const report = (await readdir(dir)).find((name) => name.endsWith('.md') && name !== first.replace(/\.json$/, '.md'))!;
  expect(await readFile(join(dir, report), 'utf8')).toContain('Previous run');
  expect(next.text()).toContain('(Before)');
  expect(next.text()).toContain('(After)');
  const invalid = harness();
  expect(await benchCommand({ ...opts, compare: 'missing' }, invalid.deps)).toBe(1);
  expect(invalid.ran).toEqual([]);
});
