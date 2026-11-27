import type { webApi } from '@slack/bolt';
import type { SlackRole } from './config.js';

type Manifest = webApi.AppsManifestCreateArguments['manifest'];
type BotScopes = NonNullable<NonNullable<NonNullable<Manifest['oauth_config']>['scopes']>['bot']>;
type BotEvents = NonNullable<NonNullable<NonNullable<Manifest['settings']>['event_subscriptions']>['bot_events']>;

const names: Record<SlackRole, string> = {
  pm: 'Anton PM',
  tech_lead: 'Anton Tech Lead',
  frontend: 'Anton Frontend',
  backend: 'Anton Backend',
  infra: 'Anton Infra',
  qa: 'Anton QA',
  code_reviewer: 'Anton Code Reviewer',
  security_reviewer: 'Anton Security Reviewer',
  coach: 'Anton Coach',
};

export function slackManifest(role: SlackRole, attemptId: string) {
  const pm = role === 'pm';
  const scopes: BotScopes = ['app_mentions:read', 'im:history', 'chat:write', 'groups:history', 'users:read'];
  // Each role posts through the outbox and needs history for its own ambiguous sends.
  // Only the PM manages private channels and subscribes to project thread replies.
  const events: BotEvents = ['app_mention', 'message.im'];
  if (pm) events.push('message.groups', 'app_home_opened');
  if (pm) scopes.push('commands', 'groups:read', 'groups:write');
  if (pm || role === 'qa') scopes.push('files:write');
  return {
    display_information: { name: names[role], description: `Son of Anton setup ${attemptId}` },
    features: {
      app_home: { home_tab_enabled: pm, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: names[role], always_online: false },
      ...(pm ? { slash_commands: [{ command: '/anton', description: 'Work with the Son of Anton team' }] } : {}),
    },
    oauth_config: { scopes: { bot: scopes } },
    settings: {
      socket_mode_enabled: true,
      org_deploy_enabled: false,
      interactivity: { is_enabled: pm || role === 'qa' || role === 'coach' },
      event_subscriptions: { bot_events: events },
    },
  } satisfies Manifest;
}

export type ExportedSlackManifest = NonNullable<webApi.AppsManifestExportResponse['manifest']>;

export function matchesSlackManifest(actual: ExportedSlackManifest | undefined, expected: ReturnType<typeof slackManifest>): boolean {
  const sameList = (actual: (string | undefined)[] | undefined, expected: string[] | undefined) =>
    JSON.stringify([...(actual ?? [])].sort()) === JSON.stringify([...(expected ?? [])].sort());

  return actual?.display_information?.name === expected.display_information.name
    && actual.display_information.description === expected.display_information.description
    && actual.features?.bot_user?.display_name === expected.features.bot_user.display_name
    && (actual.features.app_home?.home_tab_enabled ?? false) === expected.features.app_home.home_tab_enabled
    && actual.features.app_home?.messages_tab_enabled === expected.features.app_home.messages_tab_enabled
    && (actual.features.app_home.messages_tab_read_only_enabled ?? false) === expected.features.app_home.messages_tab_read_only_enabled
    && actual.settings?.socket_mode_enabled === true
    && (actual.settings.interactivity?.is_enabled ?? false) === expected.settings.interactivity.is_enabled
    && !actual.settings.interactivity?.request_url && !actual.settings.interactivity?.message_menu_options_url
    && sameList(actual.oauth_config?.scopes?.bot, expected.oauth_config.scopes.bot)
    && sameList(actual.oauth_config?.scopes?.user, undefined)
    && sameList(actual.settings?.event_subscriptions?.bot_events, expected.settings.event_subscriptions.bot_events)
    && sameList(actual.features?.slash_commands?.map(({ command }) => command),
      expected.features.slash_commands?.map(({ command }) => command));
}
