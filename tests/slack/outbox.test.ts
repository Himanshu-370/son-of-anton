import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishMilestone, specRevision, type Milestone } from '../../src/slack/events.js';
import { drainOutbox, inspectOutbox, OutboxDeliveryError, resolveOutboxEntry, type OutboxTransport } from '../../src/slack/outbox.js';
import { prepareSlackArtifact } from '../../src/slack/artifacts.js';
import { reconcileCheckpoints } from '../../src/slack/reconcile.js';
import type { SlackConfig } from '../../src/slack/config.js';

const config = {
  teamId: 'T123', ownerId: 'U123', channelId: 'C123',
  roles: Object.fromEntries(['pm', 'tech_lead', 'frontend', 'backend', 'infra', 'qa', 'code_reviewer', 'security_reviewer', 'coach']
    .map((role, i) => [role, { appId: `A${i}123`, botUserId: `U${i}123` }])),
} as SlackConfig;

const job = { scope: 'job', source: 'factory', project: 'demo', jobId: '1-init' } as const;
const workspace = { scope: 'workspace', kind: 'plugin-updated', occurrence: '1' } as const;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
let home: string;
let time: number;
let transport: ReturnType<typeof fakeTransport>;

function fakeTransport() {
  let ts = 0;
  return {
    createProjectChannel: vi.fn<OutboxTransport['createProjectChannel']>(async () => ({ channelId: 'C456' })),
    postMessage: vi.fn<OutboxTransport['postMessage']>(async () => ({ ts: `123.${++ts}` })),
    lookupMarker: vi.fn<OutboxTransport['lookupMarker']>(async () => ({ status: 'unavailable' })),
    uploadArtifact: vi.fn<NonNullable<OutboxTransport['uploadArtifact']>>(async () => ({ fileId: 'F123' })),
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-outbox-'));
  time = 1000;
  transport = fakeTransport();
});
afterEach(() => rm(home, { recursive: true, force: true }));
const publish = (event: Milestone) => publishMilestone(event, { home, loadConfig: async () => config });
const drain = () => drainOutbox({ home, config, transport, now: () => time });
const inspect = () => inspectOutbox({ home, config });
const runWorker = (script: string, ...args: string[]) =>
  promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, home, JSON.stringify(config), ...args]);

async function createProjectFiles(): Promise<string> {
  const repoPath = join(home, 'repo');
  const dir = join(repoPath, '.anton', 'jobs', job.jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(home, 'registry.json'), JSON.stringify({ projects: { [job.project]: { repoPath } } }));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ jobId: job.jobId, project: job.project }));
  return dir;
}

describe('Slack outbox', () => {
  it('is inert without setup and does not fail the caller when configuration or storage fails', async () => {
    await publishMilestone(workspace, { home, loadConfig: async () => undefined });
    await publishMilestone(workspace, { home, loadConfig: async () => { throw new Error('private'); } });
    await expect(inspect()).resolves.toMatchObject({ entries: [] });
    await rm(join(home, 'slack'), { recursive: true });
    await writeFile(join(home, 'slack'), '');
    await expect(publish(workspace)).resolves.toBeUndefined();
  });

  it('preserves concurrent producers and deduplicates by role and persisted occurrence across drains', async () => {
    const events = Array.from({ length: 12 }, (_, i) => ({ ...workspace, occurrence: String(i + 1) }));
    await Promise.all([...events, ...events].map(publish));
    expect((await inspect()).entries).toHaveLength(12);
    for (let i = 0; i < 12; i++) {
      await drain();
      time += 1000;
    }
    await Promise.all(events.map(publish));
    time += 1000;
    await drain();
    expect(transport.postMessage).toHaveBeenCalledTimes(12);
    expect((await inspect()).entries.every((e) => e.status === 'sent')).toBe(true);
  });

  it('does not lose events when separate producers contend after a writer exits with the lock', async () => {
    await inspect();
    await runWorker(`
      import { join } from 'node:path';
      import { acquireOutboxLock } from './src/slack/outbox-lock.ts';
      await acquireOutboxLock(join(process.argv[1], 'slack'), 'write');
      process.exit(0);
    `);
    const script = `
      import { publishMilestone } from './src/slack/events.ts';
      const [, home, rawConfig, offset] = process.argv;
      for (let i = 0; i < 4; i++) {
        await publishMilestone({ scope: 'workspace', kind: 'plugin-updated', occurrence: String(Number(offset) + i) },
          { home, loadConfig: async () => JSON.parse(rawConfig) });
      }
    `;
    await Promise.all(['0', '4', '8', '12'].map((offset) => runWorker(script, offset)));
    expect((await inspect()).entries.map(({ event }) => Number(event.occurrence)).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 16 }, (_, i) => i));
  }, 10_000);

  it('reconciles a claimed send after the worker exits before saving the acknowledgement', async () => {
    await publish(workspace);
    await runWorker(`
      import { drainOutbox } from './src/slack/outbox.ts';
      const [, home, rawConfig] = process.argv;
      await drainOutbox({ home, config: JSON.parse(rawConfig), now: () => 1000, transport: {
        postMessage: async () => process.exit(0),
      } });
    `);
    expect((await inspect()).entries[0]?.claim?.kind).toBe('message');
    transport.lookupMarker.mockResolvedValueOnce({ status: 'found', ts: '123.9' });
    await drain();
    expect(transport.postMessage).not.toHaveBeenCalled();
    expect((await inspect()).entries[0]).toMatchObject({ status: 'sent', messageTs: '123.9' });
  }, 10_000);

  it('filters bench jobs and rejects unschematized or path-shaped input', async () => {
    await publish({ ...job, source: 'bench', kind: 'plan-ready', occurrence: '1' });
    await publish({ ...workspace, message: 'sensitive output' } as Milestone);
    await publish({ ...workspace, occurrence: '/tmp/raw.log' });
    await publish({ scope: 'workspace', kind: 'bench-summary', occurrence: 'run-1', count: 4 });
    await drain();
    expect(transport.createProjectChannel).not.toHaveBeenCalled();
    expect(transport.postMessage.mock.calls.map(([m]) => m.text)).toEqual(['Benchmark summary (count: 4)']);
  });

  it('creates one private channel and one PM thread, then delivers queued messages in order with their owning bot', async () => {
    await publish({ ...job, kind: 'plan-ready', occurrence: '1', count: 3 });
    await publish({ ...job, kind: 'build-handoff', role: 'infra', occurrence: '2' });
    for (let i = 0; i < 3; i++, time += 1000) await drain();
    expect(transport.createProjectChannel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ role: 'pm', name: 'proj-demo', ownerId: 'U123' }));
    expect(transport.postMessage.mock.calls.map(([m]) => [m.role, m.channelId, m.threadTs])).toEqual([
      ['pm', 'C456', undefined], ['tech_lead', 'C456', '123.1'], ['infra', 'C456', '123.1'],
    ]);
  });

  it('honors Retry-After and allows the next event through after a definitive final failure', async () => {
    transport.postMessage.mockRejectedValueOnce(new OutboxDeliveryError('retry', 5000));
    transport.postMessage.mockRejectedValueOnce(new OutboxDeliveryError('permanent'));
    await publish(workspace);
    await publish({ ...workspace, occurrence: '2' });
    await drain();
    time += 4999;
    await drain();
    expect(transport.postMessage).toHaveBeenCalledTimes(1);
    time++;
    await drain();
    time += 1000;
    await drain();
    expect(transport.postMessage).toHaveBeenCalledTimes(3);
    expect((await inspect()).entries.map((e) => e.status)).toEqual(['failed', 'sent']);
  });

  it('bounds repeated definite failures', async () => {
    transport.postMessage.mockRejectedValue(new OutboxDeliveryError('retry'));
    await publish(workspace);
    for (let i = 0; i < 8; i++, time += 120_000) await drain();
    expect(transport.postMessage).toHaveBeenCalledTimes(5);
    expect((await inspect()).entries[0]?.status).toBe('failed');
  });

  it('persists a claim before sending and leaves the producer lock free during transport', async () => {
    transport.postMessage.mockImplementationOnce(async () => {
      expect((await inspect()).entries[0]?.claim?.kind).toBe('message');
      await publish({ ...workspace, occurrence: '2' });
      await drain(); // another worker leaves the live claim alone
      throw new Error('connection lost after write');
    });
    transport.lookupMarker.mockResolvedValue({ status: 'found', ts: '123.9' });
    await publish(workspace);
    await drain();
    expect(transport.postMessage).toHaveBeenCalledTimes(1);
    await drain();
    expect(transport.lookupMarker).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'message', request: expect.objectContaining({ channelId: 'C123', botUserId: config.roles.pm.botUserId, marker: expect.any(String) }),
    }));
    expect((await inspect()).entries.map((e) => e.status)).toEqual(['sent', 'pending']);
  });

  it('leaves offline operations and offline reconciliation untouched', async () => {
    const canDeliver = vi.fn(() => false);
    await publish({ ...job, kind: 'plan-ready', occurrence: '1' });
    await drainOutbox({ home, config, transport, canDeliver, now: () => time });
    expect(canDeliver).toHaveBeenCalledWith('pm');
    expect((await inspect()).entries[0]).toMatchObject({ status: 'pending', attempts: 0 });
    transport.createProjectChannel.mockRejectedValueOnce(new Error('timeout'));
    await drain();
    await drainOutbox({ home, config, transport, canDeliver, now: () => time });
    expect(transport.lookupMarker).not.toHaveBeenCalled();
    expect((await inspect()).entries[0]).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('stops before the next side effect after cancellation and saves the completed operation', async () => {
    const controller = new AbortController();
    transport.createProjectChannel.mockImplementationOnce(async () => {
      controller.abort();
      return { channelId: 'C456' };
    });
    await publish({ ...job, kind: 'plan-ready', occurrence: '1' });
    await drainOutbox({ home, config, transport, signal: controller.signal, now: () => time });
    expect(transport.postMessage).not.toHaveBeenCalled();
    expect((await inspect()).channels).toEqual({ 'proj:demo': 'C456' });
    await drain();
    expect(transport.createProjectChannel).toHaveBeenCalledTimes(1);
    expect(transport.postMessage).toHaveBeenCalledTimes(1);
  });

  it('reconciles a lost thread response to the existing parent without reposting it', async () => {
    transport.postMessage.mockRejectedValueOnce(new Error('ack lost'));
    transport.lookupMarker.mockResolvedValueOnce({ status: 'found', ts: '123.7' });
    await publish({ ...job, kind: 'plan-ready', occurrence: '1' });
    await drain();
    time += 1000;
    await drain();
    expect(transport.lookupMarker).toHaveBeenCalledWith(expect.objectContaining({ kind: 'thread' }));
    expect(transport.postMessage.mock.calls.map(([m]) => m.threadTs)).toEqual([undefined, '123.7']);
  });

  it('retries an ambiguous send only after lookup establishes absence', async () => {
    transport.postMessage.mockRejectedValueOnce(new Error('connection lost'));
    transport.lookupMarker.mockResolvedValueOnce({ status: 'absent' });
    await publish(workspace);
    await drain();
    await drain();
    expect(transport.postMessage).toHaveBeenCalledTimes(1);
    time += 1000;
    await drain();
    expect(transport.postMessage).toHaveBeenCalledTimes(2);
    expect(transport.postMessage.mock.calls[0]?.[0].marker).toBe(transport.postMessage.mock.calls[1]?.[0].marker);
  });

  it('retries transient marker lookups with the original claim and honors Retry-After', async () => {
    transport.postMessage.mockRejectedValueOnce(new Error('lost receipt'));
    transport.lookupMarker.mockRejectedValueOnce(new OutboxDeliveryError('retry', 5000));
    transport.lookupMarker.mockResolvedValueOnce({ status: 'found', ts: '123.9' });
    await publish(workspace);
    await drain();
    const claim = (await inspect()).entries[0]?.claim;
    await drain();
    expect((await inspect()).entries[0]).toMatchObject({ status: 'pending', claim });
    time += 4999;
    await drain();
    expect(transport.lookupMarker).toHaveBeenCalledTimes(1);
    time++;
    await drain();
    expect(transport.lookupMarker.mock.calls.map(([attempt]) => attempt)).toEqual([claim, claim]);
    expect(transport.postMessage).toHaveBeenCalledTimes(1);
    expect((await inspect()).entries[0]?.status).toBe('sent');
  });

  it('bounds transient read retries and retains the claim for operator review', async () => {
    transport.postMessage.mockRejectedValueOnce(new Error('lost receipt'));
    transport.lookupMarker.mockResolvedValue({ status: 'retry' });
    await publish(workspace);
    await drain();
    const { claim } = (await inspect()).entries[0]!;
    for (let i = 0; i < 7; i++, time += 60_000) await drain();
    expect(transport.lookupMarker).toHaveBeenCalledTimes(5);
    expect(transport.postMessage).toHaveBeenCalledTimes(1);
    expect((await inspect()).entries[0]).toMatchObject({ status: 'review', claim });
  });

  it('requires a matching review marker and confirms a verified channel without recreating it', async () => {
    transport.createProjectChannel.mockRejectedValueOnce(new Error('lost receipt'));
    await publish({ ...job, kind: 'plan-ready', occurrence: '1' });
    await drain();
    await drain();
    const entry = (await inspect()).entries[0]!;
    const queue = { config, home };
    const target = { id: entry.id, marker: entry.claim!.request.marker };
    await expect(resolveOutboxEntry({ ...target, action: 'discard' }, queue)).resolves.toBe('conflict');
    await expect(resolveOutboxEntry({ ...target, action: 'confirm', marker: 'wrong', receipt: { channelId: 'C456' } }, queue)).resolves.toBe('conflict');
    await expect(resolveOutboxEntry({ ...target, action: 'confirm', receipt: { channelId: 'C456' } }, queue)).resolves.toBe('resolved');
    await drain();
    expect(transport.createProjectChannel).toHaveBeenCalledTimes(1);
    expect((await inspect()).channels).toEqual({ 'proj:demo': 'C456' });
  });

  it('can recheck a review claim and retry a definitive failure without resending ambiguous work', async () => {
    transport.postMessage.mockRejectedValueOnce(new Error('lost receipt'));
    transport.postMessage.mockRejectedValueOnce(new OutboxDeliveryError('permanent'));
    await publish(workspace);
    await publish({ ...workspace, occurrence: '2' });
    await drain();
    await drain();
    const queue = { config, home };
    const first = (await inspect()).entries[0]!;
    await expect(resolveOutboxEntry({ id: first.id, action: 'retry' }, queue)).resolves.toBe('conflict');
    await expect(resolveOutboxEntry({ id: first.id, marker: first.claim!.request.marker, action: 'recheck' }, queue)).resolves.toBe('resolved');
    transport.lookupMarker.mockResolvedValueOnce({ status: 'found', ts: '123.9' });
    time += 1000;
    await drain();
    const second = (await inspect()).entries[1]!;
    expect(second.status).toBe('failed');
    await expect(resolveOutboxEntry({ id: second.id, action: 'retry' }, queue)).resolves.toBe('resolved');
    time += 1000;
    await drain();
    expect((await inspect()).entries.map(({ status }) => status)).toEqual(['sent', 'sent']);
    expect(transport.postMessage).toHaveBeenCalledTimes(3);
  });

  it('stops a lane for operator review when a channel creation outcome cannot be established', async () => {
    transport.createProjectChannel.mockRejectedValueOnce(new Error('timeout'));
    await publish({ ...job, kind: 'plan-ready', occurrence: '1' });
    await drain();
    await drain();
    await drain();
    expect(transport.createProjectChannel).toHaveBeenCalledTimes(1);
    expect(transport.postMessage).not.toHaveBeenCalled();
    expect((await inspect()).entries[0]?.status).toBe('review');
  });
});

describe('Slack artifact boundary', () => {
  const spec = { title: 'Demo @channel', summary: 'value redaction-fixture-value <@U234> https://private.example/a', outOfScope: [], tech: [],
    acceptanceChecks: [{ id: 'AC-1', text: 'works' }], extra: 'RAW PRIVATE DATA' };

  it('regenerates the spec from checked fields, binds the artifact to its revision and strips secrets, links and mentions', async () => {
    await writeFile(join(home, 'spec.md'), '# Demo\n');
    await writeFile(join(home, 'spec.json'), JSON.stringify(spec));
    const occurrence = await specRevision(home);
    expect(occurrence).toMatch(/^[a-f0-9]{64}$/);
    const artifact = await prepareSlackArtifact(home, { kind: 'spec', revision: occurrence! }, { KNOWN: 'redaction-fixture-value' });
    const text = artifact?.bytes.toString();
    expect(text).toContain('AC-1');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toMatch(/RAW PRIVATE DATA|redaction-fixture-value|@|https:/);
    await writeFile(join(home, 'spec.md'), '# Revised\n');
    expect(await specRevision(home)).toBe(occurrence);
    expect(await prepareSlackArtifact(home, { kind: 'spec', revision: occurrence! }, {})).toBeDefined();
    await writeFile(join(home, 'spec.json'), JSON.stringify({ ...spec, title: 'Changed generated spec' }));
    expect(await prepareSlackArtifact(home, { kind: 'spec', revision: occurrence! }, {})).toBeUndefined();
  });

  it('redacts a configured secret re-formed by final text cleanup and removes Windows paths', async () => {
    const summary = 'fixture-\u200bprivate-content C:\\Users\\local\\private.txt';
    await writeFile(join(home, 'spec.json'), JSON.stringify({ ...spec, summary }));
    const revision = (await specRevision(home))!;
    const artifact = await prepareSlackArtifact(home, { kind: 'spec', revision }, { KNOWN: 'fixture-private-content' });
    const text = artifact?.bytes.toString();
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('[path removed]');
    expect(text).not.toMatch(/fixture-private-content|private\.txt/);
  });

  it('uploads a sanitized, revision-matched spec in the job thread as the PM', async () => {
    const dir = await createProjectFiles();
    await writeFile(join(dir, 'spec.md'), '# Demo\n');
    await writeFile(join(dir, 'spec.json'), JSON.stringify(spec));
    await publish({ ...job, kind: 'spec-ready', occurrence: (await specRevision(dir))! });
    const loadProjectSecrets = async () => ({ KNOWN: 'redaction-fixture-value' });
    for (let i = 0; i < 3; i++, time += 1000) {
      await drainOutbox({ home, config, transport, now: () => time, loadProjectSecrets });
    }
    expect(transport.uploadArtifact).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: 'pm', channelId: 'C456', threadTs: '123.1', eventTs: '123.2' }),
      expect.objectContaining({ name: 'spec.txt', contentType: 'text/plain' }),
    );
    expect(transport.uploadArtifact.mock.calls[0]?.[1].bytes.toString()).not.toContain('redaction-fixture-value');
  });

  it('uploads a screenshot only after an explicit per-delivery approval and preserves an ambiguous upload claim', async () => {
    const dir = await createProjectFiles();
    await mkdir(join(dir, 'evidence', 'screens'), { recursive: true });
    await writeFile(join(dir, 'evidence', 'screens', 'AC-1.png'), png);
    await publish({ ...job, kind: 'delivery-ready', occurrence: 'delivered-1' });
    for (let i = 0; i < 3; i++, time += 1000) await drain();
    expect(transport.uploadArtifact).not.toHaveBeenCalled();

    const sha256 = digest(png);
    const event = { ...job, kind: 'screenshot-ready', occurrence: `AC-1:${sha256}`, checkId: 'AC-1', sha256 } as const;
    await publish({ ...event, checkId: 'AC-2' });
    await publish(event);
    transport.uploadArtifact.mockRejectedValueOnce(new Error('unknown result'));
    await drain();
    time += 1000;
    await drain();
    expect(transport.uploadArtifact).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: 'qa', channelId: 'C456', threadTs: '123.1' }),
      expect.objectContaining({ name: 'AC-1.png', bytes: png }),
    );
    expect((await inspect()).entries[1]?.claim?.kind).toBe('artifact');
    await drain();
    expect((await inspect()).entries[1]?.status).toBe('review');
    expect(transport.uploadArtifact).toHaveBeenCalledTimes(1);
  });

  it('keeps a required spec pending when prep fails transiently, then uploads without reposting', async () => {
    const dir = await createProjectFiles();
    await writeFile(join(dir, 'spec.json'), JSON.stringify(spec));
    await publish({ ...job, kind: 'spec-ready', occurrence: (await specRevision(dir))! });
    const loadProjectSecrets = vi.fn(async () => ({})).mockRejectedValueOnce(new Error('key store unavailable'));
    const pass = () => drainOutbox({ home, config, transport, now: () => time, loadProjectSecrets });
    for (let i = 0; i < 3; i++, time += 1000) await pass();
    expect((await inspect()).entries[0]?.status).toBe('pending');
    await pass();
    expect((await inspect()).entries[0]?.status).toBe('sent');
    expect(transport.postMessage).toHaveBeenCalledTimes(2);
    expect(transport.uploadArtifact).toHaveBeenCalledTimes(1);
  });

  it('fails closed for invalid required artifacts', async () => {
    const dir = await createProjectFiles();
    await writeFile(join(dir, 'spec.json'), '{}');
    await publish({ ...job, kind: 'spec-ready', occurrence: (await specRevision(dir))! });
    for (let i = 0; i < 3; i++, time += 1000) {
      await drainOutbox({ home, config, transport, now: () => time, loadProjectSecrets: async () => ({}) });
    }
    expect((await inspect()).entries[0]).toMatchObject({ status: 'failed', reason: 'artifact-invalid' });
    expect(transport.uploadArtifact).not.toHaveBeenCalled();
  });

  it('only exports explicitly approved, structurally valid PNG bytes at the fixed QA path', async () => {
    await mkdir(join(home, 'evidence', 'screens'), { recursive: true });
    const screenshot = join(home, 'evidence', 'screens', 'AC-1.png');
    await writeFile(screenshot, png);
    const approval = { kind: 'screenshot', checkId: 'AC-1', sha256: digest(png) } as const;
    expect(await prepareSlackArtifact(home, approval)).toMatchObject({ name: 'AC-1.png', bytes: png });
    expect(await prepareSlackArtifact(home, { ...approval, sha256: '0'.repeat(64) })).toBeUndefined();
    expect(await prepareSlackArtifact(home, { ...approval, checkId: '../AC-1' })).toBeUndefined();
    const bad = Buffer.concat([png, Buffer.from('trailer')]);
    await writeFile(screenshot, bad);
    expect(await prepareSlackArtifact(home, { ...approval, sha256: digest(bad) })).toBeUndefined();
    await rm(screenshot);
    await writeFile(join(home, 'copy.png'), png);
    await symlink(join(home, 'copy.png'), screenshot);
    expect(await prepareSlackArtifact(home, approval)).toBeUndefined();
    await rm(join(home, 'evidence'), { recursive: true });
    await mkdir(join(home, 'other', 'screens'), { recursive: true });
    await writeFile(join(home, 'other', 'screens', 'AC-1.png'), png);
    await symlink(join(home, 'other'), join(home, 'evidence'));
    expect(await prepareSlackArtifact(home, approval)).toBeUndefined();
  });
});

it('reconciles only current eligible checkpoints using the same durable keys as intake', async () => {
  const repo = join(home, 'repo');
  const dir = join(repo, '.anton', 'jobs', '1-init');
  await mkdir(dir, { recursive: true });
  const state = { project: 'demo', jobId: '1-init', stage: 'awaiting_spec_approval', round: 0, maxRounds: 3,
    budgetUsd: 5, spentUsd: 0, warned80: false, completedTasks: [], updatedAt: '' };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await writeFile(join(dir, 'spec.md'), '# Spec\n');
  await writeFile(join(dir, 'spec.json'), '{}');
  const occurrence = (await specRevision(dir))!;
  await publish({ ...job, kind: 'spec-ready', occurrence });
  const deps = { home, loadConfig: async () => config, listProjects: async () => [{ name: 'demo', repoPath: repo }],
    listTags: async () => ['anton/1-init/delivered-2', 'anton/1-init/delivered-10'] };
  await reconcileCheckpoints(deps);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, stage: 'awaiting_final_review' }));
  await reconcileCheckpoints(deps);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, bench: 'bench-1' }));
  await writeFile(join(dir, 'spec.md'), '# Different spec\n');
  await reconcileCheckpoints(deps);
  expect((await inspect()).entries.map((e) => e.event.occurrence)).toEqual([occurrence, 'delivered-10']);
});

it('does not reconstruct a delivery that progresses while the revision is being read', async () => {
  const dir = await createProjectFiles();
  const state = { project: 'demo', jobId: '1-init', stage: 'awaiting_final_review', round: 0, maxRounds: 3,
    budgetUsd: 5, spentUsd: 0, warned80: false, completedTasks: [], updatedAt: '' };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await reconcileCheckpoints({ home, loadConfig: async () => config, listTags: async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, stage: 'done' }));
    return ['anton/1-init/delivered-1'];
  } });
  expect((await inspect()).entries).toHaveLength(0);
});

it('skips a recovered checkpoint after state progresses and sends the next queued milestone', async () => {
  const dir = await createProjectFiles();
  const state = { project: 'demo', jobId: '1-init', stage: 'awaiting_spec_approval', round: 0, maxRounds: 3,
    budgetUsd: 5, spentUsd: 0, warned80: false, completedTasks: [], updatedAt: '' };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await writeFile(join(dir, 'spec.json'), '{}');
  await reconcileCheckpoints({ home, loadConfig: async () => config });
  expect((await inspect()).entries[0]).toMatchObject({ status: 'pending', recovered: true });
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, stage: 'plan' }));
  await publish({ ...job, kind: 'plan-ready', occurrence: 'plan' });
  await drain();
  time += 1000;
  await drain();
  expect((await inspect()).entries.map(({ status }) => status)).toEqual(['skipped', 'sent']);
  expect(transport.postMessage.mock.calls.map(([request]) => request.text)).toEqual(['Job 1', 'Build plan ready']);
});

it('replays captured checkpoints in order after an offline job progresses', async () => {
  const dir = await createProjectFiles();
  const state = { project: 'demo', jobId: '1-init', stage: 'awaiting_spec_approval', round: 0, maxRounds: 3,
    budgetUsd: 5, spentUsd: 0, warned80: false, completedTasks: [], updatedAt: '' };
  const saveStage = (stage: string) => writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, stage }));
  await writeFile(join(dir, 'spec.json'), JSON.stringify({
    title: 'Demo', summary: '', outOfScope: [], tech: [], acceptanceChecks: [{ id: 'AC-1', text: 'Works' }],
  }));
  const occurrence = (await specRevision(dir))!;
  await saveStage('awaiting_spec_approval');
  await publish({ ...job, kind: 'spec-ready', occurrence });
  await reconcileCheckpoints({ home, loadConfig: async () => config });
  await saveStage('plan');
  await publish({ ...job, kind: 'plan-ready', occurrence: 'plan' });
  await saveStage('awaiting_final_review');
  await publish({ ...job, kind: 'delivery-ready', occurrence: 'delivered-1' });
  await saveStage('done');
  await drainOutbox({ home, config, transport, canDeliver: () => false });
  expect(transport.postMessage).not.toHaveBeenCalled();
  for (let i = 0; i < 5; i++, time += 1000) {
    await drainOutbox({ home, config, transport, now: () => time, loadProjectSecrets: async () => ({}) });
  }
  expect((await inspect()).entries.map(({ status, recovered }) => [status, recovered])).toEqual([
    ['sent', undefined], ['sent', undefined], ['sent', undefined],
  ]);
  expect(transport.postMessage.mock.calls.map(([request]) => request.text)).toEqual([
    'Job 1',
    'Spec was prepared for approval. Check the CLI for current status.',
    'Build plan ready',
    'Delivery was prepared for final review. Check the CLI for current status.',
  ]);
  expect(transport.uploadArtifact).toHaveBeenCalledTimes(1);
});

it('promotes a recovered checkpoint when the real capture arrives with the same key', async () => {
  const dir = await createProjectFiles();
  const state = { project: 'demo', jobId: '1-init', stage: 'awaiting_spec_approval', round: 0, maxRounds: 3,
    budgetUsd: 5, spentUsd: 0, warned80: false, completedTasks: [], updatedAt: '' };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await writeFile(join(dir, 'spec.json'), '{}');
  const occurrence = (await specRevision(dir))!;
  await reconcileCheckpoints({ home, loadConfig: async () => config });
  await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, stage: 'plan' }));
  await drain();
  expect((await inspect()).entries[0]).toMatchObject({ recovered: true, status: 'skipped' });
  await publish({ ...job, kind: 'spec-ready', occurrence });
  const entries = (await inspect()).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ status: 'pending' });
  expect(entries[0]?.recovered).toBeUndefined();
  expect(entries[0]?.reason).toBeUndefined();
});
