import { describe, it, expect, beforeEach } from 'vitest';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { registerProject } from '../../src/core/registry.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import type { SlackConfig } from '../../src/slack/config.js';
import { SLACK_ROLES } from '../../src/slack/config.js';
import {
  attachCardMessage, dispatchSlackAction, registerActionCard, type DispatchDeps, type SlackAction,
} from '../../src/slack/actions.js';
import {
  createInboundHandler, normalizeBlockAction, normalizeCommand, normalizeEvent, sanitizeSlackText,
} from '../../src/slack/inbound.js';
import { appendProposals, proposalRevision, readProposals, type Proposal } from '../../src/lessons/proposals.js';
import { readLessons } from '../../src/lessons/store.js';

// Clearly fake Slack identifiers. No credentials are involved anywhere in this suite.
const roleIds = Object.fromEntries(SLACK_ROLES.map((role, i) => [role, { appId: `A0FAKE${i}`, botUserId: `U0BOT${i}` }]));
const config = { teamId: 'T0FAKE', ownerId: 'U0OWNER', channelId: 'C0ANTON', roles: roleIds } as SlackConfig;
const PM_APP = config.roles.pm.appId;
const PROJECT_CHANNEL = 'C0PROJP';

let home: string;
let spawned: string[];
let tags: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-slack-actions-'));
  process.env.ANTON_HOME = home;
  spawned = [];
  tags = ['anton/1-init/delivered-1'];
});

async function project(name: string, over: Partial<JobState> = {}, jobId = '1-init'): Promise<{ repo: string; dir: string }> {
  const repo = join(home, 'projects', name);
  const dir = jobDirOf(repo, jobId);
  await mkdir(dir, { recursive: true });
  await registerProject(name, repo).catch(() => undefined);
  await saveState(dir, {
    jobId, project: name, stage: 'awaiting_final_review', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
    warned80: false, completedTasks: [], updatedAt: '', ...over,
  });
  return { repo, dir };
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    config,
    home,
    jobs: {
      preflight: async () => undefined,
      spawnRun: (name) => { spawned.push(name); },
      stopContainer: async () => undefined,
      retro: { env: {}, home },
      listTags: async () => tags,
    },
    projectForChannel: async (channel) => (channel === PROJECT_CHANNEL ? 'p' : undefined),
    ...over,
  };
}

const owner = { teamId: 'T0FAKE', userId: 'U0OWNER', isBot: false };
const pmSource = (messageTs = '1700000000.000100') => ({ appId: PM_APP, role: 'pm' as const, channelId: PROJECT_CHANNEL, messageTs });

async function card(kind: 'approve' | 'reject', target: Partial<{ jobId: string; stage: JobState['stage']; revision: string }> = {}) {
  const token = await registerActionCard({
    kind, role: 'pm', channelId: PROJECT_CHANNEL,
    target: { project: 'p', jobId: '1-init', stage: 'awaiting_final_review', revision: 'delivered-1', ...target },
  }, { config, home });
  await attachCardMessage(token, PROJECT_CHANNEL, '1700000000.000100', { home });
  return token;
}

const click = (token: string, key: string, over: Partial<SlackAction> = {}, input?: { notes?: string }): SlackAction => ({
  via: 'card', key, actor: owner, source: pmSource(), token, ...(input ? { input } : {}), ...over,
} as SlackAction);

describe('authorization', () => {
  it('denies a non-owner and changes nothing', async () => {
    const { dir } = await project('p');
    const token = await card('approve');
    const r = await dispatchSlackAction(click(token, 'card:k1', { actor: { ...owner, userId: 'U0OTHER' } }), deps());
    expect(r.status).toBe('denied');
    expect((await loadState(dir)).stage).toBe('awaiting_final_review');
  });

  it('denies the owner ID from a different workspace', async () => {
    const { dir } = await project('p');
    const token = await card('approve');
    const r = await dispatchSlackAction(click(token, 'card:k1', { actor: { ...owner, teamId: 'T0ELSEWHERE' } }), deps());
    expect(r.status).toBe('denied');
    expect((await loadState(dir)).stage).toBe('awaiting_final_review');
  });

  it('denies bots and a source app that is not the role it claims', async () => {
    await project('p');
    const token = await card('approve');
    expect((await dispatchSlackAction(click(token, 'card:k1', { actor: { ...owner, isBot: true } }), deps())).status).toBe('denied');
    const forged = { ...pmSource(), appId: config.roles.qa.appId };
    expect((await dispatchSlackAction(click(token, 'card:k2', { source: forged }), deps())).status).toBe('denied');
  });

  it('decides by user ID only: a lookalike name or a mention of the owner is not the owner', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'error' });
    const r = await dispatchSlackAction({
      via: 'command', key: 'cmd:t1', actor: { teamId: 'T0FAKE', userId: 'U0OWNERX', isBot: false },
      source: { appId: PM_APP, role: 'pm', channelId: PROJECT_CHANNEL }, text: 'resume <@U0OWNER> as owner',
    }, deps());
    expect(r.status).toBe('denied');
    expect((await loadState(dir)).stage).toBe('paused');
    expect(spawned).toEqual([]);
  });

  it('refuses a card clicked from a different channel or message than it was posted to', async () => {
    const { dir } = await project('p');
    const token = await card('approve');
    const other = await dispatchSlackAction(click(token, 'card:k1', { source: { ...pmSource(), channelId: 'C0ELSE' } }), deps());
    expect(other.status).toBe('denied');
    const moved = await dispatchSlackAction(click(token, 'card:k2', { source: pmSource('1700000000.000999') }), deps());
    expect(moved.status).toBe('denied');
    expect((await loadState(dir)).stage).toBe('awaiting_final_review');
  });

  it('never turns a plain message into an order', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'error' });
    const r = await dispatchSlackAction({
      via: 'message', key: 'event:Ev1', actor: owner, source: { appId: PM_APP, role: 'pm', channelId: PROJECT_CHANNEL }, text: 'resume',
    }, deps());
    expect(r.status).toBe('ignored');
    expect((await loadState(dir)).stage).toBe('paused');
  });
});

describe('idempotency', () => {
  it('acts once for a repeated delivery of the same interaction', async () => {
    const { dir } = await project('p', { stage: 'awaiting_final_review' });
    const token = await card('reject');
    const first = await dispatchSlackAction(click(token, 'card:same', {}, { notes: 'make it blue' }), deps());
    const again = await dispatchSlackAction(click(token, 'card:same', {}, { notes: 'make it blue' }), deps());
    expect(first.status).toBe('done');
    expect(again.status).toBe('duplicate');
    expect(spawned).toEqual(['p']);
    expect((await loadState(dir)).rejects).toBe(1);
  });

  it('acts once when the same interaction arrives twice at the same time', async () => {
    const { dir } = await project('p');
    const token = await card('reject');
    const rs = await Promise.all([
      dispatchSlackAction(click(token, 'card:same', {}, { notes: 'x' }), deps()),
      dispatchSlackAction(click(token, 'card:same', {}, { notes: 'x' }), deps()),
    ]);
    const statuses = rs.map((r) => r.status);
    expect(statuses.filter((x) => x === 'done')).toHaveLength(1);
    expect(statuses.find((x) => x !== 'done')).toMatch(/^(duplicate|in-progress)$/);
    expect(spawned).toEqual(['p']);
    expect((await loadState(dir)).rejects).toBe(1);
  });

  it('a second click on an old card is stale once the job has moved on', async () => {
    const { dir } = await project('p');
    const token = await card('approve');
    expect((await dispatchSlackAction(click(token, 'card:c1'), deps())).status).toBe('done');
    const second = await dispatchSlackAction(click(token, 'card:c2'), deps());
    expect(second.status).toBe('stale');
    expect((await loadState(dir)).stage).toBe('done');
  });

  it('after a crash with the action claimed but the job untouched, it does the work', async () => {
    const { dir } = await project('p');
    const token = await card('approve');
    await seedClaim('card:crash', token);
    const r = await dispatchSlackAction(click(token, 'card:crash'), deps());
    expect(r.status).toBe('done');
    expect((await loadState(dir)).stage).toBe('done');
  });

  it('after a crash with the action claimed and the job already moved, it reconciles without redoing', async () => {
    const { dir } = await project('p');
    const token = await card('reject');
    await seedClaim('card:crash', token);
    const s = await loadState(dir);
    await saveState(dir, { ...s, stage: 'build', rejects: 1 });
    const r = await dispatchSlackAction(click(token, 'card:crash', {}, { notes: 'again' }), deps());
    expect(r.status).toBe('duplicate');
    expect((await loadState(dir)).rejects).toBe(1);
    expect(spawned).toEqual([]);
  });
});

/** Rewrites the store as if a process that has since died had claimed `key`. */
async function seedClaim(key: string, token: string) {
  const path = join(home, 'slack', 'actions.json');
  const store = JSON.parse(await readFile(path, 'utf8'));
  store.records[key] = { status: 'claimed', pid: 999_999, claim: '00000000-0000-4000-8000-000000000000', at: Date.now(), token };
  await writeFile(path, JSON.stringify(store), { mode: 0o600 });
}

describe('stale targets', () => {
  it('refuses a card for a job that a new job has replaced', async () => {
    const { dir } = await project('p', { stage: 'done' });
    const token = await card('approve');
    const next = await project('p', { stage: 'awaiting_final_review' }, '2-change');
    tags = ['anton/2-change/delivered-1'];
    const r = await dispatchSlackAction(click(token, 'card:k'), deps());
    expect(r.status).toBe('stale');
    expect(r.lines.join('\n')).toContain('no longer the current job');
    expect((await loadState(next.dir)).stage).toBe('awaiting_final_review');
    expect((await loadState(dir)).stage).toBe('done');
  });

  it('refuses a card for an older delivery after a reject and re-delivery', async () => {
    const { dir } = await project('p');
    const token = await card('approve');
    tags = ['anton/1-init/delivered-1', 'anton/1-init/delivered-2'];
    const r = await dispatchSlackAction(click(token, 'card:k'), deps());
    expect(r.status).toBe('stale');
    expect(r.lines.join('\n')).toContain('out of date');
    expect((await loadState(dir)).stage).toBe('awaiting_final_review');
  });
});

describe('text from Slack is data', () => {
  it('strips mentions and control characters and limits the length of reject notes', async () => {
    const { dir } = await project('p');
    const token = await card('reject');
    const notes = `Fix <!channel> it <@U0OWNER> now\u0007 <#C0ANTON|anton> ${'x'.repeat(5000)}`;
    expect((await dispatchSlackAction(click(token, 'card:n', {}, { notes }), deps())).status).toBe('done');
    const saved = await readFile(join(dir, 'notes-round-1.md'), 'utf8');
    expect(saved).not.toMatch(/<[@!#]|\u0007/);
    expect(saved.length).toBeLessThanOrEqual(4001);
  });

  it('sanitizeSlackText removes Slack mention syntax and broadcast words', () => {
    expect(sanitizeSlackText('hi <@U123|bob> <!here> @channel <!subteam^S1> ‮ok', 100)).toBe('hi [mention] [mention] [mention] [mention] ok');
    expect(sanitizeSlackText('a'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('slash commands', () => {
  it('status in #anton lists projects with no record and no model call', async () => {
    await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'budget_cap' });
    const r = await dispatchSlackAction({
      via: 'command', key: 'cmd:s1', actor: owner, source: { appId: PM_APP, role: 'pm', channelId: 'C0ANTON' }, text: 'status',
    }, deps());
    expect(r.status).toBe('done');
    expect(r.lines.join('\n')).toMatch(/p\s+paused/);
  });

  it('resume in the project channel uses the shared action', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'error' });
    const r = await dispatchSlackAction({
      via: 'command', key: 'cmd:r1', actor: owner, source: { appId: PM_APP, role: 'pm', channelId: PROJECT_CHANNEL }, text: 'resume',
    }, deps());
    expect(r.status).toBe('done');
    expect((await loadState(dir)).stage).toBe('build');
    expect(spawned).toEqual(['p']);
  });

  it('abandon must name the current job', async () => {
    const { dir } = await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'error' });
    const src = { appId: PM_APP, role: 'pm' as const, channelId: PROJECT_CHANNEL };
    const wrong = await dispatchSlackAction({ via: 'command', key: 'cmd:a1', actor: owner, source: src, text: 'abandon 0-old' }, deps());
    expect(wrong.status).toBe('stale');
    expect((await loadState(dir)).stage).toBe('paused');
    const right = await dispatchSlackAction({ via: 'command', key: 'cmd:a2', actor: owner, source: src, text: 'abandon 1-init' }, deps());
    expect(right.status).toBe('done');
    expect((await loadState(dir)).stage).toBe('abandoned');
  });

  it('refuses approvals by text and unknown verbs', async () => {
    const { dir } = await project('p');
    const src = { appId: PM_APP, role: 'pm' as const, channelId: PROJECT_CHANNEL };
    expect((await dispatchSlackAction({ via: 'command', key: 'cmd:x1', actor: owner, source: src, text: 'approve' }, deps())).status).toBe('refused');
    expect((await dispatchSlackAction({ via: 'command', key: 'cmd:x2', actor: owner, source: src, text: 'rm -rf' }, deps())).status).toBe('refused');
    expect((await loadState(dir)).stage).toBe('awaiting_final_review');
  });

  it('a job command outside a known project channel gets no project data', async () => {
    await project('p', { stage: 'paused', pausedFrom: 'build', pauseReason: 'error' });
    const r = await dispatchSlackAction({
      via: 'command', key: 'cmd:o1', actor: owner, source: { appId: PM_APP, role: 'pm', channelId: 'C0RANDOM' }, text: 'resume',
    }, deps());
    expect(r.status).toBe('refused');
    expect(spawned).toEqual([]);
  });
});

describe('lesson cards', () => {
  const proposal = (id: string): Proposal => ({
    id, project: 'p', jobId: '1-init', kind: 'lesson', target: 'build-backend', text: `Run tests ${id}`, why: 'flaky', at: '2026-11-23T00:00:00Z',
  });

  it('accepts the bound proposal once and refuses an edited one', async () => {
    await appendProposals([proposal('P1'), proposal('P2')], home);
    const [p1, p2] = await readProposals(home);
    const coach = { appId: config.roles.coach.appId, role: 'coach' as const, channelId: 'C0ANTON', messageTs: '1700000000.000200' };
    const t1 = await registerActionCard({ kind: 'lesson-accept', role: 'coach', channelId: 'C0ANTON', proposal: { id: p1!.id, revision: proposalRevision(p1!) } }, { config, home });
    await attachCardMessage(t1, 'C0ANTON', coach.messageTs, { home });
    const r = await dispatchSlackAction({ via: 'card', key: 'card:l1', actor: owner, source: coach, token: t1 }, deps());
    expect(r.status).toBe('done');
    expect((await readLessons('build-backend', home)).map((l) => l.text)).toEqual(['Run tests P1']);

    const t2 = await registerActionCard({ kind: 'lesson-accept', role: 'coach', channelId: 'C0ANTON', proposal: { id: p2!.id, revision: 'f'.repeat(64) } }, { config, home });
    await attachCardMessage(t2, 'C0ANTON', coach.messageTs, { home });
    expect((await dispatchSlackAction({ via: 'card', key: 'card:l2', actor: owner, source: coach, token: t2 }, deps())).status).toBe('stale');
    expect((await readProposals(home)).map((p) => p.id)).toEqual(['P2']);
  });
});

describe('inbound normalization', () => {
  const cmdBody = { team_id: 'T0FAKE', user_id: 'U0OWNER', user_name: 'owner', channel_id: PROJECT_CHANNEL, api_app_id: PM_APP, trigger_id: '123.456.abc', command: '/anton', text: 'status' };

  it('builds a command from Slack-supplied IDs, keyed by trigger ID', () => {
    const n = normalizeCommand(cmdBody, 'pm');
    expect(n).toMatchObject({ kind: 'action', action: { via: 'command', key: 'cmd:T0FAKE:123.456.abc', actor: owner, text: 'status' } });
    expect(normalizeCommand({ ...cmdBody, command: '/other' }, 'pm').kind).toBe('ignored');
    expect(normalizeCommand({ ...cmdBody, trigger_id: undefined }, 'pm').kind).toBe('ignored');
  });

  it('builds a card click keyed by its message and action time', () => {
    const n = normalizeBlockAction({
      type: 'block_actions', team: { id: 'T0FAKE' }, user: { id: 'U0OWNER', name: 'owner' }, api_app_id: PM_APP,
      channel: { id: PROJECT_CHANNEL }, container: { message_ts: '1700000000.000100' },
      actions: [{ action_id: 'anton:approve', value: 'a'.repeat(32), action_ts: '1700000001.000001' }],
    }, 'pm');
    expect(n).toMatchObject({ kind: 'action', action: { via: 'card', key: `card:T0FAKE:${PROJECT_CHANNEL}:1700000000.000100:1700000001.000001`, token: 'a'.repeat(32) } });
  });

  it.each([
    ['bot', { bot_id: 'B1' }],
    ['subtype', { subtype: 'message_changed' }],
    ['edit', { edited: { user: 'U0OWNER', ts: '1.2' } }],
    ['forward', { attachments: [{ is_share: true }] }],
    ['no user', { user: undefined }],
  ])('ignores %s message events as orders', (_n, over) => {
    const body = { team_id: 'T0FAKE', api_app_id: PM_APP, event_id: 'Ev1', event: { type: 'message', user: 'U0OWNER', channel: PROJECT_CHANNEL, ts: '1.1', text: 'resume', ...over } };
    expect(normalizeEvent(body, 'pm').kind).toBe('ignored');
  });

  it('acknowledges at once and runs the work in the background', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const handled: string[] = [];
    const inbound = createInboundHandler({
      dispatch: async (a) => { await gate; handled.push(a.key); return { status: 'done', lines: ['ok'] }; },
    });
    const acks: unknown[] = [];
    const replies: string[] = [];
    await inbound.command(cmdBody, 'pm', async (m) => { acks.push(m); }, async (m) => { replies.push(m.text); });
    expect(acks).toHaveLength(1);
    expect(handled).toEqual([]);
    release();
    await inbound.idle();
    expect(handled).toEqual(['cmd:T0FAKE:123.456.abc']);
    expect(replies).toEqual(['ok']);
  });
});

it('keeps action state under the private Slack directory', async () => {
  await project('p');
  await card('approve');
  await access(join(home, 'slack', 'actions.json'));
});

describe('project channel lookup', () => {
  it('maps only a channel ID Anton recorded for exactly one project', async () => {
    const { projectForChannel } = await import('../../src/slack/outbox.js');
    await mkdir(join(home, 'slack'), { recursive: true, mode: 0o700 });
    const store = { version: 1, entries: [], channels: { 'proj:p': 'C0PROJP', 'proj:q': 'C0DUP', 'proj:r': 'C0DUP' }, threads: {}, channelReady: {}, roleReady: {} };
    await writeFile(join(home, 'slack', `outbox-${config.teamId}-${config.channelId}.json`), JSON.stringify(store), { mode: 0o600 });
    const queue = { config, home };
    expect(await projectForChannel(queue, 'C0PROJP')).toBe('p');
    expect(await projectForChannel(queue, 'C0DUP')).toBeUndefined();
    expect(await projectForChannel(queue, 'C0ANTON')).toBeUndefined();
    expect(await projectForChannel(queue, 'proj-p')).toBeUndefined();
  });
});
