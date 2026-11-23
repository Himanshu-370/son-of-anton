import { App, LogLevel, SocketModeReceiver, webApi, type Logger } from '@slack/bolt';
import { z } from 'zod';
import { SLACK_ROLES, type SlackConfig, type SlackCredentials, type SlackRole } from './config.js';
import { OutboxDeliveryError, type OutboxMessageRequest, type OutboxTransport } from './outbox.js';
import type { RoleConnection } from './service.js';
import { slackSetupApi } from './setup-api.js';

const quiet: Logger = {
  debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, setName() {},
  getLevel: () => LogLevel.ERROR,
};
const webOptions = {
  logger: quiet,
  timeout: 10_000,
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
};
const uploadReceipt = z.object({ files: z.array(z.object({ files: z.array(z.object({ id: z.string() })) })) });
const unavailable = { status: 'unavailable' } as const;
const rejectedWrite = new Set([
  'account_inactive', 'channel_not_found', 'invalid_arguments', 'invalid_auth', 'invalid_name',
  'is_archived', 'missing_scope', 'name_taken', 'no_permission', 'not_allowed_token_type',
  'not_authed', 'not_in_channel', 'restricted_action', 'token_revoked',
]);

type TransportDeps = {
  client(role: SlackRole): webApi.WebClient;
  verifyChannel(channelId: string, botId: string): Promise<boolean>;
  signal?: AbortSignal;
};

function rateLimit(error: unknown): OutboxDeliveryError | undefined {
  if (!(error instanceof webApi.WebAPIRateLimitedError)) return undefined;
  return new OutboxDeliveryError('retry', error.retryAfter * 1_000);
}

/** The queue owns mutation retries. Network errors can leave an operation accepted at Slack. */
function mutationFailure(error: unknown): never {
  const limited = rateLimit(error);
  if (limited) throw limited;
  if (error instanceof webApi.WebAPIPlatformError && rejectedWrite.has(error.data.error)) {
    throw new OutboxDeliveryError('permanent');
  }
  throw new OutboxDeliveryError('unknown');
}

type SlackTransport = OutboxTransport & {
  confirmParent(request: OutboxMessageRequest, ts: string): Promise<boolean>;
};

const messageIdentity = z.object({
  user: z.string(), ts: z.string(), thread_ts: z.string().optional(),
  metadata: z.object({ event_type: z.literal('anton_delivery'), event_payload: z.object({ marker: z.string() }) }),
});

function matchingMessage(value: unknown, request: OutboxMessageRequest) {
  const message = messageIdentity.safeParse(value).data;
  return message?.user === request.botUserId && message.metadata.event_payload.marker === request.marker ? message : undefined;
}

export function createSlackTransport(config: SlackConfig, deps: TransportDeps): SlackTransport {
  async function verified(request: { teamId: string; channelId: string; botUserId: string; role: SlackRole }): Promise<webApi.WebClient> {
    if (request.teamId !== config.teamId || config.roles[request.role].botUserId !== request.botUserId) {
      throw new OutboxDeliveryError('permanent');
    }
    if (deps.signal?.aborted) throw new OutboxDeliveryError('retry');
    let allowed: boolean;
    try {
      allowed = await deps.verifyChannel(request.channelId, request.botUserId);
    } catch (error) {
      throw rateLimit(error) ?? new OutboxDeliveryError('retry');
    }
    if (!allowed || deps.signal?.aborted) throw new OutboxDeliveryError('retry');
    return deps.client(request.role);
  }

  return {
    async createProjectChannel(request) {
      if (request.teamId !== config.teamId || request.ownerId !== config.ownerId || request.botUserId !== config.roles.pm.botUserId) {
        throw new OutboxDeliveryError('permanent');
      }
      if (deps.signal?.aborted) throw new OutboxDeliveryError('retry');
      const pm = deps.client('pm');
      const { channel } = await pm.conversations.create({ name: request.name, is_private: true }).catch((error: unknown) => {
        if (error instanceof webApi.WebAPIPlatformError && error.data.error === 'name_taken') {
          // A deliberate ID binding can recover this lane. A name alone is never enough.
          throw new OutboxDeliveryError('unknown');
        }
        return mutationFailure(error);
      });
      if (!channel?.id) throw new OutboxDeliveryError('unknown');
      const channelId = channel.id;
      // The channel exists. Persist its ID even if a membership invite is restricted.
      // Before each send, verify that the owner and the sending bot are members.
      const invitees = [config.ownerId, ...SLACK_ROLES.filter((role) => role !== 'pm').map((role) => config.roles[role].botUserId)];
      await pm.conversations.invite({ channel: channelId, users: invitees.join(','), force: true }).catch(() => undefined);
      return { channelId };
    },

    async postMessage(request) {
      const client = await verified(request);
      const response = await client.chat.postMessage({
        channel: request.channelId,
        ...(request.threadTs ? { thread_ts: request.threadTs } : {}),
        text: request.text,
        mrkdwn: false,
        unfurl_links: request.unfurlLinks,
        unfurl_media: request.unfurlMedia,
        metadata: { event_type: 'anton_delivery', event_payload: { marker: request.marker } },
      }).catch(mutationFailure);
      if (!response.ts || response.channel !== request.channelId) throw new OutboxDeliveryError('unknown');
      return { ts: response.ts };
    },

    async lookupMarker(claim) {
      // A channel name alone cannot establish ownership. Uncertain uploads likewise need manual review.
      if (claim.kind === 'channel' || claim.kind === 'artifact') return unavailable;
      const request = claim.request;
      const client = await verified(request);
      const args = { channel: request.channelId, limit: 50, include_all_metadata: true };
      const response = await (request.threadTs
        ? client.conversations.replies({ ...args, ts: request.threadTs })
        : client.conversations.history(args)).catch((error: unknown) => {
        if (error instanceof webApi.WebAPIPlatformError && rejectedWrite.has(error.data.error)) return undefined;
        throw rateLimit(error) ?? new OutboxDeliveryError('retry');
      });
      const matching = response?.messages?.flatMap((message) => matchingMessage(message, request)?.ts ?? []);
      if (matching?.length === 1 && matching[0]) return { status: 'found', ts: matching[0] };
      // Missing from a bounded or lagging read does not establish that Slack did not accept it.
      return unavailable;
    },

    async confirmParent(request, ts) {
      if (request.threadTs !== undefined || request.role !== 'pm' || !/^\d{1,16}\.\d{1,6}$/.test(ts)) return false;
      const client = await verified(request);
      const { messages } = await client.conversations.history({
        channel: request.channelId, oldest: ts, latest: ts, inclusive: true, limit: 1, include_all_metadata: true,
      });
      const parent = matchingMessage(messages?.[0], request);
      return parent?.ts === ts && (parent.thread_ts === undefined || parent.thread_ts === ts);
    },

    async uploadArtifact(request, artifact) {
      const client = await verified(request);
      const result = await client.files.uploadV2({
        file: artifact.bytes, filename: artifact.name, title: artifact.name,
        channel_id: request.channelId, thread_ts: request.threadTs, initial_comment: request.marker,
      }).catch(mutationFailure);
      const fileId = uploadReceipt.safeParse(result).data?.files[0]?.files[0]?.id;
      if (!fileId) throw new OutboxDeliveryError('unknown');
      return { fileId };
    },
  };
}

export function createSlackRuntime(config: SlackConfig, credentials: SlackCredentials) {
  const clients = new Map(SLACK_ROLES.map((role) => [
    role, new webApi.WebClient(credentials[role].botToken, webOptions),
  ]));

  async function open(role: SlackRole, signal: AbortSignal): Promise<RoleConnection> {
    const { appToken, botToken } = credentials[role];
    const expected = config.roles[role];
    const auth = await clients.get(role)!.auth.test();
    const appId = auth.app_id ?? (auth.bot_id
      ? (await clients.get(role)!.bots.info({ bot: auth.bot_id })).bot?.app_id
      : undefined);
    if (auth.team_id !== config.teamId || auth.user_id !== expected.botUserId || !auth.bot_id
      || appId !== expected.appId || auth.is_enterprise_install) {
      throw new Error('Slack bot identity changed.');
    }
    signal.throwIfAborted();
    const receiver = new SocketModeReceiver({
      appToken, logger: quiet, autoReconnectEnabled: false, installerOptions: { clientOptions: webOptions },
    });
    const app = new App({
      receiver, token: botToken, botId: auth.bot_id, botUserId: expected.botUserId,
      tokenVerificationEnabled: false, logger: quiet, clientOptions: webOptions,
    });
    if (role === 'pm') app.command('/anton', async ({ ack }) => {
      await ack({ response_type: 'ephemeral', text: 'Use the Anton CLI to manage jobs.' });
    });

    let connected = false;
    let closed = false;
    receiver.client.on('connected', () => { connected = true; });
    receiver.client.on('disconnected', () => { connected = false; closed = true; });
    receiver.client.on('disconnecting', () => { connected = false; });
    let stopping: Promise<void> | undefined;
    // We own reconnects. Await the actual SocketModeClient disconnect rather than Bolt's early return.
    const stop = () => stopping ??= closed ? Promise.resolve() : receiver.client.disconnect();
    const onAbort = () => { void stop().catch(() => undefined); };
    const opening = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    opening.addEventListener('abort', onAbort, { once: true });
    try {
      await app.start();
      opening.throwIfAborted();
    } catch (error) {
      await stop().catch(() => undefined);
      throw error;
    } finally {
      opening.removeEventListener('abort', onAbort);
    }
    return { connected: () => connected, closed: () => closed, stop };
  }

  return {
    open,
    transport(signal: AbortSignal): SlackTransport {
      return createSlackTransport(config, {
        client: (role) => clients.get(role)!,
        signal,
        async verifyChannel(channelId, botId) {
          const pm = credentials.pm.botToken;
          const channel = await slackSetupApi.channelInfo(pm, channelId);
          if (!channel?.isPrivate || channel.isShared || channel.isArchived
            || (channel.teamId !== undefined && channel.teamId !== config.teamId)) return false;
          const members = await slackSetupApi.channelMembers(pm, channelId);
          return members.includes(config.ownerId) && members.includes(botId);
        },
      });
    },
  };
}
