import { antonHome } from '../../core/paths.js';
import { SLACK_ROLES, loadSlackConfig, loadSlackCredentials } from '../../slack/config.js';
import { drainOutbox, inspectOutbox, resolveOutboxEntry, type OutboxResolution } from '../../slack/outbox.js';
import { reconcileCheckpoints } from '../../slack/reconcile.js';
import { attachCardMessage, dispatchSlackAction, prepareCardModal, type DispatchDeps } from '../../slack/actions.js';
import { composeSlackMessage, remindPendingSpecs } from '../../slack/spec-session.js';
import { collectRetros } from '../../retro/run.js';
import { createInboundHandler } from '../../slack/inbound.js';
import { startSlackService } from '../../slack/service.js';
import { createSlackRuntime } from '../../slack/transport.js';
import { guard, resolveDeps, type CliDeps } from '../deps.js';

/**
 * Retro collection runs beside delivery, never inside it: `tick` starts one collection when it is due and
 * none is running, and returns at once, so a slow or hung batch fetch cannot delay Slack messages or reminders.
 */
export function retroCollector(collect: () => Promise<unknown>, opts: { intervalMs?: number; now?: () => number } = {}) {
  const interval = opts.intervalMs ?? 15 * 60_000;
  const now = opts.now ?? Date.now;
  let next = 0;
  let running: Promise<void> | undefined;
  return {
    tick(): void {
      if (running || now() < next) return;
      next = now() + interval;
      running = Promise.resolve()
        .then(collect)
        .then(() => undefined, () => undefined)
        .finally(() => { running = undefined; });
    },
    running: () => running !== undefined,
    /** Wait for a running collection, at most `ms` (service stop). */
    async settle(ms: number): Promise<void> {
      if (running) await Promise.race([running, new Promise((r) => setTimeout(r, ms).unref())]);
    },
  };
}

export async function serveCommand(deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const home = antonHome();
    const config = await loadSlackConfig(home);
    const credentials = config && await loadSlackCredentials(home);
    if (!config || !credentials) {
      d.err('Run anton slack setup before starting the Slack service.');
      return 1;
    }
    // Slack orders run the same job actions as the CLI, in this process, with its effects.
    // Spec turns (the PM in Docker) run here too, with the same effects as anton new and anton spec.
    const dispatchDeps: DispatchDeps = {
      config, home,
      jobs: { preflight: d.preflight, spawnRun: d.spawnRun, stopContainer: d.stopContainer, retro: d.retro },
      spec: {
        home, preflight: d.preflight, ensureImage: d.ensureImage, startContainer: d.startContainer, stopContainer: d.stopContainer,
        runAgent: d.runAgent, ensureRepoMap: d.ensureRepoMap, listFiles: d.listFiles, readHistory: d.readHistory,
      },
    };
    const inbound = createInboundHandler({
      log: d.out,
      dispatch: (action) => dispatchSlackAction(action, dispatchDeps),
      prepareModal: (action) => prepareCardModal(action, dispatchDeps),
    });
    const runtime = createSlackRuntime(config, credentials, inbound);
    let reconcileAt = 0;
    // Finished Retros queue their proposals here, so the coach can post lesson cards without the CLI.
    // Collecting reads submitted batches; it starts no new model call.
    const retros = retroCollector(() => collectRetros({ ...d.retro, out: () => undefined }));
    const service = await startSlackService({
      home, roles: SLACK_ROLES, open: runtime.open, log: d.out,
      async drain(connected, signal, canDeliver) {
        if (signal.aborted) return;
        if (Date.now() >= reconcileAt) {
          await reconcileCheckpoints({ home, loadConfig: async () => config });
          await remindPendingSpecs({ home }).catch(() => undefined);
          reconcileAt = Date.now() + 60_000;
        }
        retros.tick();
        if (!connected.size) return;
        await drainOutbox({
          home, config, signal,
          canDeliver,
          transport: runtime.transport(signal),
          compose: (event, channelId) => composeSlackMessage(event, { config, home, channelId }),
          attachCards: async (tokens, channelId, ts) => {
            for (const token of tokens) {
              if (!(await attachCardMessage(token, channelId, ts, { home }))) throw new Error('card binding failed');
            }
          },
        });
      },
    });
    await new Promise<void>((resolve) => {
      const clean = () => {
        removeSigint();
        process.off('SIGTERM', clean);
        resolve();
      };
      const removeSigint = d.onSigint(clean);
      process.once('SIGTERM', clean);
    }).finally(async () => {
      await service.stop();
      // Let accepted actions finish their local work; their records make a redelivery safe either way.
      await inbound.idle();
      await retros.settle(5_000);
    });
    return 0;
  });
}

export async function slackOutboxStatusCommand(deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const config = await loadSlackConfig();
    if (!config) {
      d.err('Run anton slack setup first.');
      return 1;
    }
    const { entries } = await inspectOutbox({ config });
    for (const status of ['pending', 'sent', 'failed', 'review', 'skipped'] as const) {
      const matching = entries.filter((entry) => entry.status === status);
      d.out(`${status}: ${matching.length}`);
      if (status === 'failed' || status === 'review') {
        for (const { id, event, claim, reason } of matching) {
          const target = event.scope === 'job' ? `${event.project}/${event.jobId}` : '#anton';
          d.out(`- ${id} ${target} ${event.kind}${claim ? ` (${claim.kind})` : ''}${reason ? ` — ${reason}` : ''}`);
        }
      }
    }
    return 0;
  });
}

export async function slackOutboxResolveCommand(
  action: string, id: string, options: { channelId?: string; timestamp?: string }, deps: CliDeps = {},
): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const { channelId, timestamp } = options;
    if (!['retry', 'recheck', 'discard', 'bind-channel', 'confirm-thread'].includes(action)) {
      throw new Error('Choose retry, recheck, discard, bind-channel or confirm-thread.');
    }
    const config = await loadSlackConfig();
    if (!config) throw new Error('Run anton slack setup first.');
    let resolution: OutboxResolution;
    if (action === 'retry') {
      resolution = { action, id };
    } else {
      const { entries } = await inspectOutbox({ config });
      const claim = entries.find((entry) => entry.id === id && entry.status === 'review')?.claim;
      if (!claim) throw new Error('No matching delivery is waiting for review.');
      const marker = claim.request.marker;
      if (action === 'bind-channel') {
        if (claim.kind !== 'channel' || !channelId || !/^[CG][A-Z0-9]{2,31}$/.test(channelId) || channelId === config.channelId) {
          throw new Error('Supply the intended private project channel ID for this channel creation.');
        }
        const credentials = await loadSlackCredentials();
        if (!credentials) throw new Error('Run anton slack setup first.');
        const { slackSetupApi } = await import('../../slack/setup-api.js');
        const token = credentials.pm.botToken;
        const channel = await slackSetupApi.channelInfo(token, channelId).catch(() => undefined);
        if (!channel || channel.id !== channelId || !channel.isPrivate || channel.isShared || channel.isArchived
          || channel.name !== claim.request.name || (channel.teamId !== undefined && channel.teamId !== config.teamId)) {
          throw new Error('Slack could not verify the requested private project channel.');
        }
        const members = await slackSetupApi.channelMembers(token, channelId).catch((): string[] => []);
        if (!members.includes(config.ownerId) || !members.includes(config.roles.pm.botUserId)) {
          throw new Error('The owner and Anton PM must already be members of that channel.');
        }
        resolution = { action: 'confirm', id, marker, receipt: { channelId } };
      } else if (action === 'confirm-thread') {
        if (claim.kind !== 'thread' || !timestamp) throw new Error('Supply the suspected parent message timestamp.');
        const credentials = await loadSlackCredentials();
        if (!credentials) throw new Error('Run anton slack setup first.');
        const transport = createSlackRuntime(config, credentials).transport(AbortSignal.timeout(20_000));
        const confirmed = await transport.confirmParent(claim.request, timestamp).catch(() => false);
        if (!confirmed) throw new Error('Slack could not verify the parent message, sender and delivery marker.');
        resolution = { action: 'confirm', id, marker, receipt: { ts: timestamp } };
      } else {
        resolution = { action: action === 'recheck' ? 'recheck' : 'discard', id, marker };
      }
    }
    const result = await resolveOutboxEntry(resolution, { config });
    if (result !== 'resolved') throw new Error('That update is missing or has changed. Check anton slack outbox.');
    d.out('Slack outbox updated.');
    return 0;
  });
}
