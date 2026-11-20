import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StageCtx } from '../../src/agent/host-runner.js';
import { porcelainStatus, restorePaths } from '../../src/core/git.js';
import type { JobState } from '../../src/core/state.js';
import { KILL_ALL, STOP_APP } from '../../src/kits/web/browser.js';
import { webKit } from '../../src/kits/web/index.js';

const checks = [
  { id: 'AC-1', text: 'shows the list' },
  { id: 'AC-2', text: 'api returns json' },
];
const passXml = `<testsuite><testcase name="AC-1 ok"/><testcase name="AC-2 ok"/></testsuite>`;
const failXml = `<testsuite><testcase name="AC-1 ok"/><testcase name="AC-2 bad"><failure message="nope"/></testcase></testsuite>`;
const commands = { install: 'npm i', test: 'npm test', serve: 'npm run dev', url: 'http://localhost:5173' };

const st = (): JobState => ({
  jobId: 'j1', project: 'p', stage: 'verify', round: 1, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
  warned80: false, completedTasks: [], updatedAt: 'x',
});

function setup(opts: { xml?: string; ready?: boolean; alive?: boolean; repo?: string; jobDir?: string; tail?: string } = {}) {
  const repo = opts.repo ?? '/r';
  const jobDir = opts.jobDir ?? mkdtempSync(join(tmpdir(), 'web-job-'));
  const stage: StageCtx = { project: 'p', repo, container: 'c', jobDir, stage: 'verify', state: st() };
  const calls: string[] = [];
  const runIn = async (_c: string, cmd: string) => {
    calls.push(cmd);
    const ok = { exitCode: 0, stdout: '', stderr: '' };
    if (cmd.startsWith('cat ')) return { ...ok, stdout: opts.xml ?? passXml };
    if (cmd.startsWith('tail -n 40 ')) {
      if (opts.tail !== undefined) return { ...ok, stdout: opts.tail };
      const f = join(jobDir, 'evidence', 'app.log');
      return existsSync(f) ? { ...ok, stdout: readFileSync(f, 'utf8').trimEnd().split('\n').slice(-40).join('\n') } : { ...ok, exitCode: 1 };
    }
    if (cmd.startsWith('curl ')) return { ...ok, exitCode: opts.ready === false ? 7 : 0 };
    if (cmd.includes('/proc/')) return { ...ok, exitCode: opts.alive === false ? 1 : 0 }; // zombie-aware liveness check
    return ok;
  };
  const ctx = { container: 'c', jobDir, checks, commands, stage };
  return { ctx, calls, runIn, jobDir, stage };
}

type AgentOut = { checks: { id: string; status: 'pass' | 'fail' | 'n/a'; note: string }[] };
function agent(out: AgentOut | (() => Promise<AgentOut>), seen: unknown[] = []) {
  return async (c: StageCtx, req: unknown) => {
    seen.push(req);
    const output = typeof out === 'function' ? await out() : out;
    return { output, sessionId: 's', state: { ...c.state, spentUsd: c.state.spentUsd + 1 }, totalUsd: 1 };
  };
}
const noGit = { porcelainStatus: async () => new Map<string, string>(), restorePaths: async () => {}, sleep: async () => {} };
// The stop that counts is one sent after the app was started (startApp also stops a leftover app first).
const killed = (calls: string[]) => {
  const start = calls.findIndex((c) => c.includes('setsid '));
  return start >= 0 && calls.slice(start + 1).some((c) => c === STOP_APP);
};
const allPass: AgentOut = { checks: [{ id: 'AC-1', status: 'pass', note: 'ok' }, { id: 'AC-2', status: 'pass', note: 'ok' }] };

describe('webKit.verify', () => {
  it('failing tests skip the app and the browser agent', async () => {
    const s = setup({ xml: failXml });
    const seen: unknown[] = [];
    const out = await webKit.verify(s.ctx, { runIn: s.runIn, runAgent: agent(allPass, seen), ...noGit });
    expect(out.results.find((r) => r.id === 'AC-2')!.status).toBe('fail');
    expect(seen).toHaveLength(0);
    expect(s.calls.some((c) => c.includes('setsid'))).toBe(false);
    expect(out.results.every((r) => r.browser === undefined)).toBe(true);
  });

  it('app never ready → run_failed with app.log tail, no agent call, app killed', async () => {
    const s = setup({ ready: false });
    mkdirSync(join(s.jobDir, 'evidence'), { recursive: true });
    writeFileSync(join(s.jobDir, 'evidence', 'app.log'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n') + '\nError: port in use\n');
    const seen: unknown[] = [];
    const out = await webKit.verify(s.ctx, { runIn: s.runIn, runAgent: agent(allPass, seen), ...noGit });
    expect(seen).toHaveLength(0);
    expect(out.runOk).toBe(false);
    for (const r of out.results) {
      expect(r.status).toBe('fail');
      expect(r.reason).toBe('run_failed');
      expect(r.error).toContain('Error: port in use');
      expect(r.error).not.toContain('line 5\n');
    }
    expect(out.failureReport).toContain('### App did not start');
    expect(s.calls.filter((c) => c.startsWith('curl ')).length).toBe(60);
    expect(s.calls.some((c) => c.includes(`setsid sh -c 'npm run dev'`))).toBe(true);
    expect(killed(s.calls)).toBe(true);
  });

  it('serve that exits at once stops polling early and fails every check', async () => {
    const s = setup({ ready: false, alive: false });
    const out = await webKit.verify(s.ctx, { runIn: s.runIn, runAgent: agent(allPass), ...noGit });
    expect(s.calls.filter((c) => c.startsWith('curl ')).length).toBe(1);
    expect(out.results.every((r) => r.reason === 'run_failed')).toBe(true);
    expect(killed(s.calls)).toBe(true);
  });

  it('browser fail turns a passing check into fail with note', async () => {
    const s = setup();
    const seen: Record<string, unknown>[] = [];
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent({ checks: [{ id: 'AC-1', status: 'fail', note: 'button missing' }, { id: 'AC-2', status: 'pass', note: 'ok' }] }, seen),
      ...noGit,
    });
    const ac1 = out.results.find((r) => r.id === 'AC-1')!;
    expect(ac1.status).toBe('fail');
    expect(ac1.browser).toMatchObject({ status: 'fail', note: 'button missing' });
    expect(out.results.find((r) => r.id === 'AC-2')!.status).toBe('pass');
    expect(out.failureReport).toContain('### AC-1: browser');
    expect(out.failureReport).toContain('button missing');
    expect(out.runOk).toBe(true);
    expect(out.state?.spentUsd).toBe(1);
    const req = seen[0]!;
    expect(req).toMatchObject({ role: 'browser_tester', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 60, tools: ['Bash', 'Read', 'Glob', 'Grep'] });
    expect(req.prompt).toContain('http://localhost:5173');
    expect(req.prompt).toContain(`/workspace/.anton/jobs/${s.jobDir.split('/').pop()}/evidence/screens`);
    expect((req.outputSchema as { type: string }).type).toBe('object');
    expect(killed(s.calls)).toBe(true);
  });

  it('n/a leaves the check passing', async () => {
    const s = setup();
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent({ checks: [{ id: 'AC-1', status: 'pass', note: 'ok' }, { id: 'AC-2', status: 'n/a', note: 'no UI' }] }),
      ...noGit,
    });
    expect(out.results.every((r) => r.status === 'pass')).toBe(true);
    expect(out.results.find((r) => r.id === 'AC-2')!.browser).toEqual({ status: 'n/a', note: 'no UI' });
    expect(out.failureReport).toBe('');
  });

  it('check missing from agent output fails as not exercised; unknown ids are ignored', async () => {
    const s = setup();
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent({ checks: [{ id: 'AC-1', status: 'pass', note: 'ok' }, { id: 'AC-9', status: 'fail', note: 'bogus' }] }),
      ...noGit,
    });
    const ac2 = out.results.find((r) => r.id === 'AC-2')!;
    expect(ac2.status).toBe('fail');
    expect(ac2.browser).toMatchObject({ status: 'fail', note: 'not exercised' });
    expect(out.results.find((r) => r.id === 'AC-1')!.status).toBe('pass');
    expect(out.results.map((r) => r.id)).toEqual(['AC-1', 'AC-2']);
    expect(out.failureReport).not.toContain('AC-9');
  });

  it('agent changing a repo file is restored and fails all checks', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'web-repo-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
    g('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'original\n');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    const jobDir = join(repo, '.anton', 'jobs', 'j1');
    mkdirSync(jobDir, { recursive: true });
    const s = setup({ repo, jobDir });
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(async () => {
        writeFileSync(join(repo, 'a.txt'), 'hacked\n');
        writeFileSync(join(repo, 'b.txt'), 'new\n');
        writeFileSync(join(jobDir, 'evidence', 'screens', 'AC-1.png'), 'png');
        return allPass;
      }),
      sleep: async () => {},
    });
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(repo, 'b.txt'))).toBe(false);
    expect(existsSync(join(jobDir, 'evidence', 'screens', 'AC-1.png'))).toBe(true);
    for (const r of out.results) {
      expect(r.status).toBe('fail');
      expect(r.browser?.status).toBe('fail');
      expect(r.browser?.note).toBe('The browser session (agent or app) changed project files: a.txt, b.txt. If the app writes these at runtime, add them to .gitignore.');
    }
    expect((await porcelainStatus(repo)).size).toBe(0);
  });

  it('a file hidden by a new ignore rule is removed, not left for the next commit', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'web-repo-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
    g('init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repo, 'a.txt'), 'original\n');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    const jobDir = join(repo, '.anton', 'jobs', 'j1');
    mkdirSync(jobDir, { recursive: true });
    const s = setup({ repo, jobDir });
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(async () => {
        writeFileSync(join(repo, 'evil.js'), 'bad()\n');
        writeFileSync(join(repo, '.gitignore'), 'node_modules/\nevil.js\n');
        return allPass;
      }),
      sleep: async () => {},
    });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('node_modules/\n');
    expect(existsSync(join(repo, 'evil.js'))).toBe(false);
    expect((await porcelainStatus(repo)).size).toBe(0);
    for (const r of out.results) expect(r.browser?.note).toContain('.gitignore, evil.js');
  });

  it('a rewritten .gitignore never deletes formerly ignored files', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'web-repo-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
    g('init', '-q');
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    writeFileSync(join(repo, '.env'), 'FAKE_LOCAL=not-a-real-value\n');
    mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'x', 'index.js'), 'x\n');
    const jobDir = join(repo, '.anton', 'jobs', 'j1');
    mkdirSync(jobDir, { recursive: true });
    const s = setup({ repo, jobDir });
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(async () => {
        writeFileSync(join(repo, '.gitignore'), '');
        return allPass;
      }),
      sleep: async () => {},
    });
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe('.env\nnode_modules/\n');
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('FAKE_LOCAL=not-a-real-value\n');
    expect(existsSync(join(repo, 'node_modules', 'x', 'index.js'))).toBe(true);
    expect(out.results.every((r) => r.status === 'fail')).toBe(true);
  });

  it('unsettled restore throws so the job pauses', async () => {
    const s = setup();
    let n = 0;
    await expect(webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(allPass),
      porcelainStatus: async () => (n++ === 0 ? new Map() : new Map([['w.txt', `?? ${n}`]])),
      restorePaths: async () => {},
      sleep: async () => {},
    })).rejects.toThrow('Browser session left project files changing: w.txt. Check them, then run anton resume.');
  });

  it('changed-files note lists at most 20 paths', async () => {
    const s = setup();
    const names = Array.from({ length: 25 }, (_, i) => `f${String(i).padStart(2, '0')}.txt`);
    let n = 0;
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(allPass),
      porcelainStatus: async () => (n++ === 0 ? new Map() : n === 2 ? new Map(names.map((f) => [f, '?? x'])) : new Map()),
      restorePaths: async () => {},
      ignoredPaths: async () => new Set<string>(),
      sleep: async () => {},
    });
    const note = out.results[0]!.browser!.note;
    expect(note).toContain('f19.txt, and 5 more.');
    expect(note).not.toContain('f20.txt');
  });

  it('note leaves out paths that are ignored after the restore', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'web-repo-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
    g('init', '-q');
    writeFileSync(join(repo, '.gitignore'), 'cache/\n');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    mkdirSync(join(repo, 'cache'));
    writeFileSync(join(repo, 'cache', 'x.js'), 'x\n');
    const jobDir = join(repo, '.anton', 'jobs', 'j1');
    mkdirSync(jobDir, { recursive: true });
    const s = setup({ repo, jobDir });
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(async () => {
        writeFileSync(join(repo, '.gitignore'), '');
        return allPass;
      }),
      sleep: async () => {},
    });
    expect(out.results[0]!.browser!.note).toBe('The browser session (agent or app) changed project files: .gitignore. If the app writes these at runtime, add them to .gitignore.');
  });

  it('an edit to an already-dirty file is caught and reported', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'web-repo-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: repo });
    g('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'original\n');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    writeFileSync(join(repo, 'a.txt'), 'builder edit\n');
    writeFileSync(join(repo, 'u.txt'), 'untracked v1\n');
    const jobDir = join(repo, '.anton', 'jobs', 'j1');
    mkdirSync(jobDir, { recursive: true });
    const s = setup({ repo, jobDir });
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(async () => {
        writeFileSync(join(repo, 'a.txt'), 'agent edit\n');
        writeFileSync(join(repo, 'u.txt'), 'untracked v2\n');
        return allPass;
      }),
      sleep: async () => {},
    });
    for (const r of out.results) expect(r.browser?.note).toBe('The browser session (agent or app) changed project files: a.txt, u.txt. If the app writes these at runtime, add them to .gitignore.');
    // Reverted to HEAD (the pre-agent builder edit cannot be told apart, so it goes too).
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(repo, 'u.txt'))).toBe(false);
  });

  it('app.log tail comes from the container; a symlinked log is never read on the host', async () => {
    const s = setup({ ready: false, alive: false, tail: 'container says hi' });
    const hostFile = join(mkdtempSync(join(tmpdir(), 'host-')), 'private.txt');
    writeFileSync(hostFile, 'HOST-ONLY-CONTENT\n');
    mkdirSync(join(s.jobDir, 'evidence'), { recursive: true });
    symlinkSync(hostFile, join(s.jobDir, 'evidence', 'app.log'));
    const out = await webKit.verify(s.ctx, { runIn: s.runIn, runAgent: agent(allPass), ...noGit });
    expect(out.results[0]!.error).toContain('container says hi');
    expect(out.failureReport).not.toContain('HOST-ONLY-CONTENT');
    expect(out.results.every((r) => !r.error?.includes('HOST-ONLY-CONTENT'))).toBe(true);
    expect(readFileSync(hostFile, 'utf8')).toBe('HOST-ONLY-CONTENT\n');
    expect(s.calls.some((c) => c.startsWith('curl -fsS --max-time 5 '))).toBe(true);
  });

  it('app process is killed even when the agent throws', async () => {
    const s = setup();
    const restored: string[][] = [];
    await expect(webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(async () => { throw new Error('agent crashed'); }),
      ...noGit,
      restorePaths: async (_r, p) => { restored.push(p); },
    })).rejects.toThrow('agent crashed');
    expect(killed(s.calls)).toBe(true);
  });

  it('a symlinked screens dir is refused before rm/mkdir; its target is untouched', async () => {
    const s = setup();
    const target = mkdtempSync(join(tmpdir(), 'host-'));
    writeFileSync(join(target, 'keep.txt'), 'host\n');
    mkdirSync(join(s.jobDir, 'evidence'), { recursive: true });
    symlinkSync(target, join(s.jobDir, 'evidence', 'screens'));
    await expect(webKit.verify(s.ctx, { runIn: s.runIn, runAgent: agent(allPass), ...noGit })).rejects.toThrow(/symlink/);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('host\n');
  });

  it('a symlinked screenshot is not recorded (only regular files count)', async () => {
    const s = setup();
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(async () => {
        symlinkSync('/etc/hosts', join(s.jobDir, 'evidence', 'screens', 'AC-1.png'));
        return allPass;
      }),
      ...noGit,
    });
    expect(out.results.find((r) => r.id === 'AC-1')!.browser?.screenshot).toBeUndefined();
  });

  it('every container process is killed before the after-snapshot', async () => {
    const s = setup();
    await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(allPass),
      ...noGit,
      porcelainStatus: async () => { s.calls.push('<status>'); return new Map(); },
    });
    const statuses = s.calls.flatMap((c, i) => (c === '<status>' ? [i] : []));
    const kill = s.calls.indexOf(KILL_ALL);
    expect(statuses.length).toBe(2);
    expect(kill).toBeGreaterThan(statuses[0]!);
    expect(kill).toBeLessThan(statuses[1]!);
    expect(killed(s.calls)).toBe(true); // the outer stop stays for error paths
  });

  it('screenshot path recorded only when the file exists', async () => {
    const s = setup();
    const out = await webKit.verify(s.ctx, {
      runIn: s.runIn,
      runAgent: agent(async () => {
        writeFileSync(join(s.jobDir, 'evidence', 'screens', 'AC-1.png'), 'png');
        return allPass;
      }),
      ...noGit,
    });
    expect(out.results.find((r) => r.id === 'AC-1')!.browser?.screenshot).toBe(join(s.jobDir, 'evidence', 'screens', 'AC-1.png'));
    expect(out.results.find((r) => r.id === 'AC-2')!.browser?.screenshot).toBeUndefined();
  });
});

describe('restorePaths', () => {
  it('refuses paths outside the repo and under .anton/', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'web-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    await expect(restorePaths(repo, ['../x'])).rejects.toThrow(/refusing/);
    await expect(restorePaths(repo, ['/etc/passwd'])).rejects.toThrow(/refusing/);
    await expect(restorePaths(repo, ['.anton/jobs/j1/state.json'])).rejects.toThrow(/refusing/);
    await expect(restorePaths(repo, ['.git/config'])).rejects.toThrow(/refusing/);
  });
});
