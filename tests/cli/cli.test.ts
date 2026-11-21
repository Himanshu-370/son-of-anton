import { describe, it, expect, vi, beforeEach } from 'vitest';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { ExecFn } from '../../src/core/exec.js';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { getProject, listProjects, registerProject } from '../../src/core/registry.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { approveCommand } from '../../src/cli/commands/approve.js';
import { newCommand } from '../../src/cli/commands/new.js';
import { rejectCommand } from '../../src/cli/commands/reject.js';
import { resumeCommand } from '../../src/cli/commands/resume.js';
import { allowanceLeftUsd } from '../../src/core/budget.js';
import { DEFAULT_ALLOWANCES } from '../../src/core/anton-config.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { stopCommand } from '../../src/cli/commands/stop.js';
import { changeCommand } from '../../src/cli/commands/change.js';
import { adoptCommand } from '../../src/cli/commands/adopt.js';
import { secretsEditCommand } from '../../src/cli/commands/secrets.js';
import { secretsPath } from '../../src/core/secrets.js';
import { runSpecSession } from '../../src/cli/spec-session.js';
import { defaultOpenEditor, resolveDeps } from '../../src/cli/deps.js';
import { abandonCommand } from '../../src/cli/commands/abandon.js';
import { acceptRiskCommand } from '../../src/cli/commands/accept-risk.js';
import { loadAcceptedRisks } from '../../src/security/risks.js';
import { logsCommand } from '../../src/cli/commands/logs.js';
import type { SpecDoc } from '../../src/stages/spec.js';
import { failureReportPath } from '../../src/stages/verify.js';
import { failuresPath } from '../../src/stages/qa.js';
import type { RetroClient } from '../../src/retro/run.js';

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
    // No key by default: unit tests never reach the API.
    retro: { env: {} },
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
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'budget_cap', round: 1, spentUsd: 10, warned80: true });
    const h = harness();
    expect(await resumeCommand('p', { budget: '15' }, h.deps)).toBe(0);
    const s = await loadState(dir);
    expect(s).toMatchObject({ stage: 'build', budgetUsd: 15, warned80: false });
    expect(s.pauseReason).toBeUndefined();
    expect(h.spawned).toEqual(['p']);
  });

  it('resume without --budget on allowance refuses', async () => {
    await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'allowance', round: 1, spentUsd: 7.02, stageSpentUsd: { plan: 1, build: 6.02 } });
    const h = harness();
    expect(await resumeCommand('p', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('p: paused, build share used: $7.02 of $7.00 (spec through build). Resume with: anton resume p --budget <usd>');
    expect(h.spawned).toEqual([]);
  });

  it('resume --budget raises every allowance', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'allowance', round: 1, spentUsd: 7.02, stageSpentUsd: { plan: 1, build: 6.02 } });
    const h = harness();
    expect(await resumeCommand('p', { budget: '20' }, h.deps)).toBe(0);
    const s = await loadState(dir);
    expect(s).toMatchObject({ stage: 'build', budgetUsd: 20 });
    expect(allowanceLeftUsd(s, 'plan', DEFAULT_ALLOWANCES)).toBeCloseTo(3);
    expect(allowanceLeftUsd(s, 'build', DEFAULT_ALLOWANCES)).toBeCloseTo(14 - 7.02);
    expect(allowanceLeftUsd(s, 'verify', DEFAULT_ALLOWANCES)).toBeCloseTo(19 - 7.02);
    expect(h.spawned).toEqual(['p']);
  });

  it('resume seeds stageSpentUsd from cost.json for an old job', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'error', round: 1, spentUsd: 2 });
    await writeFile(join(dir, 'cost.json'), JSON.stringify({ plan: 0.5, build: 1.5 }));
    const h = harness();
    expect(await resumeCommand('p', {}, h.deps)).toBe(0);
    expect((await loadState(dir)).stageSpentUsd).toEqual({ plan: 0.5, build: 1.5 });
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

  it('reject increments rejects', async () => {
    const { dir } = await project('p', { stage: 'awaiting_final_review', round: 2 });
    expect(await rejectCommand('p', { notes: 'x' }, harness().deps)).toBe(0);
    expect((await loadState(dir)).rejects).toBe(1);
    await saveState(dir, { ...(await loadState(dir)), stage: 'awaiting_final_review' });
    expect(await rejectCommand('p', { notes: 'y' }, harness().deps)).toBe(0);
    expect((await loadState(dir)).rejects).toBe(2);
  });

  it('reject notes fan out to every plan area', async () => {
    const { dir } = await project('p', { stage: 'awaiting_final_review', round: 2, completedFixAreas: ['backend'] });
    const t = (id: string, area: string) => ({ id, title: id, acceptanceChecks: [], instructions: 'x', area });
    await writeFile(join(dir, 'plan.json'), JSON.stringify({
      commands: { install: 'i', test: 't' },
      tasks: [t('T1', 'frontend'), t('T2', 'backend'), t('T3', 'backend')],
    }));
    const h = harness();
    expect(await rejectCommand('p', { notes: 'make it blue' }, h.deps)).toBe(0);
    expect(JSON.parse(await readFile(failuresPath(dir), 'utf8'))).toEqual([
      { area: 'backend', kind: 'review', id: 'NOTES-1', text: 'make it blue' },
      { area: 'frontend', kind: 'review', id: 'NOTES-1', text: 'make it blue' },
    ]);
    expect(await readFile(join(dir, 'notes-round-1.md'), 'utf8')).toContain('make it blue');
    expect((await loadState(dir)).completedFixAreas).toEqual([]);
  });

  it('while the previous runner is still finishing (live lock) → exit 1 "still finishing", nothing changed', async () => {
    const { repo, dir } = await project('p', { stage: 'awaiting_final_review', round: 2 });
    await writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: process.pid }));
    const h = harness();
    expect(await rejectCommand('p', { notes: 'make it blue' }, h.deps)).toBe(1);
    expect(h.errText()).toMatch(/still finishing.*try again in a moment/);
    expect(h.spawned).toEqual([]);
    expect((await loadState(dir)).stage).toBe('awaiting_final_review');
    await expect(access(failureReportPath(dir))).rejects.toThrow();
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

describe('anton status: cache', () => {
  it('status shows cache rate', async () => {
    const { dir } = await project('q', { stage: 'build', round: 1 });
    const h0 = harness();
    await statusCommand('q', h0.deps);
    expect(h0.out.find((l) => l.startsWith('q '))).toMatch(/\s-$/);
    const u = (input: number, cacheRead: number, cacheWrite: number) => ({ input, output: 9, cacheRead, cacheWrite });
    await writeFile(join(dir, 'usage.json'), JSON.stringify({ plan: u(50, 0, 50), build: u(50, 620, 230) }));
    const h = harness();
    await statusCommand('q', h.deps);
    expect(h.out[0]).toMatch(/CACHE$/);
    expect(h.out.find((l) => l.startsWith('q '))).toMatch(/\scache 62%$/);
  });
});

describe('anton status: allowance', () => {
  it('shows spend over cap and the allowance pause reason', async () => {
    await project('q', { stage: 'paused', pausedFrom: 'build', pauseReason: 'allowance', round: 1, spentUsd: 7.02 });
    const h = harness();
    await statusCommand('q', h.deps);
    expect(h.text()).toMatch(/q\s+paused\s+1\s+\$7\.02 \/ \$10\.00\s+allowance/);
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

describe('anton stop (lock cleanup)', () => {
  const lockFile = (repo: string) => join(repo, '.anton', 'run.lock');
  function killer(onKill?: () => void) {
    const signals: (string | number)[] = [];
    const kill = (_pid: number, sig: NodeJS.Signals | 0) => {
      signals.push(sig);
      if (sig === 'SIGKILL') onKill?.();
      if (sig === 0 && signals.includes('SIGKILL')) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    };
    return kill;
  }

  it('removes the dead run lock after stopping', async () => {
    const { repo } = await project('p', { stage: 'build', round: 1 });
    await writeFile(lockFile(repo), JSON.stringify({ pid: 4242 }));
    const h = harness({ kill: killer(), sleep: async () => undefined });
    expect(await stopCommand('p', h.deps)).toBe(0);
    await expect(access(lockFile(repo))).rejects.toThrow();
  });

  it('leaves the lock alone if it now holds a different pid', async () => {
    const { repo } = await project('p', { stage: 'build', round: 1 });
    await writeFile(lockFile(repo), JSON.stringify({ pid: 4242 }));
    const h = harness({
      kill: killer(() => writeFileSync(lockFile(repo), JSON.stringify({ pid: 5555 }))),
      sleep: async () => undefined,
    });
    expect(await stopCommand('p', h.deps)).toBe(0);
    expect(JSON.parse(await readFile(lockFile(repo), 'utf8')).pid).toBe(5555);
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

  describe('change job restore', () => {
    async function changeRepo(over: Partial<JobState> = {}) {
      const { repo, dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'error', kind: 'change', branch: 'anton/1-init', fromBranch: 'main', ...over });
      const g = (...a: string[]) => execa('git', a, { cwd: repo });
      await g('init', '-q', '-b', 'main');
      await g('config', 'user.email', 't@t'); await g('config', 'user.name', 't');
      await writeFile(join(repo, '.gitignore'), '.anton/\n');
      await writeFile(join(repo, 'a.txt'), 'a');
      await g('add', '-A'); await g('commit', '-qm', 'first');
      await g('switch', '-qc', 'anton/1-init');
      const cur = async () => (await g('branch', '--show-current')).stdout;
      return { repo, dir, g, cur };
    }
    it('clean repo: switches back to fromBranch and keeps the anton branch', async () => {
      const { g, cur } = await changeRepo();
      expect(await abandonCommand('p', harness().deps)).toBe(0);
      expect(await cur()).toBe('main');
      expect((await g('branch', '--list', 'anton/1-init')).stdout).toContain('anton/1-init');
    });
    it('dirty repo: prints the git switch hint and stays on the branch', async () => {
      const { repo, dir, cur } = await changeRepo();
      await writeFile(join(repo, 'a.txt'), 'dirty');
      const h = harness();
      expect(await abandonCommand('p', h.deps)).toBe(0);
      expect(h.text()).toContain('git switch main');
      expect(await cur()).toBe('anton/1-init');
      expect((await loadState(dir)).stage).toBe('abandoned');
    });
    it('HEAD on another branch with a clean tree: no switch, nothing printed about switching', async () => {
      const { g, cur } = await changeRepo();
      await g('switch', '-qc', 'feature-x');
      const h = harness();
      expect(await abandonCommand('p', h.deps)).toBe(0);
      expect(await cur()).toBe('feature-x');
      expect(h.text()).not.toMatch(/switch/i);
    });
    it('job without fromBranch: no git touched', async () => {
      const { cur } = await changeRepo({ fromBranch: undefined });
      expect(await abandonCommand('p', harness().deps)).toBe(0);
      expect(await cur()).toBe('anton/1-init');
    });
  });
});

describe('change job branch guard', () => {
  async function changeJob(over: Partial<JobState>) {
    const { repo, dir } = await project('p', { kind: 'change', branch: 'anton/1-init', fromBranch: 'main', ...over });
    const g = (...a: string[]) => execa('git', a, { cwd: repo });
    await g('init', '-q', '-b', 'main');
    await g('config', 'user.email', 't@t'); await g('config', 'user.name', 't');
    await writeFile(join(repo, '.gitignore'), '.anton/\n');
    await writeFile(join(repo, 'a.txt'), 'a');
    await g('add', '-A'); await g('commit', '-qm', 'first');
    const cur = async () => (await g('branch', '--show-current')).stdout;
    return { repo, dir, g, cur };
  }
  it('approve (spec) on the wrong branch: refuses, commits nothing, spawns nothing', async () => {
    const { repo, dir, g } = await changeJob({ stage: 'awaiting_spec_approval' });
    await g('branch', 'anton/1-init'); // exists, but HEAD stays on main
    await writeFile(join(repo, 'user-edit.txt'), 'mine');
    const h = harness();
    expect(await approveCommand('p', h.deps)).toBe(1);
    expect(h.errText()).toContain('git switch anton/1-init');
    expect((await g('log', '--oneline')).stdout.split('\n')).toHaveLength(1);
    expect((await loadState(dir)).stage).toBe('awaiting_spec_approval');
    expect(h.spawned).toEqual([]);
  });
  it('resume on the wrong branch: refuses and spawns nothing', async () => {
    await changeJob({ stage: 'paused', pausedFrom: 'build', pauseReason: 'error', round: 1 });
    const h = harness();
    expect(await resumeCommand('p', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('git switch anton/1-init');
    expect(h.spawned).toEqual([]);
  });
  it('resume of a done change job says nothing to resume even off-branch', async () => {
    await changeJob({ stage: 'done', round: 1 });
    const h = harness();
    expect(await resumeCommand('p', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('Nothing to resume');
  });
  it('final accept works after the user switched to main', async () => {
    const { dir, cur } = await changeJob({ stage: 'awaiting_final_review', round: 1 });
    const h = harness();
    expect(await approveCommand('p', h.deps)).toBe(0);
    expect((await loadState(dir)).stage).toBe('done');
    expect(await cur()).toBe('main');
  });
  it('spec approval off-branch still refuses', async () => {
    const { dir } = await changeJob({ stage: 'awaiting_spec_approval' });
    const h = harness();
    expect(await approveCommand('p', h.deps)).toBe(1);
    expect(h.errText()).toContain('git switch anton/1-init');
    expect((await loadState(dir)).stage).toBe('awaiting_spec_approval');
  });
  it('final accept on the job branch with a clean tree switches back to fromBranch', async () => {
    const { dir, g, cur } = await changeJob({ stage: 'awaiting_final_review', round: 1 });
    await g('switch', '-qc', 'anton/1-init');
    const h = harness();
    expect(await approveCommand('p', h.deps)).toBe(0);
    expect((await loadState(dir)).stage).toBe('done');
    expect(await cur()).toBe('main');
    expect(h.text()).toContain('Switched back to main');
  });
  it('final accept with a failing switch prints the hint instead of throwing', async () => {
    const { cur, g } = await changeJob({ stage: 'awaiting_final_review', round: 1, fromBranch: 'no-such-branch' });
    await g('switch', '-qc', 'anton/1-init');
    const h = harness();
    expect(await approveCommand('p', h.deps)).toBe(0);
    expect(h.text()).toContain('git switch no-such-branch');
    expect(await cur()).toBe('anton/1-init');
  });
  // Retro may wait on a slow API call; the repo must already be back on fromBranch by then.
  const branchAtRetro = (cur: () => Promise<string>) => {
    const seen: string[] = [];
    const client: RetroClient = {
      createBatch: async () => { seen.push(await cur()); return 'msgbatch_1'; },
      getBatch: async () => ({ ended: false }),
      send: async () => { throw new Error('unused'); },
    };
    return { seen, retro: { client: () => client, env: { ANTHROPIC_API_KEY: 'test-key-not-real' } } };
  };
  it.each(['approve', 'abandon'] as const)('%s switches back before Retro runs', async (cmd) => {
    const stage = cmd === 'approve' ? 'awaiting_final_review' : 'paused';
    const { g, cur } = await changeJob({ stage, round: 1, ...(cmd === 'abandon' ? { pausedFrom: 'build', pauseReason: 'error' } : {}) });
    await g('switch', '-qc', 'anton/1-init');
    const r = branchAtRetro(cur);
    const h = harness({ retro: r.retro });
    expect(await (cmd === 'approve' ? approveCommand : abandonCommand)('p', h.deps)).toBe(0);
    expect(r.seen).toEqual(['main']);
    const lines = h.out.join('\n');
    expect(lines.indexOf('Switched back to main')).toBeLessThan(lines.indexOf('Retro submitted'));
  });
  it.each(['approve', 'abandon'] as const)('%s still submits Retro when switch-back throws', async (cmd) => {
    const stage = cmd === 'approve' ? 'awaiting_final_review' : 'paused';
    const { g, cur, dir } = await changeJob({ stage, round: 1, ...(cmd === 'abandon' ? { pausedFrom: 'build', pauseReason: 'error' } : {}) });
    await g('switch', '-qc', 'anton/1-init');
    const r = branchAtRetro(cur);
    const h = harness({ retro: r.retro });
    const out = h.deps.out!;
    h.deps.out = (s) => { if (s.startsWith('Switched back')) throw new Error('boom'); out(s); };
    await (cmd === 'approve' ? approveCommand : abandonCommand)('p', h.deps);
    expect(r.seen).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, 'retro.json'), 'utf8'))).toMatchObject({ status: 'submitted' });
  });
  it('new jobs are unaffected by the branch guard', async () => {
    await project('p', { stage: 'awaiting_final_review', round: 1 });
    expect(await approveCommand('p', harness().deps)).toBe(0);
  });
});

describe('retro hooks', () => {
  const fakeRetro = (opts: { throws?: boolean } = {}) => {
    const batches: unknown[] = [];
    const client: RetroClient = {
      createBatch: async (_id, params) => {
        if (opts.throws) throw new Error('network down');
        batches.push(params);
        return 'msgbatch_1';
      },
      getBatch: async () => ({ ended: false }),
      send: async () => { throw new Error('unused'); },
    };
    return { batches, retro: { client: () => client, env: { ANTHROPIC_API_KEY: 'test-key-not-real' } } };
  };
  const retroJson = async (dir: string) => JSON.parse(await readFile(join(dir, 'retro.json'), 'utf8'));

  it('final accept submits one retro and records submitted', async () => {
    const { dir } = await project('p', { stage: 'awaiting_final_review', round: 1 });
    const f = fakeRetro();
    const h = harness({ retro: f.retro });
    expect(await approveCommand('p', h.deps)).toBe(0);
    expect((await loadState(dir)).stage).toBe('done');
    expect(f.batches).toHaveLength(1);
    expect(JSON.stringify(f.batches[0])).toContain('Outcome: approved');
    expect(await retroJson(dir)).toMatchObject({ status: 'submitted', batchId: 'msgbatch_1' });
    expect(h.text()).toContain('Retro submitted; review lessons later with: anton lessons review');
  });

  it('abandon submits a retro with outcome abandoned', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'error', round: 1 });
    const f = fakeRetro();
    const h = harness({ retro: f.retro });
    expect(await abandonCommand('p', h.deps)).toBe(0);
    expect(f.batches).toHaveLength(1);
    expect(JSON.stringify(f.batches[0])).toContain('Outcome: abandoned');
    expect(await retroJson(dir)).toMatchObject({ status: 'submitted' });
  });

  it('spec approval does not run a retro', async () => {
    const { dir } = await project('p', { stage: 'plan' });
    const f = fakeRetro();
    expect(await approveCommand('p', harness({ retro: f.retro }).deps)).toBe(1);
    expect(f.batches).toHaveLength(0);
    await expect(readFile(join(dir, 'retro.json'), 'utf8')).rejects.toThrow();
  });

  it('no API key: skipped with reason, approve still succeeds', async () => {
    const { dir } = await project('p', { stage: 'awaiting_final_review', round: 1 });
    const h = harness();
    expect(await approveCommand('p', h.deps)).toBe(0);
    expect(await retroJson(dir)).toMatchObject({ status: 'skipped', reason: 'no ANTHROPIC_API_KEY' });
    expect(h.text()).toContain('retro skipped: no ANTHROPIC_API_KEY');
  });

  it('client throws: failed with reason, approve still succeeds', async () => {
    const { dir } = await project('p', { stage: 'awaiting_final_review', round: 1 });
    const h = harness({ retro: fakeRetro({ throws: true }).retro });
    expect(await approveCommand('p', h.deps)).toBe(0);
    expect((await loadState(dir)).stage).toBe('done');
    expect(await retroJson(dir)).toMatchObject({ status: 'failed', reason: 'network down' });
    expect(h.text()).toContain('retro failed: network down');
  });
});

describe('anton accept-risk', () => {
  const finding = { id: 'SEC-abc12345', severity: 'high', area: 'backend', file: 'a.ts', title: 'Weak hash', detail: 'd', source: 'review' };
  async function withResults(stage: JobState['stage']) {
    const p = await project('p', stage === 'paused' ? { stage, pausedFrom: 'verify', pauseReason: 'round_cap', round: 1 } : { stage });
    await mkdir(join(p.dir, 'evidence'), { recursive: true });
    await writeFile(join(p.dir, 'evidence', 'results.json'), JSON.stringify({ round: 1, results: [], runOk: true, security: { findings: [finding], unavailable: [] } }));
    return p;
  }

  it('accept-risk records reason; rejects unknown id; rejects blank reason; refuses at stage build', async () => {
    const { dir } = await withResults('paused');
    let h = harness();
    expect(await acceptRiskCommand('p', 'SEC-abc12345', { reason: 'internal only' }, h.deps)).toBe(0);
    expect(h.text()).toContain('Weak hash');
    expect(h.text()).toContain('accepted');
    expect((await loadAcceptedRisks(dir)).map((r) => [r.id, r.reason])).toEqual([['SEC-abc12345', 'internal only']]);
    expect((await loadState(dir)).stage).toBe('paused');

    h = harness();
    expect(await acceptRiskCommand('p', 'SEC-deadbeef', { reason: 'x' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('Unknown security finding SEC-deadbeef');
    h = harness();
    expect(await acceptRiskCommand('p', 'nope', { reason: 'x' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('Unknown security finding nope');

    h = harness();
    expect(await acceptRiskCommand('p', 'SEC-abc12345', { reason: '   ' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('--reason');

    await saveState(dir, { ...(await loadState(dir)), stage: 'build' });
    h = harness();
    expect(await acceptRiskCommand('p', 'SEC-abc12345', { reason: 'again' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('stage: build');
    expect((await loadAcceptedRisks(dir))[0]!.reason).toBe('internal only');
  });

  it('works at awaiting_final_review', async () => {
    await withResults('awaiting_final_review');
    const h = harness();
    expect(await acceptRiskCommand('p', 'SEC-abc12345', { reason: 'ok' }, h.deps)).toBe(0);
    expect(h.text()).toContain('Note: REPORT.md was written before this acceptance; it will show it after the next delivery.');
  });

  it('does not print the REPORT.md note when paused', async () => {
    await withResults('paused');
    const h = harness();
    expect(await acceptRiskCommand('p', 'SEC-abc12345', { reason: 'ok' }, h.deps)).toBe(0);
    expect(h.text()).not.toContain('REPORT.md was written');
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
    expect(await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.anton/');
    expect((await execa('git', ['ls-files'], { cwd: repo })).stdout).not.toContain('.anton');
    expect(h.text()).toContain(join(dir, 'spec.md'));
    expect(h.text()).toContain('anton approve a-habit-tracker');
    expect(h.text()).toMatch(/acceptance checks/i);
    expect(stopped).toEqual(['anton-a-habit-tracker']);
  });

  it('spec failure → exit 1 with an abandon hint, container stopped', async () => {
    const stopped: string[] = [];
    const h = harness({
      ensureImage: async () => 'img',
      startContainer: async (slug) => `anton-${slug}`,
      stopContainer: async (n) => { stopped.push(n); },
      runSpec: async () => { throw new Error('agent exploded'); },
    });
    expect(await newCommand('a habit tracker', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain(
      'Spec stage failed: agent exploded. Clean up with: anton abandon a-habit-tracker, then run anton new again.',
    );
    expect(stopped).toEqual(['anton-a-habit-tracker']);
  });

  it('Ctrl-C during the spec loop stops the container, prints the abandon hint, exits 130; handler removed after', async () => {
    const order: string[] = [];
    let handler: (() => Promise<void> | void) | undefined;
    const exit = vi.fn((code: number) => { order.push(`exit:${code}`); });
    const h = harness({
      ensureImage: async () => 'img',
      startContainer: async (slug) => `anton-${slug}`,
      stopContainer: async (n) => { order.push(`stop:${n}`); },
      onSigint: (fn) => { handler = fn; order.push('on'); return () => { handler = undefined; order.push('off'); }; },
      exit: exit as never,
      runSpec: async () => {
        expect(handler).toBeDefined();
        await handler!(); // simulated SIGINT while asking questions
        throw new Error('interrupted');
      },
    });
    await newCommand('a habit tracker', {}, h.deps);
    expect(order.slice(0, 3)).toEqual(['on', 'stop:anton-a-habit-tracker', 'exit:130']);
    expect(order).toContain('off');
    expect(handler).toBeUndefined();
    expect(h.errText()).toContain('anton abandon a-habit-tracker');
  });

  it('a normal spec run registers and removes the SIGINT handler without exiting', async () => {
    const spec: SpecDoc = {
      title: 'Habits', summary: 's', outOfScope: [], kit: 'fallback', tech: [],
      acceptanceChecks: [{ id: 'AC-1', text: 'tracks' }],
    };
    const exit = vi.fn();
    let registered = 0;
    let removed = 0;
    const h = harness({
      ensureImage: async () => 'img',
      startContainer: async (slug) => `anton-${slug}`,
      onSigint: () => { registered++; return () => { removed++; }; },
      exit: exit as never,
      runSpec: async (ctx) => ({ spec, state: ctx.state }),
    });
    expect(await newCommand('a habit tracker', {}, h.deps)).toBe(0);
    expect([registered, removed]).toEqual([1, 1]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric --budget with exit 1', async () => {
    const h = harness();
    expect(await newCommand('x', { budget: 'lots' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('--budget');
  });
});

describe('secrets', () => {
  it('secrets edit creates 0600 file and calls openEditor', async () => {
    const opened: string[] = [];
    const h = harness({ openEditor: async (p) => { opened.push(p); } });
    expect(await secretsEditCommand('app', h.deps)).toBe(0);
    const p = join(home, 'secrets', 'app.env');
    expect(opened).toEqual([p]);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, 'secrets'))).mode & 0o777).toBe(0o700);
    expect(await readFile(p, 'utf8')).toMatch(/^# /);
  });

  it('secrets edit rejects a traversal name', async () => {
    const h = harness({ openEditor: async () => { throw new Error('should not open'); } });
    expect(await secretsEditCommand('../x', h.deps)).toBe(1);
    expect(h.errText()).toContain('Project names may only use a-z, 0-9 and -');
  });

  it('spec over its share warns once and continues', async () => {
    const repo = join(home, 'r');
    await mkdir(repo, { recursive: true });
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const jobDir = jobDirOf(repo, '1-x');
    await mkdir(jobDir, { recursive: true });
    await saveState(jobDir, {
      jobId: '1-x', project: 'app', stage: 'spec', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
      warned80: false, completedTasks: [], updatedAt: '',
    });
    const spec: SpecDoc = { title: 'T', summary: 's', outOfScope: [], kit: 'fallback', tech: [], acceptanceChecks: [{ id: 'AC-1', text: 't' }] };
    const h = harness({
      startContainer: async () => 'c',
      // Three over-share warnings across turns of one session.
      runSpec: async (ctx) => { for (let i = 0; i < 3; i++) ctx.warn?.('Spec has used its 10% share ($1.00); continuing up to the job cap.'); return { spec, state: ctx.state }; },
      onSigint: () => () => undefined,
    });
    expect(await runSpecSession(resolveDeps(h.deps), { name: 'app', repoPath: repo, jobDir, description: 'd', image: 'img', jobId: '1-x' }, 'new')).toBe(0);
    expect(h.out.filter((l) => l.includes('Spec has used its 10% share ($1.00); continuing up to the job cap.'))).toHaveLength(1);
  });

  it('spec session prints secret names, never values; passes env file', async () => {
    const repo = join(home, 'r');
    await mkdir(repo, { recursive: true });
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await mkdir(join(home, 'secrets'), { recursive: true });
    await writeFile(join(home, 'secrets', 'app.env'), 'ALPHA=FAKE_VALUE_1\nBETA=not-a-secret\n', { mode: 0o600 });
    const jobDir = jobDirOf(repo, '1-x');
    await mkdir(jobDir, { recursive: true });
    await saveState(jobDir, {
      jobId: '1-x', project: 'app', stage: 'spec', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
      warned80: false, completedTasks: [], updatedAt: '',
    });
    const opts: unknown[] = [];
    const spec: SpecDoc = { title: 'T', summary: 's', outOfScope: [], kit: 'fallback', tech: [], acceptanceChecks: [{ id: 'AC-1', text: 't' }], services: [{ name: 'Stripe', envVars: ['ALPHA', 'STRIPE_KEY'] }] };
    const h = harness({
      startContainer: async (_s, _r, _i, o) => { opts.push(o); return 'c'; },
      runSpec: async (ctx) => ({ spec, state: ctx.state }) as never,
      onSigint: () => () => undefined,
    });
    expect(await runSpecSession(resolveDeps(h.deps), { name: 'app', repoPath: repo, jobDir, description: 'd', image: 'img', jobId: '1-x' }, 'new')).toBe(0);
    expect(h.text()).toContain('Secrets this job will receive: ALPHA, BETA');
    expect(h.text()).toContain('Service Stripe: missing from the secrets file: STRIPE_KEY');
    expect(h.text() + h.errText()).not.toMatch(/FAKE_VALUE_1|not-a-secret/);
    expect(opts).toEqual([{ envFile: join(home, 'secrets', 'app.env') }]);
  });
});

describe('secrets hardening', () => {
  it.each([0o644, 0o640])('spec session refuses a %o secrets file; startContainer never called', async (mode) => {
    await mkdir(join(home, 'secrets'), { recursive: true });
    const f = join(home, 'secrets', 'app.env');
    await writeFile(f, 'ALPHA=FAKE_VALUE_1\n');
    await chmod(f, mode);
    const startContainer = vi.fn(async () => 'c');
    const runSpec = vi.fn();
    const h = harness({ startContainer, runSpec, onSigint: () => () => undefined });
    await expect(
      runSpecSession(resolveDeps(h.deps), { name: 'app', repoPath: home, jobDir: home, description: 'd', image: 'img', jobId: '1-x' }, 'new'),
    ).rejects.toThrow(`Secrets file must be private: chmod 600 ${f}`);
    expect(startContainer).not.toHaveBeenCalled();
    expect(runSpec).not.toHaveBeenCalled();
  });

  it('secrets edit warns when tightening a loose existing file', async () => {
    await mkdir(join(home, 'secrets'), { recursive: true });
    const f = join(home, 'secrets', 'app.env');
    await writeFile(f, 'A=FAKE_VALUE_1\n');
    await chmod(f, 0o644);
    const h = harness({ openEditor: async () => undefined });
    expect(await secretsEditCommand('app', h.deps)).toBe(0);
    expect(h.errText()).toContain(`${f} was readable by others; tightened to 0600`);
    expect((await stat(f)).mode & 0o777).toBe(0o600);
  });

  it('defaultOpenEditor supports editors with args, and rejects on non-zero exit', async () => {
    const prev = process.env.EDITOR;
    try {
      process.env.EDITOR = 'test -n';
      await expect(defaultOpenEditor('/some path/x.env')).resolves.toBeUndefined();
      process.env.EDITOR = 'false';
      await expect(defaultOpenEditor('/x.env')).rejects.toThrow('Editor exited with code 1');
    } finally {
      if (prev === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = prev;
    }
  });
});

describe('adopt', () => {
  async function repo(name: string): Promise<string> {
    const dir = join(await mkdtemp(join(tmpdir(), 'anton-adopt-')), name);
    await mkdir(dir, { recursive: true });
    await execa('git', ['init', '-q'], { cwd: dir });
    return dir;
  }

  it('adopt registers and excludes .anton', async () => {
    const dir = await repo('My App');
    const h = harness();
    expect(await adoptCommand(dir, {}, h.deps)).toBe(0);
    const { repoPath } = await getProject('my-app');
    expect(repoPath).toBe(await realpath(dir));
    expect(await readFile(join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('.anton/');
    expect(h.text()).toContain('Start a change with: anton change my-app "<what to change>"');
  });
  it('not a repo → exit 1, nothing registered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anton-adopt-'));
    const h = harness();
    expect(await adoptCommand(dir, {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('is not the root of a git repository');
    expect(await listProjects()).toEqual([]);
  });
  it('subfolder of a repo → exit 1', async () => {
    const dir = await repo('top');
    await mkdir(join(dir, 'sub'));
    const h = harness();
    expect(await adoptCommand(join(dir, 'sub'), {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('is not the root of a git repository');
    expect(await listProjects()).toEqual([]);
  });
  it('explicit taken name → exit 1', async () => {
    await project('taken');
    const h = harness();
    expect(await adoptCommand(await repo('x'), { name: 'taken' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('A project named taken already exists');
  });
  it('non-slug --name → exit 1, nothing registered', async () => {
    const h = harness();
    expect(await adoptCommand(await repo('x'), { name: 'My App' }, h.deps)).toBe(1);
    expect(h.errText()).toContain('Project names may only use a-z, 0-9 and -');
    expect(await listProjects()).toEqual([]);
  });
  it('default name collision gets a suffix', async () => {
    await project('dup');
    const h = harness();
    expect(await adoptCommand(await repo('dup'), {}, h.deps)).toBe(0);
    expect((await getProject('dup-2')).name).toBe('dup-2');
  });
});

describe('anton change', () => {
  const spec: SpecDoc = {
    title: 'T', summary: 's', outOfScope: [], kit: 'fallback', tech: [],
    acceptanceChecks: [{ id: 'AC-1', text: 'keeps working' }],
  };
  async function adopted(dirty = false): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'anton-change-')));
    const git = (...a: string[]) => execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
    await git('init', '-q');
    await writeFile(join(dir, 'a.txt'), 'a');
    await git('add', '-A');
    await git('commit', '-qm', 'init');
    await registerProject('app', dir);
    if (dirty) await writeFile(join(dir, 'a.txt'), 'changed');
    return dir;
  }

  it('change runs spec in change mode on branch anton/2-x', async () => {
    const dir = await adopted();
    // an earlier finished job makes the next one number 2
    await mkdir(jobDirOf(dir, '1-old'), { recursive: true });
    await saveState(jobDirOf(dir, '1-old'), {
      jobId: '1-old', project: 'app', stage: 'done', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
      warned80: false, completedTasks: [], updatedAt: '',
    });
    const modes: unknown[] = [];
    const order: string[] = [];
    const stopped: string[] = [];
    const h = harness({
      ensureImage: async () => 'img',
      startContainer: async (slug) => { order.push('start'); return `anton-${slug}`; },
      stopContainer: async (n) => { stopped.push(n); },
      ensureRepoMap: async (ctx) => { order.push('map'); return ctx.state; },
      runSpec: async (ctx, _d, _a, _deps, mode) => { order.push('spec'); modes.push(mode); return { spec, state: ctx.state }; },
    });
    expect(await changeCommand('app', 'x', { budget: '5' }, h.deps)).toBe(0);
    expect(modes).toEqual(['change']);
    expect(order).toEqual(['start', 'map', 'spec']);
    const d = jobDirOf(dir, '2-x');
    expect(await loadState(d)).toMatchObject({ stage: 'awaiting_spec_approval', branch: 'anton/2-x', budgetUsd: 5 });
    expect((await execa('git', ['branch', '--show-current'], { cwd: dir })).stdout).toBe('anton/2-x');
    expect(h.text()).toContain(`Spec ready: ${join(d, 'spec.md')}. Edit the acceptance checks if you like, then run: anton approve app. Work happens on branch anton/2-x.`);
    expect(stopped).toEqual(['anton-app']);
  });

  it('change picks the kit from repo file names; the spec container stays on the fallback image', async () => {
    const dir = await adopted();
    const images: string[] = [];
    const listed: string[] = [];
    const h = harness({
      ensureImage: async () => 'fallback-img',
      startContainer: async (slug, _r, image) => { images.push(image); return `anton-${slug}`; },
      ensureRepoMap: async (ctx) => ctx.state,
      listFiles: async (r) => { listed.push(r); return ['package.json', 'next.config.js']; },
      runSpec: async (ctx) => ({ spec, state: ctx.state }),
    });
    expect(await changeCommand('app', 'add a flag', {}, h.deps)).toBe(0);
    expect(listed).toEqual([dir]);
    expect(images).toEqual(['fallback-img']);
    const d = jobDirOf(dir, '1-add-a-flag');
    expect(JSON.parse(await readFile(join(d, 'spec.json'), 'utf8')).kit).toBe('web');
    expect(await readFile(join(d, 'spec.md'), 'utf8')).toContain('\nKit: web\n');
    expect(h.text()).toContain('Kit: web');
  });

  it('change on dirty repo → exit 1 "Commit or stash your changes first", runSpec not called', async () => {
    await adopted(true);
    const runSpec = vi.fn();
    const h = harness({ ensureImage: async () => 'img', startContainer: async () => 'c', runSpec });
    expect(await changeCommand('app', 'x', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('Commit or stash your changes first');
    expect(runSpec).not.toHaveBeenCalled();
  });

  it('bad secrets file → exit 1 before any branch or job is created', async () => {
    const dir = await adopted();
    await mkdir(join(home, 'secrets'), { recursive: true });
    await writeFile(secretsPath('app'), 'K=FAKE_SECRET_VALUE_123\n');
    await chmod(secretsPath('app'), 0o644);
    const h = harness({ ensureImage: async () => 'img', startContainer: async () => 'c' });
    expect(await changeCommand('app', 'x', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('must be private');
    expect((await execa('git', ['branch', '--list', 'anton/*'], { cwd: dir })).stdout).toBe('');
    await expect(access(jobDirOf(dir, '1-x'))).rejects.toThrow();
  });

  it('change on an unknown project → exit 1', async () => {
    const h = harness({ ensureImage: async () => 'img' });
    expect(await changeCommand('nope', 'x', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('nope');
  });

  it('change spec failure → exit 1 with an anton change abandon hint', async () => {
    await adopted();
    const h = harness({
      ensureImage: async () => 'img', startContainer: async () => 'c',
      runSpec: async () => { throw new Error('boom'); },
    });
    expect(await changeCommand('app', 'x', {}, h.deps)).toBe(1);
    expect(h.errText()).toContain('then run anton change again');
  });
});
