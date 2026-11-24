import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SLACK_ROLES, type SlackConfig, type SlackRole } from '../../src/slack/config.js';
import { publishMilestone, specRevision, type Milestone } from '../../src/slack/events.js';
import { drainOutbox, inspectOutbox, type OutboxMessageRequest, type OutboxTransport } from '../../src/slack/outbox.js';
import { startSlackService } from '../../src/slack/service.js';

const config: SlackConfig = {
  teamId: 'TTEST', ownerId: 'UOWNER', channelId: 'CGLOBAL',
  roles: Object.fromEntries(SLACK_ROLES.map((role, index) => [
    role, { appId: `AAPP${index}`, botUserId: `UBOT${index}` },
  ])) as SlackConfig['roles'],
};
const job = { scope: 'job', source: 'factory', project: 'example', jobId: '1-init' } as const;

describe('Slack service with a fake transport', () => {
  it('replays a job across restarts with all nine identities and one parent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'anton-slack-e2e-'));
    let now = 1_000;
    const sent: OutboxMessageRequest[] = [];
    const createProjectChannel = vi.fn(async () => ({ channelId: 'CPROJECT' }));
    const transport: OutboxTransport = {
      async uploadArtifact() { return { fileId: 'FFAKE' }; },
      createProjectChannel,
      async postMessage(request) {
        sent.push(request);
        return { ts: `${sent.length}.000001` };
      },
      async lookupMarker() { return { status: 'unavailable' }; },
    };
    const publish = (event: Milestone) => publishMilestone(event, { home, loadConfig: async () => config });
    const make = (online: boolean) => startSlackService<SlackRole>({
      home, roles: SLACK_ROLES, pollMs: 10,
      async open() { return { connected: () => online, stop: async () => {} }; },
      async drain(roles, signal, canDeliver) {
        now += 2_000;
        await drainOutbox({
          home, config, transport, now: () => now, canDeliver, signal,
          loadProjectSecrets: async () => ({}),
        });
      },
    });

    try {
      const repoPath = join(home, 'project');
      const jobDir = join(repoPath, '.anton', 'jobs', job.jobId);
      await mkdir(jobDir, { recursive: true });
      await writeFile(join(home, 'registry.json'), JSON.stringify({ projects: { [job.project]: { repoPath } } }));
      await writeFile(join(jobDir, 'state.json'), JSON.stringify({ project: job.project, jobId: job.jobId }));
      await writeFile(join(jobDir, 'spec.json'), JSON.stringify({
        title: 'Sample', summary: 'A small fixture', kit: 'fallback', outOfScope: [], tech: [],
        acceptanceChecks: [{ id: 'AC-1', text: 'Works' }],
      }));
      const revision = await specRevision(jobDir);
      expect(revision).toBeDefined();
      const offline = await make(false);
      try {
        await publish({ ...job, kind: 'spec-ready', occurrence: revision! });
        await publish({ ...job, kind: 'plan-ready', occurrence: 'plan' });
        for (const role of ['infra', 'backend', 'frontend'] as const) {
          await publish({ ...job, kind: 'build-handoff', occurrence: 'initial', role });
        }
        for (const kind of ['checks-complete', 'code-review-complete', 'security-review-complete'] as const) {
          await publish({ ...job, kind, occurrence: 'verify-1' });
        }
        await publish({ ...job, kind: 'delivery-ready', occurrence: 'delivered-1' });
        await publish({ scope: 'workspace', kind: 'lesson-proposed', occurrence: 'lesson-1' });
        expect(sent).toHaveLength(0);
      } finally {
        await offline.stop();
      }

      const online = await make(true);
      try {
        await vi.waitFor(async () => {
          const entries = (await inspectOutbox({ config, home })).entries;
          expect(entries).toHaveLength(10);
          expect(entries.every((entry) => entry.status === 'sent')).toBe(true);
        }, { timeout: 15_000 });
      } finally {
        await online.stop();
      }
      expect(createProjectChannel).toHaveBeenCalledOnce();
      expect(new Set(sent.map((item) => item.role))).toEqual(new Set(SLACK_ROLES));
      const posts = sent.filter((item) => item.channelId === 'CPROJECT');
      expect(posts.filter((item) => !item.threadTs)).toHaveLength(1);
      expect(new Set(posts.slice(1).map((item) => item.threadTs))).toEqual(new Set(['1.000001']));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

const live = process.env.ANTON_SLACK_E2E === '1';
describe.skipIf(!live)('Slack transport in a dedicated test workspace', () => {
  it('restarts all nine bots and delivers queued messages in one project thread', async () => {
    const credentialHome = process.env.ANTON_SLACK_TEST_HOME;
    const teamId = process.env.ANTON_SLACK_TEST_TEAM_ID;
    if (!credentialHome || !teamId) throw new Error('Set ANTON_SLACK_TEST_HOME and ANTON_SLACK_TEST_TEAM_ID.');
    const { loadSlackConfig, loadSlackCredentials } = await import('../../src/slack/config.js');
    const { createSlackRuntime } = await import('../../src/slack/transport.js');
    const liveConfig = await loadSlackConfig(credentialHome);
    const credentials = await loadSlackCredentials(credentialHome);
    if (!liveConfig || !credentials || liveConfig.teamId !== teamId) throw new Error('Configure the dedicated test workspace first.');
    const home = await mkdtemp(join(tmpdir(), 'anton-slack-live-'));
    try {
      const runtime = createSlackRuntime(liveConfig, credentials);
      const id = `smoke-${Date.now()}`;
      const target = { ...job, project: id };
      let online = 0;
      const make = () => startSlackService<SlackRole>({
        home, roles: SLACK_ROLES, open: runtime.open,
        async drain(roles, signal, canDeliver) {
          online = roles.size;
          if (roles.size) {
            await drainOutbox({
              home, config: liveConfig, signal, transport: runtime.transport(signal),
              canDeliver,
            });
          }
        },
      });

      const first = await make();
      try {
        await vi.waitFor(() => expect(online).toBe(SLACK_ROLES.length), { timeout: 35_000 });
      } finally {
        await first.stop();
      }
      const queue = { home, config: liveConfig };
      const { enqueueMilestone } = await import('../../src/slack/outbox.js');
      const events: Milestone[] = [
        { ...target, kind: 'plan-ready', occurrence: 'plan' },
        ...(['infra', 'backend', 'frontend'] as const).map((role) => ({
          ...target, kind: 'build-handoff' as const, occurrence: 'initial', role,
        })),
        { ...target, kind: 'checks-complete', occurrence: 'verify-1' },
        { ...target, kind: 'code-review-complete', occurrence: 'verify-1' },
        { ...target, kind: 'security-review-complete', occurrence: 'verify-1' },
        { scope: 'workspace', kind: 'lesson-proposed', occurrence: id },
      ];
      for (const event of events) await enqueueMilestone(event, queue);
      const ownEntries = () => inspectOutbox(queue).then(({ entries }) => entries.filter(({ event }) =>
        event.scope === 'job' ? event.project === id : event.occurrence === id));
      expect((await ownEntries()).every((entry) => entry.status === 'pending')).toBe(true);

      const restarted = await make();
      try {
        await vi.waitFor(async () => {
          expect(online).toBe(SLACK_ROLES.length);
          const entries = await ownEntries();
          expect(entries).toHaveLength(events.length);
          expect(entries.every((entry) => entry.status === 'sent' && entry.messageTs)).toBe(true);
        }, { timeout: 70_000, interval: 500 });
        const { channels, threads } = await inspectOutbox(queue);
        expect(channels[`proj:${id}`]).toBeTruthy();
        expect(Object.keys(threads).filter((key) => key.startsWith(`proj:${id}:`))).toEqual([`proj:${id}:${job.jobId}`]);
      } finally {
        await restarted.stop();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});
