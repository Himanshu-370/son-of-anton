import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { registerProject } from '../../src/core/registry.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import type { CliDeps } from '../../src/cli/deps.js';
import { approveCommand } from '../../src/cli/commands/approve.js';
import { rejectCommand } from '../../src/cli/commands/reject.js';
import { resumeCommand } from '../../src/cli/commands/resume.js';
import { SLACK_ROLES, type SlackConfig } from '../../src/slack/config.js';
import { attachCardMessage, dispatchSlackAction, registerActionCard, type DispatchDeps } from '../../src/slack/actions.js';

// Clearly fake Slack identifiers; no network and no credentials.
const roles = Object.fromEntries(SLACK_ROLES.map((role, i) => [role, { appId: `A0FAKE${i}`, botUserId: `U0BOT${i}` }]));
const config = { teamId: 'T0FAKE', ownerId: 'U0OWNER', channelId: 'C0ANTON', roles } as SlackConfig;
const CHANNEL = 'C0PROJP';
const MSG = '1700000000.000100';
const child = fileURLToPath(new URL('./fixtures/decide-child.ts', import.meta.url));

let home: string;
let spawned: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-concurrency-'));
  process.env.ANTON_HOME = home;
  spawned = [];
});

async function project(over: Partial<JobState> = {}): Promise<string> {
  const repo = join(home, 'projects', 'p');
  const dir = jobDirOf(repo, '1-init');
  await mkdir(dir, { recursive: true });
  await registerProject('p', repo);
  await saveState(dir, {
    jobId: '1-init', project: 'p', stage: 'awaiting_final_review', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
    warned80: false, completedTasks: [], updatedAt: '', ...over,
  });
  return dir;
}

const cli = (): CliDeps & { lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    out: (l) => lines.push(l), err: (l) => lines.push(l),
    preflight: async () => undefined,
    spawnRun: (name) => { spawned.push(name); },
    stopContainer: async () => undefined,
    retro: { env: {} },
  };
};

const slack = (): DispatchDeps => ({
  config, home,
  jobs: {
    preflight: async () => undefined,
    spawnRun: (name) => { spawned.push(name); },
    stopContainer: async () => undefined,
    retro: { env: {}, home },
    listTags: async () => ['anton/1-init/delivered-1'],
  },
  projectForChannel: async (c) => (c === CHANNEL ? 'p' : undefined),
});

async function slackCard(kind: 'approve' | 'reject'): Promise<string> {
  const token = await registerActionCard({
    kind, role: 'pm', channelId: CHANNEL,
    target: { project: 'p', jobId: '1-init', stage: 'awaiting_final_review', revision: 'delivered-1' },
  }, { config, home });
  await attachCardMessage(token, CHANNEL, MSG, { home });
  return token;
}

const owner = { teamId: 'T0FAKE', userId: 'U0OWNER', isBot: false };
const source = { appId: config.roles.pm.appId, role: 'pm' as const, channelId: CHANNEL, messageTs: MSG };

describe('simultaneous CLI and Slack decisions (same process)', () => {
  it('CLI approve and Slack reject: exactly one wins and the other is told nothing changed', async () => {
    const dir = await project();
    const token = await slackCard('reject');
    const c = cli();
    const [code, r] = await Promise.all([
      approveCommand('p', c),
      dispatchSlackAction({ via: 'card', key: 'card:race', actor: owner, source, token, input: { notes: 'fix it' } }, slack()),
    ]);
    const s = await loadState(dir);
    if (s.stage === 'done') {
      expect(code).toBe(0);
      expect(r.status).toBe('stale');
      expect(spawned).toEqual([]);
    } else {
      expect(s.stage).toBe('build');
      expect(s.rejects).toBe(1);
      expect(r.status).toBe('done');
      expect(code).toBe(1);
      expect(c.lines.join('\n')).toContain('Nothing to approve (stage: build)');
      expect(spawned).toEqual(['p']);
    }
  });

  it('CLI resume and Slack resume at once start one background run', async () => {
    const dir = await project({ stage: 'paused', pausedFrom: 'build', pauseReason: 'error' });
    const codes = await Promise.all([
      resumeCommand('p', {}, cli()),
      dispatchSlackAction({ via: 'command', key: 'cmd:race', actor: owner, source: { ...source, messageTs: undefined }, text: 'resume' }, slack()),
    ]);
    expect(spawned).toEqual(['p']);
    expect((await loadState(dir)).stage).toBe('build');
    expect(codes.filter((x) => x === 0 || (typeof x === 'object' && x.status === 'done'))).toHaveLength(1);
  });

  it('a Slack card after the CLI already decided is stale', async () => {
    const dir = await project();
    const token = await slackCard('approve');
    expect(await rejectCommand('p', { notes: 'no' }, cli())).toBe(0);
    const r = await dispatchSlackAction({ via: 'card', key: 'card:late', actor: owner, source, token }, slack());
    expect(r.status).toBe('stale');
    expect((await loadState(dir)).stage).toBe('build');
  });
});

describe('simultaneous decisions across processes', () => {
  it('two CLI processes and Slack race on one final review: one transition, no mixed effects', async () => {
    const dir = await project();
    const token = await slackCard('approve');
    const log = join(home, 'spawned.log');
    const env = { ...process.env, ANTON_HOME: home };
    const run = (action: string) => execa(process.execPath, ['--import', 'tsx', child, action, 'p', log], { env, reject: false });
    const [a, b, r] = await Promise.all([
      run('reject'),
      run('approve'),
      dispatchSlackAction({ via: 'card', key: 'card:x', actor: owner, source, token }, slack()),
    ]);
    const wins = [a.stdout.includes('EXIT 0'), b.stdout.includes('EXIT 0'), r.status === 'done'].filter(Boolean);
    expect(wins).toHaveLength(1);
    const s = await loadState(dir);
    const notes = (await readdir(dir)).filter((f) => f.startsWith('notes-round-'));
    if (s.stage === 'build') {
      expect(s.rejects).toBe(1);
      expect(notes).toHaveLength(1);
      expect((await readFile(log, 'utf8')).trim()).toBe('p');
    } else {
      expect(s.stage).toBe('done');
      expect(notes).toHaveLength(0);
    }
  }, 30_000);

  it('two CLI resumes in separate processes start one background run', async () => {
    const dir = await project({ stage: 'paused', pausedFrom: 'build', pauseReason: 'error' });
    const log = join(home, 'spawned.log');
    const env = { ...process.env, ANTON_HOME: home };
    const run = () => execa(process.execPath, ['--import', 'tsx', child, 'resume', 'p', log], { env, reject: false });
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.stdout, b.stdout].filter((o) => o.includes('EXIT 0'))).toHaveLength(1);
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['p']);
    expect((await loadState(dir)).stage).toBe('build');
  }, 30_000);
});
