import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { adoptCommand } from '../../src/cli/commands/adopt.js';
import { changeCommand } from '../../src/cli/commands/change.js';

/**
 * Real-API test (costs up to ~$3). Needs Docker, ANTHROPIC_API_KEY and ANTON_E2E=1.
 * Adopts a tiny repo, runs a change, approves, and waits for the final review.
 */
const CLI = join(process.cwd(), 'dist', 'cli', 'index.js');
const TIMEOUT_MS = 20 * 60_000;
const project = 'e2e-change-fixture';

const anton = (...args: string[]) => execa(process.execPath, [CLI, ...args], { reject: false, env: process.env });
const git = (cwd: string, ...args: string[]) => execa('git', args, { cwd });
const exists = (p: string) => access(p).then(() => true, () => false);

let home: string | undefined;
let prevHome: string | undefined;
let repo: string;

describe.skipIf(!process.env.ANTON_E2E || !process.env.ANTHROPIC_API_KEY)('change job e2e', () => {
  beforeAll(async () => {
    await execa('npm', ['run', 'build'], { stdio: 'inherit' });
    await execa('npm', ['run', 'build:image'], { stdio: 'inherit' });
    prevHome = process.env.ANTON_HOME;
    home = await mkdtemp(join(tmpdir(), 'anton-e2e-home-'));
    process.env.ANTON_HOME = home;
    repo = join(await mkdtemp(join(tmpdir(), 'anton-e2e-repo-')), project);
    await mkdir(repo, { recursive: true });
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 'e2e@example.com');
    await git(repo, 'config', 'user.name', 'e2e');
    await writeFile(join(repo, 'greet.py'), 'def greet(name):\n    return f"Hello, {name}"\n');
    await writeFile(join(repo, 'test_greet.py'), 'from greet import greet\n\n\ndef test_greet():\n    assert greet("a") == "Hello, a"\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'init');
  }, 600_000);

  afterAll(async () => {
    if (home) {
      await anton('stop', project);
      await anton('abandon', project); // also switches the repo back to main
      await rm(home, { recursive: true, force: true });
    }
    if (prevHome === undefined) delete process.env.ANTON_HOME;
    else process.env.ANTON_HOME = prevHome;
  }, 120_000);

  it('anton changes an adopted repo on its own branch', async () => {
    const mainBefore = (await git(repo, 'rev-parse', 'main')).stdout;
    expect(await adoptCommand(repo, { name: project })).toBe(0);
    const code = await changeCommand(project, 'add a shout(name) function that returns the greeting in upper case, with a test', { budget: '3' },
      { ask: async (qs) => qs.map(() => 'use your judgement') });
    expect(code).toBe(0);

    const jobsDir = join(repo, '.anton', 'jobs');
    const jobId = (await readdir(jobsDir)).sort().at(-1)!;
    const jobDir = join(jobsDir, jobId);

    const approved = await anton('approve', project);
    expect(approved.exitCode, approved.stderr).toBe(0);

    const readState = async () => JSON.parse(await readFile(join(jobDir, 'state.json'), 'utf8'));
    const deadline = Date.now() + TIMEOUT_MS;
    let state = await readState();
    while (state.stage !== 'awaiting_final_review' && Date.now() < deadline) {
      if (state.stage === 'paused' || state.stage === 'abandoned') {
        throw new Error(`Job stopped at ${state.stage} (${state.pauseReason ?? 'n/a'})`);
      }
      await new Promise((r) => setTimeout(r, 5_000));
      state = await readState();
    }
    if (state.stage !== 'awaiting_final_review') throw new Error(`Timed out waiting for awaiting_final_review (stage: ${state.stage})`);

    expect((await git(repo, 'branch', '--list', `anton/${jobId}`)).stdout).toContain(`anton/${jobId}`);
    expect((await git(repo, 'rev-parse', 'main')).stdout).toBe(mainBefore);
    const report = await readFile(join(jobDir, 'REPORT.md'), 'utf8');
    expect(report).toContain(`Branch to merge: anton/${jobId}`);
    expect(await exists(join(jobDir, 'evidence', 'baseline.json'))).toBe(true);
  }, TIMEOUT_MS + 300_000);
});
