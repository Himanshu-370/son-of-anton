import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { newCommand } from '../../src/cli/commands/new.js';
import { slugify } from '../../src/core/registry.js';

/**
 * Real-API smoke test (costs up to ~$3). Needs Docker, ANTHROPIC_API_KEY and ANTON_E2E=1.
 * `new` runs in-process so the interactive `ask` can be injected; approve/abandon use the built CLI.
 */
const DESCRIPTION = 'a python CLI that prints the sum of numbers given as arguments';
const CLI = join(process.cwd(), 'dist', 'cli', 'index.js');
const TIMEOUT_MS = 20 * 60_000;

const anton = (...args: string[]) => execa(process.execPath, [CLI, ...args], { reject: false, env: process.env });
const exists = (p: string) => access(p).then(() => true, () => false);

let home: string | undefined;
let prevHome: string | undefined;
const project = slugify(DESCRIPTION);

describe.skipIf(!process.env.ANTON_E2E || !process.env.ANTHROPIC_API_KEY)('new project e2e', () => {
  beforeAll(async () => {
    await execa('npm', ['run', 'build'], { stdio: 'inherit' });
    await execa('npm', ['run', 'build:image'], { stdio: 'inherit' });
    if (!(await exists(CLI))) throw new Error(`Built CLI missing at ${CLI}; run npm run build`);
    prevHome = process.env.ANTON_HOME;
    home = await mkdtemp(join(tmpdir(), 'anton-e2e-home-'));
    process.env.ANTON_HOME = home;
  }, 600_000);

  afterAll(async () => {
    if (home) {
      await anton('abandon', project); // stops the container; harmless if already done
      await rm(home, { recursive: true, force: true });
    }
    if (prevHome === undefined) delete process.env.ANTON_HOME;
    else process.env.ANTON_HOME = prevHome;
  }, 120_000);

  it('anton builds a tiny python CLI end-to-end', async () => {
    const code = await newCommand(DESCRIPTION, { budget: '3' }, { ask: async (qs) => qs.map(() => 'use your judgement') });
    expect(code).toBe(0);

    const repo = join(home!, 'projects', project);
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
    expect(state.stage).toBe('awaiting_final_review');
    expect(state.spentUsd).toBeLessThanOrEqual(3);

    expect(await exists(join(jobDir, 'REPORT.md'))).toBe(true);
    const evidence = JSON.parse(await readFile(join(jobDir, 'evidence', 'results.json'), 'utf8'));
    expect(evidence.results.length).toBeGreaterThan(0);
    for (const r of evidence.results) expect(r.status).toBe('pass');

    const plan = JSON.parse(await readFile(join(jobDir, 'plan.json'), 'utf8'));
    const log = await execa('git', ['log', '--format=%s'], { cwd: repo });
    const taskCommits = log.stdout.split('\n').filter((s) => /^T\d+: /.test(s));
    expect(taskCommits.length).toBeGreaterThanOrEqual(plan.tasks.length);
  }, TIMEOUT_MS + 300_000);
});
