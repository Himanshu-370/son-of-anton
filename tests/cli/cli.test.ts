import { describe, it, expect, vi, beforeEach } from 'vitest';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ExecFn } from '../../src/core/exec.js';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { registerProject } from '../../src/core/registry.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { approveCommand } from '../../src/cli/commands/approve.js';
import { newCommand } from '../../src/cli/commands/new.js';
import { rejectCommand } from '../../src/cli/commands/reject.js';
import { resumeCommand } from '../../src/cli/commands/resume.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { stopCommand } from '../../src/cli/commands/stop.js';
import { abandonCommand } from '../../src/cli/commands/abandon.js';
import { logsCommand } from '../../src/cli/commands/logs.js';
import type { SpecDoc } from '../../src/stages/spec.js';
import { failureReportPath } from '../../src/stages/verify.js';

const DEAD_PID = 999_999;

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-cli-'));
  process.env.ANTON_HOME = home;
});

async function project(name: string, over: Partial<JobState> = {}): Promise<{ repo: string; dir: string }> {
  const repo = join(home, 'projects', name);
  const dir = jobDirOf(repo, '1-init');
  await mkdir(dir, { recursive: true });
  await registerProject(name, repo);
  await saveState(dir, {
    jobId: '1-init', project: name, stage: 'plan', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
    warned80: false, completedTasks: [], updatedAt: '', ...over,
  });
  return { repo, dir };
}

function harness(extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const spawned: string[] = [];
  const deps: CliDeps = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    preflight: async () => undefined,
    spawnRun: (name) => { spawned.push(name); },
    stopContainer: async () => undefined,
    ...extra,
  };
  return { deps, out, err, spawned, text: () => out.join('\n'), errText: () => err.join('\n') };
}

describe('anton approve', () => {
  it('at stage plan → exit 1, Nothing to approve (stage: plan)', async () => {
    await project('p', { stage: 'plan' });
    const h = harness();
    expect(await approveCommand('p', h.deps)).toBe(1);
    expect(h.errText()).toContain('Nothing to approve (stage: plan)');
    expect(h.spawned).toEqual([]);
  });

  it('at awaiting_spec_approval → spec.approved.json, tag, plan, background run', async () => {
    const { repo, dir } = await project('p', { stage: 'awaiting_spec_approval' });
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await writeFile(join(repo, '.gitignore'), '.anton/\n');
    const spec: SpecDoc = {
      title: 'Sum', summary: 's', outOfScope: [], kit: 'fallback', tech: [],
      acceptanceChecks: [{ id: 'AC-1', text: 'sums' }],
    };
    await writeFile(join(dir, 'spec.json'), JSON.stringify(spec));
    await writeFile(join(dir, 'spec.md'), '# Sum v2\n\n## Acceptance checks\n\n- **AC-1**: adds numbers\n');
    const h = harness();
    expect(await approveCommand('p', h.deps)).toBe(0);
    expect((await loadState(dir)).stage).toBe('plan');
    const approved = JSON.parse(await readFile(join(dir, 'spec.approved.json'), 'utf8'));
    expect(approved).toMatchObject({ title: 'Sum v2', acceptanceChecks: [{ id: 'AC-1', text: 'adds numbers' }] });
    const tags = (await execa('git', ['tag', '-l'], { cwd: repo })).stdout;
    expect(tags).toContain('anton/1-init/spec-approved');
    expect(h.spawned).toEqual(['p']);
  });

  it('at awaiting_final_review → done', async () => {
    const { dir } = await project('p', { stage: 'awaiting_final_review', round: 1 });
    const h = harness();
    expect(await approveCommand('p', h.deps)).toBe(0);
    expect((await loadState(dir)).stage).toBe('done');
    expect(h.spawned).toEqual([]);
  });

  it('unknown project → exit 1', async () => {
    const h = harness();
    expect(await approveCommand('nope', h.deps)).toBe(1);
    expect(h.errText()).toContain('Unknown project: nope');
  });
});

describe('anton resume', () => {
  it('on budget_cap without --budget → exit 1 mentioning --budget', async () => {
    await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'budget_cap', round: 1, spentUsd: 10 });
    const h = harness();
    expect(await resumeCommand('p', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('--budget');
    expect(h.spawned).toEqual([]);
  });

  it('on budget_cap with --budget raises the cap and unpauses', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'budget_cap', round: 1, spentUsd: 10 });
    const h = harness();
    expect(await resumeCommand('p', { budget: '15' }, h.deps)).toBe(0);
    const s = await loadState(dir);
    expect(s).toMatchObject({ stage: 'build', budgetUsd: 15 });
    expect(s.pauseReason).toBeUndefined();
    expect(h.spawned).toEqual(['p']);
  });

  it('--accept-as-is on round_cap → stage deliver and background run spawned', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'verify', pauseReason: 'round_cap', round: 3 });
    const h = harness();
    expect(await resumeCommand('p', { acceptAsIs: true }, h.deps)).toBe(0);
    expect((await loadState(dir)).stage).toBe('deliver');
    expect(h.spawned).toEqual(['p']);
  });

  it('--accept-as-is when paused from plan → exit 1', async () => {
    await project('p', { stage: 'paused', pausedFrom: 'plan', pauseReason: 'error' });
    const h = harness();
    expect(await resumeCommand('p', { acceptAsIs: true }, h.deps)).toBe(1);
    expect(h.spawned).toEqual([]);
  });

  it('an interrupted run (active stage, dead pid) is respawned', async () => {
    const { repo } = await project('p', { stage: 'build', round: 1 });
    await writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: DEAD_PID }));
    const h = harness();
    expect(await resumeCommand('p', {}, h.deps)).toBe(0);
    expect(h.spawned).toEqual(['p']);
  });
});

describe('anton reject', () => {
  it('writes notes, sets the failure report, resets round, goes to build, spawns', async () => {
    const { dir } = await project('p', { stage: 'awaiting_final_review', round: 2, lastFailureSignature: 'AC-1:failing' });
    const h = harness();
    expect(await rejectCommand('p', { notes: 'make it blue' }, h.deps)).toBe(0);
    const s = await loadState(dir);
    expect(s).toMatchObject({ stage: 'build', round: 1 });
    expect(s.lastFailureSignature).toBeUndefined();
    expect(await readFile(join(dir, 'notes-round-1.md'), 'utf8')).toContain('make it blue');
    expect(await readFile(failureReportPath(dir), 'utf8')).toContain('make it blue');
    expect(h.spawned).toEqual(['p']);
  });

  it('not at awaiting_final_review → exit 1', async () => {
    await project('p', { stage: 'build', round: 1 });
    const h = harness();
    expect(await rejectCommand('p', { notes: 'x' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('Nothing to reject (stage: build)');
  });
});

describe('anton status', () => {
  it('shows interrupted for a dead pid while at build', async () => {
    const { repo } = await project('p', { stage: 'build', round: 2, spentUsd: 1.5 });
    await writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: DEAD_PID }));
    const h = harness();
    expect(await statusCommand(undefined, h.deps)).toBe(0);
    const line = h.out.find((l) => l.startsWith('p '));
    expect(line).toContain('interrupted');
    expect(line).toContain('$1.50 / $10.00');
  });

  it('shows the pause reason for a paused project and no projects message when empty', async () => {
    const h0 = harness();
    expect(await statusCommand(undefined, h0.deps)).toBe(0);
    expect(h0.text()).toContain('No projects');
    await project('q', { stage: 'paused', pausedFrom: 'verify', pauseReason: 'round_cap', round: 3 });
    const h = harness();
    await statusCommand('q', h.deps);
    expect(h.text()).toMatch(/q\s+paused\s+3\s+\$0\.00 \/ \$10\.00\s+round_cap/);
  });
});

describe('anton stop', () => {
  it('SIGTERM, then SIGKILL after 10s, removes the container, pauses interrupted', async () => {
    const { repo, dir } = await project('p', { stage: 'build', round: 1 });
    await writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: 4242 }));
    const signals: (string | number)[] = [];
    let slept = 0;
    const stopped: string[] = [];
    const h = harness({
      kill: (pid, sig) => {
        expect(pid).toBe(4242);
        signals.push(sig);
        if (sig === 0 && signals.includes('SIGKILL')) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      },
      sleep: async (ms) => { slept += ms; },
      stopContainer: async (n) => { stopped.push(n); },
    });
    expect(await stopCommand('p', h.deps)).toBe(0);
    expect(signals.filter((s) => s !== 0)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(slept).toBeGreaterThanOrEqual(10_000);
    expect(stopped).toEqual(['anton-p']);
    expect(await loadState(dir)).toMatchObject({ stage: 'paused', pausedFrom: 'build', pauseReason: 'interrupted' });
  });
});

describe('anton stop (graceful)', () => {
  it('no SIGKILL when the run exits after SIGTERM', async () => {
    const { repo } = await project('p', { stage: 'verify', round: 1 });
    await writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: 4242 }));
    const signals: (string | number)[] = [];
    const h = harness({
      kill: (_pid, sig) => {
        signals.push(sig);
        if (sig === 0 && signals.includes('SIGTERM')) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      },
      sleep: async () => undefined,
    });
    expect(await stopCommand('p', h.deps)).toBe(0);
    expect(signals.filter((s) => s !== 0)).toEqual(['SIGTERM']);
  });
});

describe('anton logs', () => {
  it("prints the current stage's log, falling back to runner.log", async () => {
    const { dir } = await project('p', { stage: 'build', round: 1 });
    await mkdir(join(dir, 'logs'), { recursive: true });
    await writeFile(join(dir, 'logs', 'runner.log'), 'runner line\n');
    const h0 = harness();
    expect(await logsCommand('p', {}, h0.deps)).toBe(0);
    expect(h0.out).toContain('runner line');
    await writeFile(join(dir, 'logs', 'build.log'), '{"type":"log","text":"hi"}\n');
    const h = harness();
    await logsCommand('p', {}, h.deps);
    expect(h.out).toEqual([`==> ${join(dir, 'logs', 'build.log')} <==`, '{"type":"log","text":"hi"}']);
  });
});

describe('anton abandon', () => {
  it('transitions to abandoned and stops the container', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'error', round: 1 });
    const stopped: string[] = [];
    const h = harness({ stopContainer: async (n) => { stopped.push(n); } });
    expect(await abandonCommand('p', h.deps)).toBe(0);
    expect((await loadState(dir)).stage).toBe('abandoned');
    expect(stopped).toEqual(['anton-p']);
  });
});

describe('anton new', () => {
  it('Docker down → exit 2 with the preflight message, no project folder', async () => {
    const exec: ExecFn = async () => ({ exitCode: 1, stdout: '', stderr: 'Cannot connect' });
    const runSpec = vi.fn();
    const h = harness({ preflight: undefined, exec, runSpec });
    expect(await newCommand('a habit tracker', {}, h.deps)).toBe(2);
    expect(h.errText()).toContain("Docker isn't running");
    await expect(access(join(home, 'projects'))).rejects.toThrow();
    expect(runSpec).not.toHaveBeenCalled();
  });

  it('unstaged kit image → exit 1 with the build:image hint, no project folder', async () => {
    const h = harness({ ensureImage: async () => { throw new Error('Kit image files not staged — run: npm run build:image'); } });
    expect(await newCommand('a habit tracker', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('npm run build:image');
    await expect(access(join(home, 'projects'))).rejects.toThrow();
  });

  it('runs the spec loop, writes spec.md, waits for approval and prints the hint', async () => {
    const spec: SpecDoc = {
      title: 'Habits', summary: 's', outOfScope: [], kit: 'fallback', tech: [],
      acceptanceChecks: [{ id: 'AC-1', text: 'tracks' }],
    };
    const stopped: string[] = [];
    const h = harness({
      ensureImage: async () => 'img',
      startContainer: async (slug) => `anton-${slug}`,
      stopContainer: async (n) => { stopped.push(n); },
      ask: async (qs) => qs.map(() => 'yes'),
      runSpec: async (ctx, _desc, ask) => {
        expect(await ask(['q?'])).toEqual(['yes']);
        return { spec, state: ctx.state };
      },
    });
    expect(await newCommand('a habit tracker', { budget: '5' }, h.deps)).toBe(0);
    const repo = join(home, 'projects', 'a-habit-tracker');
    const dir = jobDirOf(repo, '1-init');
    expect(await loadState(dir)).toMatchObject({ stage: 'awaiting_spec_approval', budgetUsd: 5 });
    expect(await readFile(join(dir, 'spec.md'), 'utf8')).toContain('**AC-1**: tracks');
    expect(await readFile(join(repo, '.gitignore'), 'utf8')).toContain('.anton/');
    expect(h.text()).toContain(join(dir, 'spec.md'));
    expect(h.text()).toContain('anton approve a-habit-tracker');
    expect(h.text()).toMatch(/acceptance checks/i);
    expect(stopped).toEqual(['anton-a-habit-tracker']);
  });

  it('rejects a non-numeric --budget with exit 1', async () => {
    const h = harness();
    expect(await newCommand('x', { budget: 'lots' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('--budget');
  });
});
