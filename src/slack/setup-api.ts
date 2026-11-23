import { LogLevel, webApi, type Logger } from '@slack/bolt';
import { z } from 'zod';
import { AppCreateRejected, type SlackSetupApi } from './setup.js';

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  setLevel() {},
  setName() {},
  getLevel: () => LogLevel.ERROR,
};

const client = (token: string, timeout = 15_000) => new webApi.WebClient(token, {
  logger,
  timeout,
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
});

const rejectedAppCreate = new Set([
  'invalid_manifest', 'invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'missing_scope',
  'not_allowed_token_type', 'team_not_found', 'access_denied', 'invalid_arguments', 'invalid_arg_name',
  'invalid_team_id', 'not_in_team', 'team_access_not_granted',
]);

const socketHello = z.object({
  type: z.literal('hello'),
  connection_info: z.object({ app_id: z.string() }),
});

async function readSocketAppId(rawUrl: string): Promise<string | undefined> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'wss:' || !url.hostname.endsWith('.slack.com')
    || url.username || url.password || url.port) return undefined;

  // Slack supplies the app ID in the Socket Mode hello, not in apps.connections.open.
  const socket = new WebSocket(url);
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => finish(), 10_000);
    function finish(id?: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolve(id);
    }
    socket.addEventListener('error', () => finish(), { once: true });
    socket.addEventListener('close', () => finish(), { once: true });
    socket.addEventListener('message', ({ data }) => {
      try {
        if (typeof data !== 'string') return finish();
        const result = socketHello.safeParse(JSON.parse(data));
        finish(result.data?.connection_info.app_id);
      } catch {
        finish();
      }
    }, { once: true });
  });
}

/** Setup uses short-lived Web API clients and closes each validation socket after its hello. */
export const slackSetupApi: SlackSetupApi = {
  async createApp(token, teamId, manifest) {
    try {
      // The API accepts team_id, but the SDK's method argument type currently omits it.
      const args = { team_id: teamId, manifest };
      const result = await client(token).apps.manifest.create(args);
      return { appId: result.app_id, teamId: result.team_id };
    } catch (error) {
      if (error instanceof webApi.WebAPIRateLimitedError
        || (error instanceof webApi.WebAPIPlatformError && rejectedAppCreate.has(error.data.error))) {
        throw new AppCreateRejected();
      }
      throw error;
    }
  },

  async exportApp(token, appId) {
    return (await client(token).apps.manifest.export({ app_id: appId })).manifest;
  },

  async botIdentity(token) {
    const web = client(token);
    const auth = await web.auth.test();
    if (!auth.bot_id || auth.is_enterprise_install) return {};
    let appId = auth.app_id;
    if (!appId) {
      const { bot } = await web.bots.info({ bot: auth.bot_id });
      if (!bot || bot.deleted || bot.id !== auth.bot_id || (bot.user_id !== undefined && bot.user_id !== auth.user_id)) {
        return {};
      }
      appId = bot.app_id;
    }
    return { teamId: auth.team_id, botUserId: auth.user_id, appId };
  },

  async appIdentity(token) {
    const { url } = await client(token).apps.connections.open();
    return url ? readSocketAppId(url) : undefined;
  },

  async ownerIsMember(token, teamId, ownerId) {
    const { user } = await client(token).users.info({ user: ownerId });
    return user?.id === ownerId && user.team_id === teamId
      && !user.is_bot && !user.is_app_user && !user.deleted && !user.is_stranger && !user.is_invited_user;
  },

  async createChannel(token) {
    const { channel } = await client(token).conversations.create({ name: 'anton', is_private: true });
    return channel?.id;
  },

  async channelInfo(token, channelId) {
    const { channel } = await client(token).conversations.info({ channel: channelId });
    if (!channel?.id || !channel.name || channel.is_im || channel.is_mpim) return undefined;
    return {
      id: channel.id,
      name: channel.name,
      isPrivate: channel.is_private === true,
      isShared: !!(channel.is_shared || channel.is_ext_shared || channel.is_org_shared
        || channel.is_global_shared || channel.is_pending_ext_shared || channel.pending_shared?.length
        || channel.pending_connected_team_ids?.length || channel.properties?.has_slack_connect_invite_created),
      isArchived: channel.is_archived === true,
      teamId: channel.context_team_id,
    };
  },

  async channelMembers(token, channelId) {
    const web = client(token, 3_000);
    const members: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    // The service also uses this read for authorization. An incomplete list cannot verify membership.
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page: webApi.ConversationsMembersResponse = await web.conversations.members({
        channel: channelId, limit: 200, cursor,
      });
      if (!page.members || page.members.length > 200) throw new Error('Slack returned an invalid channel membership page.');
      members.push(...page.members);
      cursor = page.response_metadata?.next_cursor;
      if (!cursor) return members;
      if (seen.has(cursor)) throw new Error('Slack repeated a channel membership page.');
      seen.add(cursor);
    }
    throw new Error('Slack channel membership exceeded the pagination limit.');
  },

  async invite(token, channelId, member) {
    await client(token).conversations.invite({ channel: channelId, users: member });
  },
};
