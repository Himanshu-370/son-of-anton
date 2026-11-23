import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { antonHome, jobDir } from '../core/paths.js';
import { loadSecrets } from '../core/secrets.js';
import { SLACK_ROLES, channelIdSchema, slackDirectory, teamIdSchema, userIdSchema, type SlackConfig, type SlackRole } from './config.js';
import { ArtifactPreparationError, requireCheckedFile, requireSlackArtifact, type ArtifactSelection, type SlackArtifact } from './artifacts.js';
import { MilestoneSchema, eventRole, eventText, type Milestone } from './events.js';
import { acquireOutboxLock, OutboxLockBusy } from './outbox-lock.js';
import { checkpointFreshness, registeredProjects } from './reconcile.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const teamId = teamIdSchema.max(32);
const userId = userIdSchema.max(32);
const channelId = channelIdSchema.max(32);
const fileId = z.string().regex(/^F[A-Z0-9]{2,31}$/);
const ts = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
const role = z.enum(SLACK_ROLES);
const marker = z.string().regex(/^anton-[a-f0-9]{64}$/);
const channelRequest = z.strictObject({
  teamId, ownerId: userId, botUserId: userId, role: z.literal('pm'), name: z.string().regex(/^proj-[a-z0-9-]{1,72}$/), marker,
});
const destination = { teamId, channelId, role, botUserId: userId, marker };
const messageRequest = z.strictObject({
  ...destination, threadTs: ts.optional(), text: z.string().max(200), unfurlLinks: z.literal(false), unfurlMedia: z.literal(false),
});
const uploadRequest = z.strictObject({ ...destination, threadTs: ts, eventTs: ts });
const claimSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('channel'), request: channelRequest }),
  z.strictObject({ kind: z.literal('thread'), request: messageRequest }),
  z.strictObject({ kind: z.literal('message'), request: messageRequest }),
  z.strictObject({ kind: z.literal('artifact'), request: uploadRequest }),
]);

export type OutboxClaim = z.infer<typeof claimSchema>;
export type ProjectChannelRequest = z.infer<typeof channelRequest>;
export type OutboxMessageRequest = z.infer<typeof messageRequest>;
export type OutboxArtifactRequest = z.infer<typeof uploadRequest>;
export type MarkerLookup =
  | { status: 'found'; channelId: string }
  | { status: 'found'; ts: string }
  | { status: 'found'; fileId: string }
  | { status: 'retry'; retryAfterMs?: number }
  | { status: 'absent' }
  | { status: 'unavailable' };

export interface OutboxTransport {
  /** Create a private, workspace-local channel. Return only its verified ID. */
  createProjectChannel(request: ProjectChannelRequest): Promise<{ channelId: string }>;
  /** Verify the workspace, conversation privacy and owning bot before exposing project data. */
  postMessage(request: OutboxMessageRequest): Promise<{ ts: string }>;
  /** Bound the read by destination and owning bot. Return absent only if non-delivery is established. */
  lookupMarker(claim: OutboxClaim): Promise<MarkerLookup>;
  /** Upload to the verified thread, carrying the exact marker for any subsequent reconciliation. */
  uploadArtifact?(request: OutboxArtifactRequest, artifact: SlackArtifact): Promise<{ fileId: string }>;
}

export class OutboxDeliveryError extends Error {
  /** On writes, retry and permanent require positive evidence Slack did not perform the operation. */
  constructor(public readonly outcome: 'retry' | 'permanent' | 'unknown', public readonly retryAfterMs?: number) {
    super(outcome);
    this.name = 'OutboxDeliveryError';
  }
}

const selectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('spec'), revision: digest }),
  z.strictObject({ kind: z.literal('screenshot'), checkId: z.string().regex(/^AC-[1-9]\d{0,5}$/), sha256: digest }),
]);
const entrySchema = z.strictObject({
  id: digest, event: MilestoneSchema, status: z.enum(['pending', 'sent', 'failed', 'review', 'skipped']),
  attempts: z.number().int().min(0), nextAt: z.number().min(0),
  claim: claimSchema.optional(), messageTs: ts.optional(),
  recovered: z.literal(true).optional(),
  lookupAttempts: z.number().int().min(0).optional(),
  prepAttempts: z.number().int().min(0).optional(),
  reason: z.enum(['artifact-invalid', 'artifact-unavailable', 'stale-checkpoint', 'discarded']).optional(),
  artifact: z.strictObject({ selection: selectionSchema, sha256: digest }).optional(),
});
const storeSchema = z.strictObject({
  version: z.literal(1),
  entries: z.array(entrySchema),
  channels: z.record(z.string(), channelId),
  threads: z.record(z.string(), ts),
  channelReady: z.record(z.string(), z.number().min(0)),
  roleReady: z.partialRecord(role, z.number().min(0)),
});
type Store = z.infer<typeof storeSchema>;
type Entry = z.infer<typeof entrySchema>;
export type OutboxReceipt = { channelId: string } | { ts: string } | { fileId: string };

interface QueueLocation {
  config: SlackConfig;
  home?: string;
}

export interface DrainOutboxDeps extends QueueLocation {
  transport: OutboxTransport;
  now?: () => number;
  canDeliver?: (role: SlackRole) => boolean;
  /** Stops taking new claims. The transport owns the timeout or cancellation of an active request. */
  signal?: AbortSignal;
  loadProjectSecrets?: (project: string, home: string) => Promise<Record<string, string>>;
}

const MAX_ATTEMPTS = 5;
const LIMIT_PER_DRAIN = 100;
const MESSAGE_INTERVAL_MS = 1_000;
const LOCK_WAIT_MS = 5_000;

interface StoreLocation {
  root: string;
  path: string;
}

async function openQueue({ home = antonHome(), config }: QueueLocation): Promise<StoreLocation> {
  const filename = `outbox-${teamId.parse(config.teamId)}-${channelId.parse(config.channelId)}.json`;
  const root = (await slackDirectory(home, true))!;
  return { root, path: join(root, filename) };
}

async function readStore(path: string): Promise<Store> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!file) return { version: 1, entries: [], channels: {}, threads: {}, channelReady: {}, roleReady: {} };
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600) {
      throw new Error('Slack outbox must be an owner-only regular file');
    }
    return storeSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
}

async function writeStore(path: string, store: Store): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(store) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
    const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

async function lockQueue(root: string): Promise<() => Promise<void>> {
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return await acquireOutboxLock(root, 'write');
    } catch (error) {
      if (!(error instanceof OutboxLockBusy) || performance.now() >= deadline) throw error;
      await delay(10);
    }
  }
}

async function updateStore(loc: StoreLocation, mutate: (store: Store) => false | void): Promise<void> {
  const release = await lockQueue(loc.root);
  try {
    const store = await readStore(loc.path);
    if (mutate(store) !== false) await writeStore(loc.path, store);
  } finally {
    await release();
  }
}

function eventId(event: Milestone): string {
  return hash(JSON.stringify([
    event.scope === 'job' ? event.project : null, event.scope === 'job' ? event.jobId : null,
    eventRole(event), event.kind, event.occurrence,
  ]));
}

export async function enqueueMilestone(event: Milestone, queue: QueueLocation, options?: { recovered: true }): Promise<void> {
  const checked = MilestoneSchema.parse(event);
  if (checked.scope === 'job' && checked.source === 'bench') return;
  const loc = await openQueue(queue);
  const id = eventId(checked);
  await updateStore(loc, (store) => {
    const existing = store.entries.find((entry) => entry.id === id);
    if (existing) {
      if (!existing.recovered || options?.recovered) return false;
      delete existing.recovered;
      if (existing.status === 'skipped' && existing.reason === 'stale-checkpoint') {
        existing.status = 'pending';
        existing.nextAt = 0;
        delete existing.reason;
      }
      return;
    }
    store.entries.push({
      id, event: checked, status: 'pending', attempts: 0, nextAt: 0,
      ...(options?.recovered ? { recovered: true } : {}),
    });
  });
}

export async function inspectOutbox(queue: QueueLocation): Promise<Store> {
  const loc = await openQueue(queue);
  return readStore(loc.path);
}

/**
 * The project whose channel Anton created (or the owner bound by ID) as `channelId`. Names are never used:
 * a channel Anton did not record maps to no project.
 */
export async function projectForChannel(queue: QueueLocation, channel: string): Promise<string | undefined> {
  if (!channelId.safeParse(channel).success || channel === queue.config.channelId) return undefined;
  const { channels } = await inspectOutbox(queue);
  const lanes = Object.entries(channels).filter(([lane, id]) => id === channel && lane.startsWith('proj:'));
  return lanes.length === 1 ? lanes[0]![0].slice('proj:'.length) : undefined;
}

const laneKey = (event: Milestone) => event.scope === 'workspace' ? '#anton' : `proj:${event.project}`;
const threadKey = (event: Extract<Milestone, { scope: 'job' }>) => `${laneKey(event)}:${event.jobId}`;
const markerFor = (...key: string[]) => `anton-${hash(JSON.stringify(key))}`;

function nextEntry(store: Store, deps: DrainOutboxDeps, now: number, skipped: Set<string>): Entry | undefined {
  const { config, canDeliver } = deps;
  const occupied = new Set(skipped);
  for (const entry of store.entries) {
    if (entry.status === 'sent' || entry.status === 'failed' || entry.status === 'skipped') continue;
    const event = entry.event;
    const lane = laneKey(event);
    if (occupied.has(lane)) continue;
    occupied.add(lane);
    if (entry.status === 'review' || entry.nextAt > now) continue;
    if (entry.claim) {
      if (canDeliver?.(entry.claim.request.role) !== false) return entry;
      continue;
    }
    const channel = event.scope === 'workspace' ? config.channelId : store.channels[lane];
    const hasParent = event.scope === 'workspace' || store.threads[threadKey(event)] !== undefined;
    const sender = channel && hasParent ? eventRole(event) : 'pm';
    if (canDeliver?.(sender) !== false && (store.roleReady[sender] ?? 0) <= now && (!channel || (store.channelReady[channel] ?? 0) <= now)) return entry;
  }
  return undefined;
}

type Operation = { claim: OutboxClaim; artifact?: SlackArtifact; savedArtifact?: Entry['artifact'] };

const needsArtifact = (event: Milestone) => event.kind === 'spec-ready' || event.kind === 'screenshot-ready';

async function artifactOperation(
  entry: Entry, deps: DrainOutboxDeps, request: OutboxArtifactRequest,
): Promise<Operation> {
  const { event } = entry;
  if (!deps.transport.uploadArtifact) throw new ArtifactPreparationError('artifact-unavailable');
  let selection: ArtifactSelection;
  if (event.kind === 'spec-ready') selection = { kind: 'spec', revision: event.occurrence };
  else if (event.kind === 'screenshot-ready') selection = { kind: 'screenshot', checkId: event.checkId, sha256: event.sha256 };
  else throw new ArtifactPreparationError('artifact-invalid');
  const home = deps.home ?? antonHome();
  const project = (await registeredProjects(home)).find(({ name }) => name === event.project);
  if (!project) throw new ArtifactPreparationError('artifact-unavailable');
  const stateBytes = await requireCheckedFile(project.repoPath, ['.anton', 'jobs', event.jobId, 'state.json'], 256 * 1024);
  const state = z.object({ jobId: z.literal(event.jobId), project: z.literal(event.project), bench: z.never().optional() })
    .safeParse(JSON.parse(stateBytes.toString('utf8')));
  if (!state.success) throw new ArtifactPreparationError('artifact-invalid');
  let secrets: Record<string, string> | undefined;
  if (selection.kind === 'spec') {
    if (deps.loadProjectSecrets) secrets = await deps.loadProjectSecrets(event.project, home);
    else if (home === antonHome()) secrets = await loadSecrets(event.project);
  }
  const artifact = await requireSlackArtifact(jobDir(project.repoPath, event.jobId), selection, secrets);
  const sha256 = hash(artifact.bytes);
  if (entry.artifact && entry.artifact.sha256 !== sha256) throw new ArtifactPreparationError('artifact-invalid');
  return { claim: { kind: 'artifact', request }, artifact, savedArtifact: { selection, sha256 } };
}

async function nextOperation(entry: Entry, store: Store, deps: DrainOutboxDeps): Promise<Operation | undefined> {
  const { config } = deps;
  const { event } = entry;
  const lane = laneKey(event);
  const key = event.scope === 'job' ? threadKey(event) : undefined;
  const channel = event.scope === 'job' ? store.channels[lane] : config.channelId;
  const identity = [config.teamId, config.channelId];
  if (!channel && event.scope === 'job') {
    return { claim: { kind: 'channel', request: {
      teamId: config.teamId, ownerId: config.ownerId, botUserId: config.roles.pm.botUserId, role: 'pm', name: `proj-${event.project}`,
      marker: markerFor(...identity, 'channel', lane),
    } } };
  }
  if (!channel) return undefined;
  const parent = key ? store.threads[key] : undefined;
  const threadNeeded = key && !parent;
  const sender = threadNeeded ? 'pm' : eventRole(event);
  const dest = { teamId: config.teamId, channelId: channel, role: sender, botUserId: config.roles[sender].botUserId };
  const flags = { unfurlLinks: false, unfurlMedia: false } as const;
  if (threadNeeded && event.scope === 'job') {
    return { claim: { kind: 'thread', request: {
      ...dest, ...flags, text: `Job ${event.jobId.split('-')[0]}`, marker: markerFor(...identity, 'thread', channel, key),
    } } };
  }
  if (!entry.messageTs) {
    return { claim: { kind: 'message', request: {
      ...dest, ...flags, ...(parent ? { threadTs: parent } : {}), text: eventText(event),
      marker: markerFor(...identity, 'message', entry.id),
    } } };
  }
  if (!parent) return undefined;
  return artifactOperation(entry, deps, {
    ...dest, threadTs: parent, eventTs: entry.messageTs, marker: markerFor(...identity, 'artifact', entry.id),
  });
}

function acknowledge(store: Store, entry: Entry, claim: OutboxClaim, receipt: OutboxReceipt, config: SlackConfig): boolean {
  if (!receipt || typeof receipt !== 'object') return false;
  const lane = laneKey(entry.event);
  if (claim.kind === 'channel') {
    if (!('channelId' in receipt) || !channelId.safeParse(receipt.channelId).success ||
        receipt.channelId === config.channelId || Object.values(store.channels).includes(receipt.channelId)) return false;
    store.channels[lane] = receipt.channelId;
  } else if (claim.kind === 'artifact') {
    if (!('fileId' in receipt) || !fileId.safeParse(receipt.fileId).success) return false;
    entry.status = 'sent';
  } else {
    if (!('ts' in receipt) || !ts.safeParse(receipt.ts).success) return false;
    if (claim.kind === 'thread') {
      if (entry.event.scope !== 'job') return false;
      store.threads[threadKey(entry.event)] = receipt.ts;
    } else {
      entry.messageTs = receipt.ts;
      if (!needsArtifact(entry.event)) entry.status = 'sent';
    }
  }
  delete entry.claim;
  delete entry.lookupAttempts;
  delete entry.prepAttempts;
  entry.attempts = 0;
  entry.nextAt = 0;
  return true;
}

async function send(transport: OutboxTransport, operation: Operation): Promise<OutboxReceipt> {
  const { claim } = operation;
  switch (claim.kind) {
    case 'channel': return transport.createProjectChannel(claim.request);
    case 'thread':
    case 'message': return transport.postMessage(claim.request);
    case 'artifact': return transport.uploadArtifact!(claim.request, operation.artifact!);
  }
}

function defer(store: Store, entry: Entry, claim: OutboxClaim, now: number, retryAfterMs?: number): void {
  delete entry.claim;
  delete entry.lookupAttempts;
  const retryAfter = retryDelay(retryAfterMs);
  entry.nextAt = now + backoff(entry.attempts, retryAfter);
  if (retryAfter) store.roleReady[claim.request.role] = Math.max(store.roleReady[claim.request.role] ?? 0, now + retryAfter);
  if (entry.attempts >= MAX_ATTEMPTS) entry.status = 'failed';
}

const retryDelay = (ms?: number) => ms !== undefined && Number.isFinite(ms) && ms >= 0 ? ms : 0;
const backoff = (attempt: number, retryAfter?: number) => Math.max(MESSAGE_INTERVAL_MS * 2 ** (attempt - 1), retryDelay(retryAfter));

function claimMatchesConfig(claim: OutboxClaim, config: SlackConfig): boolean {
  const { request } = claim;
  return request.teamId === config.teamId && request.botUserId === config.roles[request.role].botUserId &&
    (claim.kind !== 'channel' || claim.request.ownerId === config.ownerId);
}

async function reconcileClaim(deps: DrainOutboxDeps, claim: OutboxClaim): Promise<MarkerLookup> {
  if (!claimMatchesConfig(claim, deps.config)) return { status: 'unavailable' };
  try {
    return await deps.transport.lookupMarker(claim);
  } catch (error) {
    if (error instanceof OutboxDeliveryError && error.outcome === 'retry') {
      return { status: 'retry', retryAfterMs: error.retryAfterMs };
    }
    return { status: 'unavailable' };
  }
}

export type OutboxResolution =
  | { id: string; action: 'retry' }
  | { id: string; marker: string; action: 'recheck' | 'discard' }
  | { id: string; marker: string; action: 'confirm'; receipt: OutboxReceipt };

/** Confirm only after verifying the receipt belongs to the recorded destination and operation. */
export async function resolveOutboxEntry(
  input: OutboxResolution, queue: QueueLocation,
): Promise<'resolved' | 'not-found' | 'conflict'> {
  const loc = await openQueue(queue);
  let result: 'resolved' | 'not-found' | 'conflict' = 'not-found';
  await updateStore(loc, (store) => {
    const entry = store.entries.find(({ id }) => id === input.id);
    if (!entry) return false;
    result = 'conflict';
    if (input.action === 'retry') {
      if (entry.status !== 'failed' || entry.claim) return false;
      entry.status = 'pending';
      entry.attempts = 0;
      delete entry.prepAttempts;
      delete entry.reason;
    } else {
      const { claim } = entry;
      if (entry.status !== 'review' || !claim || claim.request.marker !== input.marker) return false;
      if (input.action === 'confirm') {
        if (!claimMatchesConfig(claim, queue.config) || !acknowledge(store, entry, claim, input.receipt, queue.config)) return false;
      } else if (input.action === 'discard') {
        if (claim.kind === 'channel' || claim.kind === 'thread') return false;
        entry.status = 'skipped';
        entry.reason = 'discarded';
      }
      if (entry.status === 'review') entry.status = 'pending';
      delete entry.lookupAttempts;
    }
    entry.nextAt = 0;
    result = 'resolved';
  });
  return result;
}

export async function drainOutbox(deps: DrainOutboxDeps): Promise<void> {
  if (deps.signal?.aborted) return;
  const loc = await openQueue(deps);
  let release: () => Promise<void>;
  try {
    release = await acquireOutboxLock(loc.root, 'drain');
  } catch (error) {
    if (error instanceof OutboxLockBusy) return;
    throw error;
  }
  const now = deps.now ?? Date.now;
  const skipped = new Set<string>();
  try {
    for (let i = 0; i < LIMIT_PER_DRAIN && !deps.signal?.aborted; i++) {
      const store = await readStore(loc.path);
      const entry = nextEntry(store, deps, now(), skipped);
      if (!entry || deps.signal?.aborted) break;
      const update = (mutate: (snapshot: Store, current: Entry) => void) =>
        updateStore(loc, (snapshot) => mutate(snapshot, snapshot.entries.find((item) => item.id === entry.id)!));
      if (entry.claim) {
        const claim = entry.claim;
        const result = await reconcileClaim(deps, claim);
        if (deps.signal?.aborted && (result.status === 'unavailable' || result.status === 'retry')) break;
        await update((snapshot, current) => {
          if (result.status === 'found' && acknowledge(snapshot, current, claim, result, deps.config)) return;
          if (result.status === 'retry') {
            current.lookupAttempts = (current.lookupAttempts ?? 0) + 1;
            current.nextAt = now() + backoff(current.lookupAttempts, result.retryAfterMs);
            if (current.lookupAttempts >= MAX_ATTEMPTS) current.status = 'review';
          } else if (result.status === 'absent') defer(snapshot, current, claim, now());
          else current.status = 'review';
        });
        continue;
      }
      if (entry.recovered) {
        const freshness = await checkpointFreshness(entry.event, deps.home ?? antonHome());
        if (freshness === 'stale') {
          await update((_snapshot, current) => {
            // A captured event may have arrived while the recovered entry was being checked.
            if (current.recovered) {
              current.status = 'skipped';
              current.reason = 'stale-checkpoint';
            }
          });
          continue;
        }
        if (freshness === 'unknown') {
          skipped.add(laneKey(entry.event));
          continue;
        }
      }
      let operation: Operation | undefined;
      try {
        operation = await nextOperation(entry, store, deps);
      } catch (error) {
        const reason = error instanceof ArtifactPreparationError ? error.reason : 'artifact-unavailable';
        await update((_snapshot, current) => {
          current.prepAttempts = (current.prepAttempts ?? 0) + 1;
          if (reason === 'artifact-invalid' || current.prepAttempts >= MAX_ATTEMPTS) {
            current.status = 'failed';
            current.reason = reason;
          } else current.nextAt = now() + backoff(current.prepAttempts);
        });
        continue;
      }
      if (!operation) {
        await update((_snapshot, current) => { current.status = 'failed'; });
        continue;
      }
      const { claim } = operation;
      if (deps.signal?.aborted) break;
      if (deps.canDeliver?.(claim.request.role) === false) {
        skipped.add(laneKey(entry.event));
        continue;
      }
      claimSchema.parse(claim);
      await update((snapshot, current) => {
        current.claim = claim;
        delete current.prepAttempts;
        current.attempts++;
        if (operation.savedArtifact) current.artifact = operation.savedArtifact;
        if (claim.kind !== 'channel') snapshot.channelReady[claim.request.channelId] = now() + MESSAGE_INTERVAL_MS;
      });
      if (deps.signal?.aborted || deps.canDeliver?.(claim.request.role) === false) {
        await update((snapshot, current) => {
          delete current.claim;
          current.attempts--;
          if (claim.kind !== 'channel') {
            const channel = claim.request.channelId;
            const previous = store.channelReady[channel];
            if (previous === undefined) delete snapshot.channelReady[channel];
            else snapshot.channelReady[channel] = previous;
          }
        });
        skipped.add(laneKey(entry.event));
        continue;
      }
      let receipt: OutboxReceipt;
      try {
        receipt = await send(deps.transport, operation);
      } catch (error) {
        if (!(error instanceof OutboxDeliveryError) || error.outcome === 'unknown') {
          skipped.add(laneKey(entry.event));
          continue; // The persisted claim is the next worker's reconciliation input.
        }
        await update((snapshot, current) => {
          if (error.outcome === 'retry') defer(snapshot, current, claim, now(), error.retryAfterMs);
          else {
            current.status = 'failed';
            delete current.claim;
          }
        });
        continue;
      }
      await update((snapshot, current) => {
        if (!acknowledge(snapshot, current, claim, receipt, deps.config)) skipped.add(laneKey(current.event));
      });
    }
  } finally {
    await release();
  }
}
