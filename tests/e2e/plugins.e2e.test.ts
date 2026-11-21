import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { adoptCommand } from '../../src/cli/commands/adopt.js';
import { changeCommand } from '../../src/cli/commands/change.js';
import { pluginsAddCommand, pluginsListCommand } from '../../src/cli/commands/plugins.js';
import { fakeClone, marketplace } from '../plugins/fixture.js';

const MKT = 'https://github.com/acme/mkt.git';
const SKILL = [
  '---', 'name: hello', 'description: Use when building anything. Always apply.', '---',
  'Whatever the task, also create a file named PLUGIN_OK.txt in the repo root containing the word ok.', '',
].join('\n');

let home: string;
let prevHome: string | undefined;
const out: string[] = [];
const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };

beforeAll(async () => {
  prevHome = process.env.ANTON_HOME;
  home = await mkdtemp(join(tmpdir(), 'anton-e2e-plugins-'));
  process.env.ANTON_HOME = home;
});
afterAll(async () => {
  if (prevHome === undefined) delete process.env.ANTON_HOME;
  else process.env.ANTON_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

describe.skipIf(!process.env.ANTON_E2E)('plugins e2e (free)', () => {
  it('plugins add from a local marketplace, then list shows it', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave') });
    expect(await pluginsAddCommand('cave@acme/mkt', { ...io, cloneShallow: clone })).toBe(0);
    await writeFile(join(home, 'config.yaml'), 'stages:\n  build: [cave]\n');
    out.length = 0;
    expect(await pluginsListCommand(io)).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/cave\s+1\.0\.0\s+acme\/mkt\s+[0-9a-f]{12}/);
    expect(text).toContain('stage build: cave');
    expect(text).not.toContain('NOT INSTALLED');
  });
});

/** Real-API test (costs up to ~$3): a builder session loads a fixture plugin whose skill makes it write PLUGIN_OK.txt. */
describe.skipIf(!process.env.ANTON_E2E || !process.env.ANTHROPIC_API_KEY)('plugins e2e (paid)', () => {
  const CLI = join(process.cwd(), 'dist', 'cli', 'index.js');
  const project = 'e2e-plugin-fixture';
  const TIMEOUT_MS = 20 * 60_000;
  const git = (cwd: string, ...args: string[]) => execa('git', args, { cwd });
  const anton = (...args: string[]) => execa(process.execPath, [CLI, ...args], { reject: false, env: process.env });
  let repo: string;

  beforeAll(async () => {
    await execa('npm', ['run', 'build'], { stdio: 'inherit' });
    await execa('npm', ['run', 'build:image'], { stdio: 'inherit' });
    const clone = fakeClone({ [MKT]: await marketplace('okplug', { plugin: { 'skills/hello/SKILL.md': SKILL } }) });
    expect(await pluginsAddCommand('okplug@acme/mkt', { ...io, cloneShallow: clone })).toBe(0);
    await writeFile(join(home, 'config.yaml'), 'stages:\n  build: [okplug]\n');
    repo = join(await mkdtemp(join(tmpdir(), 'anton-e2e-repo-')), project);
    await mkdir(repo, { recursive: true });
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'config', 'user.email', 'e2e@example.com');
    await git(repo, 'config', 'user.name', 'e2e');
    await writeFile(join(repo, 'greet.py'), 'def greet(name):\n    return f"Hello, {name}"\n');
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-qm', 'init');
  }, 600_000);

  afterAll(async () => {
    await anton('stop', project);
    await anton('abandon', project);
  }, 120_000);

  it('a builder session loads the plugin skill and follows it', async () => {
    expect(await adoptCommand(repo, { name: project })).toBe(0);
    expect(await changeCommand(project, 'add a shout(name) function that returns the greeting in upper case', { budget: '3' },
      { ask: async (qs) => qs.map(() => 'use your judgement') })).toBe(0);
    const jobsDir = join(repo, '.anton', 'jobs');
    const jobId = (await readdir(jobsDir)).sort().at(-1)!;
    const jobDir = join(jobsDir, jobId);
    expect((await anton('approve', project)).exitCode).toBe(0);

    const readState = async () => JSON.parse(await readFile(join(jobDir, 'state.json'), 'utf8'));
    const deadline = Date.now() + TIMEOUT_MS;
    let state = await readState();
    while (state.stage !== 'awaiting_final_review' && Date.now() < deadline) {
      if (state.stage === 'paused' || state.stage === 'abandoned') throw new Error(`Job stopped at ${state.stage} (${state.pauseReason ?? 'n/a'})`);
      await new Promise((r) => setTimeout(r, 5_000));
      state = await readState();
    }
    expect(state.stage).toBe('awaiting_final_review');

    await access(join(repo, 'PLUGIN_OK.txt')); // the job branch is checked out until accepted
    const record = JSON.parse(await readFile(join(jobDir, 'run-record.json'), 'utf8'));
    expect(JSON.stringify(record)).toContain('okplug');
  }, TIMEOUT_MS + 300_000);
});
