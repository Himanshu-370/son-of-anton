import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { newCommand } from '../../src/cli/commands/new.js';
import { slugify } from '../../src/core/registry.js';

/**
 * Real-API test (costs up to ~$3). Needs Docker, ANTHROPIC_API_KEY and ANTON_E2E=1.
 * Builds a tiny static page through the web kit and checks REPORT.md shows the kit and a screenshot.
 */
const DESCRIPTION = 'a static web page that shows Hello';
const CLI = join(process.cwd(), 'dist', 'cli', 'index.js');
const TIMEOUT_MS = 20 * 60_000;

const anton = (...args: string[]) => execa(process.execPath, [CLI, ...args], { reject: false, env: process.env });
const exists = (p: string) => access(p).then(() => true, () => false);

let home: string | undefined;
let prevHome: string | undefined;
const project = slugify(DESCRIPTION);

describe.skipIf(!process.env.ANTON_E2E || !process.env.ANTHROPIC_API_KEY)('web job e2e', () => {
  beforeAll(async () => {
    await execa('npm', ['run', 'build'], { stdio: 'inherit' });
    await execa('npm', ['run', 'build:image'], { stdio: 'inherit' });
    prevHome = process.env.ANTON_HOME;
    home = await mkdtemp(join(tmpdir(), 'anton-e2e-home-'));
    process.env.ANTON_HOME = home;
  }, 600_000);

  afterAll(async () => {
    if (home) {
      await anton('stop', project);
      await anton('abandon', project);
      await rm(home, { recursive: true, force: true });
    }
    if (prevHome === undefined) delete process.env.ANTON_HOME;
    else process.env.ANTON_HOME = prevHome;
  }, 120_000);

  it('anton builds a static web page and reports the kit and a screenshot', async () => {
    const code = await newCommand(DESCRIPTION, { budget: '3' }, { ask: async (qs) => qs.map(() => 'use your judgement') });
    expect(code).toBe(0);

    const jobsDir = join(home!, 'projects', project, '.anton', 'jobs');
    const jobDir = join(jobsDir, (await readdir(jobsDir)).sort().at(-1)!);
    expect(await readFile(join(jobDir, 'spec.md'), 'utf8')).toMatch(/Kit:\s*web/);

    const approved = await anton('approve', project);
    expect(approved.exitCode, approved.stderr).toBe(0);

    const readState = async () => JSON.parse(await readFile(join(jobDir, 'state.json'), 'utf8'));
    const deadline = Date.now() + TIMEOUT_MS;
    let state = await readState();
    while (state.stage !== 'awaiting_final_review' && Date.now() < deadline) {
      if (state.stage === 'paused' || state.stage === 'abandoned') throw new Error(`Job stopped at ${state.stage} (${state.pauseReason ?? 'n/a'})`);
      await new Promise((r) => setTimeout(r, 5_000));
      state = await readState();
    }
    expect(state.stage).toBe('awaiting_final_review');

    const report = await readFile(join(jobDir, 'REPORT.md'), 'utf8');
    expect(report).toContain('Kit: web');
    expect(report).toContain('## Screenshots');
    const shot = report.match(/evidence\/screens\/[\w.-]+\.png/)?.[0];
    expect(shot).toBeTruthy();
    expect(await exists(join(jobDir, shot!))).toBe(true);
  }, TIMEOUT_MS + 300_000);
});
