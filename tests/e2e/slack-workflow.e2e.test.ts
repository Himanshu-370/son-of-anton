import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import type { StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { approveCommand } from '../../src/cli/commands/approve.js';
import { initRepoIfMissing, tag } from '../../src/core/git.js';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { registerProject } from '../../src/core/registry.js';
import { loadState, saveState } from '../../src/core/state.js';
import {
  attachCardMessage, dispatchSlackAction, prepareCardModal, type DispatchDeps,
} from '../../src/slack/actions.js';
import { answerQuestion, anthropicChatClient, type ChatClient } from '../../src/slack/chat.js';
import { chatSpentUsd } from '../../src/slack/chat-budget.js';
import { SLACK_ROLES, writeSlackFile, type SlackConfig, type SlackRole } from '../../src/slack/config.js';
import { publishMilestone } from '../../src/slack/events.js';
import { classifyIntent } from '../../src/slack/intent-router.js';
import { createInboundHandler, type Reply } from '../../src/slack/inbound.js';
import { drainOutbox, inspectOutbox, type OutboxMessageRequest, type OutboxTransport } from '../../src/slack/outbox.js';
import { startSlackService } from '../../src/slack/service.js';
import { composeSlackMessage } from '../../src/slack/spec-session.js';

/*
 * Phase 6b acceptance across both front ends.
 *
 * 1. Fake workspace (ANTON_E2E=1, free): raw Slack payloads go through the real inbound handler, action
 *    router, spec session, outbox and Q&A, with a fake transport, a fake PM agent and a fake model client.
 * 2. Live Slack (ANTON_SLACK_E2E=1 plus ANTON_SLACK_TEST_HOME and ANTON_SLACK_TEST_TEAM_ID, the same opt-in
 *    as slack-service.e2e): the real bots in a dedicated test workspace, still with fake agents and no paid
 *    calls. Slack cannot be made to send a person's click or message, so those inputs are synthesized with
 *    the workspace's real IDs; identities, channels, membership, posting and reconnects are real.
 * 3. Paid (ANTON_CHAT_PAID_E2E=1 plus ANTHROPIC_API_KEY): one real explanation answer, about $0.01.
 */

const fakeE2E = process.env.ANTON_E2E === '1';
const liveSlack = process.env.ANTON_SLACK_E2E === '1';
const paid = process.env.ANTON_CHAT_PAID_E2E === '1' && !!process.env.ANTHROPIC_API_KEY;

// Clearly fake identifiers: nine separate identities and no credentials.
const roles = Object.fromEntries(SLACK_ROLES.map((role, i) => [role, { appId: `A0E2E${i}`, botUserId: `U0E2EBOT${i}` }]));
const config = { teamId: 'T0E2E', ownerId: 'U0E2EOWNER', channelId: 'C0E2EANTON', roles } as SlackConfig;
const MEMBER = 'U0E2EMEMBER';
const OUTSIDER = 'U0E2EOUT';
const PROJECT_CHANNELS = ['C0E2EPROJA', 'C0E2EPROJB'];

describe.skipIf(!fakeE2E)('Slack workflow with fake agents in a fake workspace', () => {
  it('runs Slack and CLI checkpoints, role Q&A, permissions, replay and a reconnect', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anton-slack-workflow-e2e-'));
    const before = process.env.ANTON_HOME;
    process.env.ANTON_HOME = home;
    try {
      // Setup: the saved workspace with nine distinct bot identities.
      await writeSlackFile(home, 'config.json', config);
      expect(new Set(Object.values(config.roles).map((r) => r.appId)).size).toBe(9);
      expect(new Set(Object.values(config.roles).map((r) => r.botUserId)).size).toBe(9);

      // Fake Slack.
      const posted: OutboxMessageRequest[] = [];
      let channel = 0;
      let clock = Date.now();
      const transport: OutboxTransport = {
        async createProjectChannel() { return { channelId: PROJECT_CHANNELS[channel++]! }; },
        async postMessage(r) { posted.push(r); return { ts: `1800000000.${String(posted.length).padStart(6, '0')}` }; },
        async lookupMarker() { return { status: 'unavailable' }; },
        async uploadArtifact() { return { fileId: 'F0E2E' }; },
      };
      const drain = async () => {
        for (let i = 0; i < 12; i++) {
          clock += 5_000;
          await drainOutbox({
            home, config, transport, now: () => clock, loadProjectSecrets: async () => ({}),
            compose: (event, channelId) => composeSlackMessage(event, { config, home, channelId }),
            attachCards: async (tokens, channelId, ts) => { for (const t of tokens) await attachCardMessage(t, channelId, ts, { home }); },
          });
        }
      };

      // Fake PM agent and fake model.
      const outputs: unknown[] = [];
      const requests: AgentRequest[] = [];
      const runAgent = async (ctx: StageCtx, req: AgentRequest) => {
        requests.push(req);
        const output = outputs.shift();
        if (output === undefined) throw new Error('unexpected agent call');
        const state = { ...ctx.state, spentUsd: ctx.state.spentUsd + 0.5 };
        await saveState(ctx.jobDir, state);
        return { output, sessionId: `s${requests.length}`, state, totalUsd: 0.5 };
      };
      const modelCalls: unknown[] = [];
      const client = (): ChatClient => ({
        async send(params) {
          modelCalls.push(params);
          return {
            id: 'msg_e2e', type: 'message', role: 'assistant', model: params.model, stop_reason: 'end_turn', stop_sequence: null,
            content: [{ type: 'text', text: 'The tracker counts streaks per day.', citations: null }],
            usage: { input_tokens: 900, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          } as unknown as Message;
        },
      });
      const spawned: string[] = [];
      const previews: Array<{ text: string; threadTs: string; blocks?: unknown[] }> = [];
      const memberships: Record<string, string[]> = Object.fromEntries(PROJECT_CHANNELS.map((c) => [c, [config.ownerId, MEMBER]]));
      memberships[config.channelId] = [config.ownerId];
      const deps: DispatchDeps = {
        config, home,
        intentNow: () => clock,
        classify: (input) => classifyIntent(input, {
          home,
          env: input.text.startsWith('new ') ? {} : { ANTHROPIC_API_KEY: 'fake-router-key' },
          client: () => ({
            async send(params) {
              const prompt = String(params.messages[0]?.content);
              const output = input.text === 'start a project'
                ? { intent: 'unclear', clarify: 'What should the project do?' }
                : { intent: 'start_new', description: 'a habit tracker' };
              if (input.text.includes('Owner clarification:')) {
                expect(prompt).toContain('Original request:\nstart a project');
                expect(prompt).toContain('Owner clarification:\nbuild a habit tracker');
              }
              return {
                stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }],
                usage: { input_tokens: 900, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              } as Message;
            },
          }),
        }),
        async postIntentThreadMessage(message) {
          previews.push(message);
          return { ts: `1800000300.${String(previews.length).padStart(6, '0')}` };
        },
        jobs: {
          preflight: async () => undefined, spawnRun: (name) => { spawned.push(name); },
          stopContainer: async () => undefined, retro: { env: {}, home },
        },
        spec: {
          home, preflight: async () => undefined, ensureImage: async () => 'img', startContainer: async (s) => `anton-${s}`,
          stopContainer: async () => undefined, runAgent: runAgent as never, ensureRepoMap: async (ctx) => ctx.state,
          listFiles: async () => [], readHistory: async () => [],
        },
        access: {
          channel: async () => ({ isPrivate: true, isShared: false, isArchived: false, teamId: config.teamId }),
          members: async (c) => memberships[c] ?? [],
        },
        chat: { home, env: { ANTHROPIC_API_KEY: 'fake-e2e-key-0001' }, client },
      };
      const replies: string[] = [];
      const handler = createInboundHandler({
        dispatch: (a) => dispatchSlackAction(a, deps),
        prepareModal: (a) => prepareCardModal(a, deps),
      });
      const respond = async (r: Reply) => { replies.push(r.text); };
      const notify = () => async (text: string) => { replies.push(text); };
      let ids = 0;
      const command = (text: string, user = config.ownerId, channelId = config.channelId) => handler.command({
        team_id: config.teamId, user_id: user, channel_id: channelId, api_app_id: config.roles.pm.appId,
        trigger_id: `1.2.t${++ids}`, command: '/anton', text,
      }, 'pm', async () => undefined, respond);
      const event = (body: { type: 'message' | 'app_mention'; user: string; channel: string; text: string; thread_ts?: string }, role: SlackRole = 'pm', eventId = `EvE2E${++ids}`) =>
        handler.event({
          team_id: config.teamId, api_app_id: config.roles[role].appId, event_id: eventId,
          event: { ...body, ts: `1800000100.${String(++ids).padStart(6, '0')}` },
        }, role, notify);
      const click = (role: 'pm' | 'qa', channelId: string, messageTs: string, value: string, user = config.ownerId, actionTs = `1800000200.${String(++ids).padStart(6, '0')}`) =>
        handler.action({
          type: 'block_actions', team: { id: config.teamId }, user: { id: user }, api_app_id: config.roles[role].appId,
          channel: { id: channelId }, container: { message_ts: messageTs }, trigger_id: `9.9.k${ids}`,
          actions: [{ action_id: 'anton_1', value, action_ts: actionTs }],
        }, role, async () => undefined, respond, async () => undefined);
      const cardButtons = (m: OutboxMessageRequest) => ((m.blocks ?? []) as { elements?: { value: string; text: { text: string } }[] }[])
        .flatMap((b) => b.elements ?? []);
      const tsOf = (m: OutboxMessageRequest) => `1800000000.${String(posted.indexOf(m) + 1).padStart(6, '0')}`;

      await event({ type: 'app_mention', user: config.ownerId, channel: config.channelId, text: `<@${config.roles.pm.botUserId}> start a project` });
      await handler.idle();
      expect(requests).toHaveLength(0);
      expect(previews).toHaveLength(1);
      expect(previews[0]?.text).toBe('What should the project do?');
      await event({ type: 'app_mention', user: config.ownerId, channel: config.channelId,
        thread_ts: previews[0]!.threadTs, text: `<@${config.roles.pm.botUserId}> build a habit tracker` });
      await handler.idle();
      expect(previews).toHaveLength(2);
      const buttonsFor = (preview: (typeof previews)[number]) =>
        (preview.blocks as { elements?: { value: string; text: { text: string } }[] }[]).flatMap((block) => block.elements ?? []);
      const buttons = buttonsFor(previews[1]!);
      const cancel = buttons.find((button) => button.text.text === 'Cancel');
      const confirm = buttons.find((button) => button.text.text === 'Confirm');
      expect(cancel).toBeDefined();
      expect(confirm).toBeDefined();
      await click('pm', config.channelId, '1800000300.000002', cancel!.value);
      await handler.idle();
      await click('pm', config.channelId, '1800000300.000002', confirm!.value);
      await handler.idle();
      expect(requests).toHaveLength(0);

      // 1. An expired fallback card is stale. A fresh model-routed card starts the spec.
      outputs.push({ kind: 'questions', questions: ['Who uses it?'] });
      await event({ type: 'app_mention', user: config.ownerId, channel: config.channelId, text: `<@${config.roles.pm.botUserId}> new a habit tracker` });
      await handler.idle();
      expect(requests).toHaveLength(0);
      expect(previews).toHaveLength(3);
      expect(previews[2]?.text).toContain("Plain English is paused");
      const start = buttonsFor(previews[2]!).find((button) => button.text.text === 'Confirm');
      expect(start).toBeDefined();
      clock += 30 * 60_000;
      await click('pm', config.channelId, '1800000300.000003', start!.value);
      await handler.idle();
      expect(requests).toHaveLength(0);
      expect(replies.at(-1)).toContain('confirmation expired');

      await event({ type: 'app_mention', user: config.ownerId, channel: config.channelId, text: `<@${config.roles.pm.botUserId}> Please build a habit tracker` });
      await handler.idle();
      expect(requests).toHaveLength(0);
      const modelConfirm = buttonsFor(previews[3]!).find((button) => button.text.text === 'Confirm');
      expect(modelConfirm).toBeDefined();
      await click('pm', config.channelId, '1800000300.000004', modelConfirm!.value);
      await handler.idle();
      expect(requests).toHaveLength(1);
      const slug = replies.join('\n').match(/Started project (\S+)/)?.[1];
      expect(slug).toBeTruthy();
      await drain();
      const threadKey = Object.keys((await inspectOutbox({ config, home })).threads).find((k) => k.startsWith(`proj:${slug}:`))!;
      const threadTs = (await inspectOutbox({ config, home })).threads[threadKey]!;
      const projectChannel = (await inspectOutbox({ config, home })).channels[`proj:${slug}`]!;
      expect(projectChannel).toBe(PROJECT_CHANNELS[0]);
      outputs.push({ kind: 'spec', spec: {
        title: 'Habit Tracker', summary: 'Track habits.', outOfScope: [], tech: ['node'], services: [],
        acceptanceChecks: [{ id: 'AC-1', text: 'adds a habit' }],
      } });
      await event({ type: 'message', user: config.ownerId, channel: projectChannel, text: 'Just me', thread_ts: threadTs });
      await handler.idle();
      expect(requests).toHaveLength(2);
      const jobDir = jobDirOf(join(home, 'projects', slug!), threadKey.split(':').at(-1)!);
      expect((await loadState(jobDir)).stage).toBe('awaiting_spec_approval');
      await drain();
      const specCard = posted.find((m) => cardButtons(m).some((b) => b.text.text.startsWith('Approve')) && m.role === 'pm')!;
      expect(specCard).toBeDefined();

      // 2. Approved from the CLI. The Slack card for the same spec is then stale and starts nothing.
      const out: string[] = [];
      const code = await approveCommand(slug!, {
        out: (l) => out.push(l), err: (l) => out.push(l), preflight: async () => undefined,
        spawnRun: (name) => { spawned.push(name); },
      });
      expect(code).toBe(0);
      expect(spawned).toEqual([slug]);
      const approve = cardButtons(specCard).find((b) => b.text.text.startsWith('Approve'))!;
      await click('pm', projectChannel, tsOf(specCard), approve.value);
      await handler.idle();
      expect(spawned).toEqual([slug]);
      expect(replies.at(-1)).toMatch(/out of date|Nothing to approve|no longer|Nothing was changed/i);

      // 3. A CLI-started job reaches final review and is approved from its Slack card, once.
      const repo = join(home, 'cli-project');
      const cliJob = jobDirOf(repo, '1-init');
      await mkdir(cliJob, { recursive: true });
      await initRepoIfMissing(repo, 'main');
      await registerProject('cli-proj', repo);
      await writeFile(join(cliJob, 'spec.md'), 'A word counter CLI.\n');
      await saveState(cliJob, {
        jobId: '1-init', project: 'cli-proj', stage: 'awaiting_final_review', round: 1, maxRounds: 3, budgetUsd: 10, spentUsd: 2,
        warned80: false, completedTasks: [], updatedAt: '',
      });
      await (await import('../../src/core/git.js')).commitAll(repo, 'chore: init', {}, { emptyIfNoHead: true });
      await tag(repo, 'anton/1-init/delivered-1');
      await publishMilestone({ scope: 'job', source: 'factory', project: 'cli-proj', jobId: '1-init', kind: 'delivery-ready', occurrence: 'delivered-1' }, { home });
      await drain();
      const cliChannel = (await inspectOutbox({ config, home })).channels['proj:cli-proj']!;
      const delivery = posted.find((m) => m.role === 'qa' && m.channelId === cliChannel && cardButtons(m).some((b) => b.text.text.startsWith('Approve')))!;
      expect(delivery).toBeDefined();
      const finalApprove = cardButtons(delivery).find((b) => b.text.text.startsWith('Approve'))!;
      // A member cannot decide; the owner can, and a redelivered click acts once.
      await click('qa', cliChannel, tsOf(delivery), finalApprove.value, MEMBER);
      await handler.idle();
      expect((await loadState(cliJob)).stage).toBe('awaiting_final_review');
      const actionTs = '1800000300.000001';
      await click('qa', cliChannel, tsOf(delivery), finalApprove.value, config.ownerId, actionTs);
      await click('qa', cliChannel, tsOf(delivery), finalApprove.value, config.ownerId, actionTs);
      await handler.idle();
      expect((await loadState(cliJob)).stage).toBe('done');

      // 4. Role Q&A: a member asks the Tech Lead; status is free; a redelivery is answered once.
      const asked = replies.length;
      await event({ type: 'app_mention', user: MEMBER, channel: cliChannel, text: `<@${config.roles.tech_lead.botUserId}> how does the counter work?` }, 'tech_lead', 'EvE2EQ1');
      await event({ type: 'app_mention', user: MEMBER, channel: cliChannel, text: `<@${config.roles.tech_lead.botUserId}> how does the counter work?` }, 'tech_lead', 'EvE2EQ1');
      await handler.idle();
      expect(modelCalls).toHaveLength(1);
      expect(replies.slice(asked).filter((r) => r.startsWith('Tech Lead:'))).toHaveLength(1);
      await event({ type: 'app_mention', user: MEMBER, channel: cliChannel, text: `<@${config.roles.qa.botUserId}> status?` }, 'qa');
      await handler.idle();
      expect(modelCalls).toHaveLength(1);
      expect(replies.at(-1)).toMatch(/^QA: status of cli-proj[\s\S]*done/);
      expect(await chatSpentUsd(config.teamId, Date.now(), { home })).toBeGreaterThan(0);

      // 5. Permissions: an outsider gets no data and no model call; member status works, member control does not.
      await event({ type: 'app_mention', user: OUTSIDER, channel: cliChannel, text: `<@${config.roles.qa.botUserId}> how does it work?` }, 'qa');
      await command('status', MEMBER, cliChannel);
      await command('abandon 1-init', MEMBER, cliChannel);
      await handler.idle();
      expect(modelCalls).toHaveLength(1);
      expect(replies.slice(-3).join('\n')).not.toMatch(/word counter/);
      expect(replies.slice(-3).some((r) => /cli-proj\s+done/.test(r))).toBe(true);
      expect(replies.slice(-3).some((r) => /Only the Anton owner/.test(r))).toBe(true);

      // 6. Reconnect: a milestone queued while every bot is offline is delivered once they reconnect.
      let online = false;
      const sentBefore = posted.length;
      const make = () => startSlackService<SlackRole>({
        home, roles: SLACK_ROLES, pollMs: 10,
        async open() { return { connected: () => online, stop: async () => {} }; },
        async drain(_connected, signal, canDeliver) {
          clock += 5_000;
          await drainOutbox({ home, config, transport, now: () => clock, canDeliver, signal, loadProjectSecrets: async () => ({}) });
        },
      });
      const offline = await make();
      try {
        await publishMilestone({ scope: 'job', source: 'factory', project: 'cli-proj', jobId: '1-init', kind: 'plan-ready', occurrence: 'replan' }, { home });
        await new Promise((r) => setTimeout(r, 100));
        expect(posted.length).toBe(sentBefore);
      } finally {
        await offline.stop();
      }
      online = true;
      const back = await make();
      try {
        await vi.waitFor(() => expect(posted.length).toBe(sentBefore + 1), { timeout: 10_000 });
      } finally {
        await back.stop();
      }
      // The restart repeats nothing.
      await drain();
      expect(posted.length).toBe(sentBefore + 1);
    } finally {
      if (before === undefined) delete process.env.ANTON_HOME;
      else process.env.ANTON_HOME = before;
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(!liveSlack)('Slack workflow in the dedicated test workspace (fake agents, no paid calls)', () => {
  it('connects the nine bots, verifies membership, posts a card thread, acts once, and reconnects', async () => {
    const credentialHome = process.env.ANTON_SLACK_TEST_HOME;
    const teamId = process.env.ANTON_SLACK_TEST_TEAM_ID;
    if (!credentialHome || !teamId) throw new Error('Set ANTON_SLACK_TEST_HOME and ANTON_SLACK_TEST_TEAM_ID.');
    const { loadSlackConfig, loadSlackCredentials } = await import('../../src/slack/config.js');
    const { createSlackRuntime } = await import('../../src/slack/transport.js');
    const { slackSetupApi } = await import('../../src/slack/setup-api.js');
    const live = await loadSlackConfig(credentialHome);
    const credentials = await loadSlackCredentials(credentialHome);
    if (!live || !credentials || live.teamId !== teamId) throw new Error('Configure the dedicated test workspace first.');
    const home = await mkdtemp(join(tmpdir(), 'anton-slack-workflow-live-'));
    const before = process.env.ANTON_HOME;
    process.env.ANTON_HOME = home;
    try {
      await writeSlackFile(home, 'config.json', live);
      const runtime = createSlackRuntime(live, credentials);
      const access = {
        channel: (c: string) => slackSetupApi.channelInfo(credentials.pm.botToken, c),
        members: (c: string) => slackSetupApi.channelMembers(credentials.pm.botToken, c),
      };
      // Separate identities: each role's token authenticates as its own bot (open checks auth.test against config).
      let online = 0;
      const make = () => startSlackService<SlackRole>({
        home, roles: SLACK_ROLES, open: runtime.open,
        async drain(connected, signal, canDeliver) {
          online = connected.size;
          if (connected.size) {
            await drainOutbox({
              home, config: live, signal, transport: runtime.transport(signal), canDeliver,
              compose: (event, channelId) => composeSlackMessage(event, { config: live, home, channelId }),
              attachCards: async (tokens, channelId, ts) => { for (const t of tokens) await attachCardMessage(t, channelId, ts, { home }); },
            });
          }
        },
      });
      // A CLI-started fake job at final review, in a fresh private project channel.
      const slug = `wf-${Date.now()}`;
      const repo = join(home, 'repo');
      const dir = jobDirOf(repo, '1-init');
      await mkdir(dir, { recursive: true });
      await initRepoIfMissing(repo, 'main');
      await registerProject(slug, repo);
      await saveState(dir, {
        jobId: '1-init', project: slug, stage: 'awaiting_final_review', round: 1, maxRounds: 3, budgetUsd: 10, spentUsd: 1,
        warned80: false, completedTasks: [], updatedAt: '',
      });
      await (await import('../../src/core/git.js')).commitAll(repo, 'chore: init', {}, { emptyIfNoHead: true });
      await tag(repo, 'anton/1-init/delivered-1');
      await publishMilestone({ scope: 'job', source: 'factory', project: slug, jobId: '1-init', kind: 'delivery-ready', occurrence: 'delivered-1' }, { home });
      const first = await make();
      let channelId: string;
      try {
        await vi.waitFor(async () => {
          expect(online).toBe(SLACK_ROLES.length);
          const { entries, channels } = await inspectOutbox({ config: live, home });
          expect(channels[`proj:${slug}`]).toBeTruthy();
          expect(entries.every((e) => e.status === 'sent')).toBe(true);
        }, { timeout: 70_000, interval: 500 });
        channelId = (await inspectOutbox({ config: live, home })).channels[`proj:${slug}`]!;
      } finally {
        await first.stop();
      }
      // Real membership by user ID: the owner is in the project channel, the bots' own IDs are not people.
      const info = await access.channel(channelId);
      expect(info?.isPrivate && !info.isShared).toBe(true);
      expect(await access.members(channelId)).toContain(live.ownerId);
      // Status for the owner by mention, from the records, at no cost, through the live membership check.
      const deps: DispatchDeps = {
        config: live, home, access, chat: { home, env: {} },
        jobs: { preflight: async () => undefined, spawnRun: () => undefined, stopContainer: async () => undefined, retro: { env: {}, home } },
      };
      const q = await dispatchSlackAction({
        via: 'message', key: `event:${live.teamId}:EvLive${Date.now()}`, eventType: 'app_mention',
        actor: { teamId: live.teamId, userId: live.ownerId, isBot: false }, mentions: [live.roles.qa.botUserId],
        source: { appId: live.roles.qa.appId, role: 'qa', channelId, messageTs: '1800000000.000001' }, text: 'status?',
      }, deps);
      expect(q.status).toBe('done');
      expect(q.lines.join('\n')).toMatch(/awaiting_final_review/);
      // Phase 7 posts a real threaded preview in the dedicated workspace. The Owner event and
      // click are synthetic, and the classifier is fake, so this costs no model calls.
      const { webApi } = await import('@slack/bolt');
      const pm = new webApi.WebClient(credentials.pm.botToken, { retryConfig: { retries: 0 } });
      const parent = await pm.chat.postMessage({ channel: channelId, text: 'Phase 7 test fixture: send the delivery back.' });
      expect(parent.ts).toBeTruthy();
      let previewTs: string | undefined;
      let cancelToken: string | undefined;
      deps.classify = async () => ({ kind: 'intent', intent: { intent: 'reject', notes: 'Test fixture review notes' } });
      deps.postIntentThreadMessage = async (message) => {
        const sent = await runtime.postIntentThreadMessage(message);
        previewTs = sent.ts;
        const blocks = (message.blocks ?? []) as { elements?: { value: string; text: { text: string } }[] }[];
        cancelToken = blocks.flatMap((block) => block.elements ?? []).find((button) => button.text.text === 'Cancel')?.value;
        return sent;
      };
      const owner = { teamId: live.teamId, userId: live.ownerId, isBot: false };
      const source = { appId: live.roles.pm.appId, role: 'pm' as const, channelId };
      await dispatchSlackAction({
        via: 'message', key: `event:${live.teamId}:EvPreview${Date.now()}`, eventType: 'app_mention',
        actor: owner, mentions: [live.roles.pm.botUserId], source: { ...source, messageTs: parent.ts! },
        text: 'Send the delivery back.',
      }, deps);
      expect(previewTs).toBeTruthy();
      expect(cancelToken).toBeTruthy();
      expect(await dispatchSlackAction({
        via: 'card', key: `card:${live.teamId}:live-cancel`, actor: owner, token: cancelToken!,
        source: { ...source, messageTs: previewTs! },
      }, deps)).toMatchObject({ status: 'done', lines: ['Cancelled. Nothing was changed.'] });
      expect((await loadState(dir)).stage).toBe('awaiting_final_review');
      // A forged team gets nothing.
      const forged = await dispatchSlackAction({
        via: 'message', key: `event:T0FORGED:EvLive${Date.now()}`, eventType: 'app_mention',
        actor: { teamId: 'T0FORGED', userId: live.ownerId, isBot: false },
        source: { appId: live.roles.qa.appId, role: 'qa', channelId, messageTs: '1800000000.000002' }, text: 'status?',
      }, deps);
      expect(forged.status).toBe('ignored');
      // Reconnect: the service comes back with all nine bots and repeats nothing.
      const sent = (await inspectOutbox({ config: live, home })).entries.length;
      const again = await make();
      try {
        await vi.waitFor(() => expect(online).toBe(SLACK_ROLES.length), { timeout: 35_000 });
        expect((await inspectOutbox({ config: live, home })).entries).toHaveLength(sent);
      } finally {
        await again.stop();
      }
    } finally {
      if (before === undefined) delete process.env.ANTON_HOME;
      else process.env.ANTON_HOME = before;
      await rm(home, { recursive: true, force: true });
    }
  }, 180_000);
});

describe.skipIf(!paid)('Role Q&A with a real model (paid, about $0.01)', () => {
  it('answers one explanation within the per-answer cap and reconciles the reported cost', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anton-chat-paid-'));
    const before = process.env.ANTON_HOME;
    process.env.ANTON_HOME = home;
    try {
      const repo = join(home, 'repo');
      const dir = jobDirOf(repo, '1-init');
      await mkdir(dir, { recursive: true });
      await registerProject('paid-check', repo);
      await saveState(dir, {
        jobId: '1-init', project: 'paid-check', stage: 'build', round: 1, maxRounds: 3, budgetUsd: 10, spentUsd: 1,
        warned80: false, completedTasks: [], updatedAt: '',
      });
      await writeFile(join(dir, 'spec.md'), 'A habit tracker. A streak counts consecutive days with the habit done.\n');
      const answer = await answerQuestion({
        teamId: 'T0PAID', userId: 'U0PAID', role: 'tech_lead', project: 'paid-check',
        question: 'What does a streak count?', requestKey: `event:T0PAID:EvPaid${Date.now()}`,
      }, { home, client: anthropicChatClient });
      expect(answer.status).toBe('answered');
      expect(answer.text).toMatch(/^Tech Lead: /);
      expect(answer.costUsd).toBeGreaterThan(0);
      expect(answer.costUsd).toBeLessThanOrEqual(0.1);
      expect(await chatSpentUsd('T0PAID', Date.now(), { home })).toBeCloseTo(answer.costUsd!, 10);
    } finally {
      if (before === undefined) delete process.env.ANTON_HOME;
      else process.env.ANTON_HOME = before;
      await rm(home, { recursive: true, force: true });
    }
  }, 60_000);
});
