import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { acquireLock, AlreadyRunning } from '../core/lock.js';
import { antonHome } from '../core/paths.js';
import {
  appIdSchema, channelIdSchema, loadSlackConfig, loadSlackCredentials, readSlackFile, roleCredentialsSchema,
  roleIdentitySchema, SLACK_ROLES, slackDirectory, teamIdSchema, userIdSchema, writeSlackFile,
  type SlackConfig, type SlackCredentials, type SlackRole,
} from './config.js';
import { matchesSlackManifest, slackManifest, type ExportedSlackManifest } from './manifests.js';

type Field = 'teamId' | 'ownerId' | 'configToken' | 'appToken' | 'botToken' | 'recoverAppId' | 'replaceApp' | 'channelId' | 'repair';
type Channel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isShared: boolean;
  isArchived: boolean;
  teamId?: string;
};

export interface SlackSetupApi {
  createApp(token: string, teamId: string, manifest: ReturnType<typeof slackManifest>): Promise<{ appId?: string; teamId?: string }>;
  exportApp(token: string, appId: string): Promise<ExportedSlackManifest | undefined>;
  botIdentity(token: string, appId: string): Promise<{ teamId?: string; appId?: string; botUserId?: string }>;
  appIdentity(token: string, appId: string): Promise<string | undefined>;
  ownerIsMember(token: string, teamId: string, ownerId: string): Promise<boolean>;
  createChannel(token: string): Promise<string | undefined>;
  channelInfo(token: string, channelId: string): Promise<Channel | undefined>;
  channelMembers(token: string, channelId: string): Promise<string[]>;
  invite(token: string, channelId: string, member: string): Promise<void>;
}

export interface SlackSetupDeps {
  home?: string;
  api: SlackSetupApi;
  prompt(label: string, field: Field): Promise<string | undefined>;
  out(message: string): void;
  err(message: string): void;
}

/** The adapter uses this only when Slack explicitly rejected an app create without creating an app. */
export class AppCreateRejected extends Error {}

const setupSchema = z.strictObject({
  teamId: teamIdSchema,
  ownerId: userIdSchema,
  apps: z.partialRecord(z.enum(SLACK_ROLES), appIdSchema),
  attempts: z.partialRecord(z.enum(SLACK_ROLES), z.uuid()).optional(),
  pendingApp: z.strictObject({ role: z.enum(SLACK_ROLES), attemptId: z.uuid(), wrongWorkspaceApp: appIdSchema.optional() }).optional(),
  channelId: z.unknown().optional(),
  pendingChannel: z.literal(true).optional(),
});
const savedRoleSchema = roleIdentitySchema.extend(roleCredentialsSchema.shape);
const savedRolesSchema = z.partialRecord(z.enum(SLACK_ROLES), z.unknown())
  .transform((records) => {
    const valid: Partial<Record<SlackRole, z.infer<typeof savedRoleSchema>>> = {};
    for (const role of SLACK_ROLES) {
      const entry = savedRoleSchema.safeParse(records[role]);
      if (entry.success) valid[role] = entry.data;
    }
    return valid;
  })
  .refine((roles) => {
    const ids = Object.values(roles).map((entry) => entry?.botUserId);
    return new Set(ids).size === ids.length;
  });

class SetupMessage extends Error {}

async function runSetup(deps: SlackSetupDeps, home: string, folder: string): Promise<void> {
  const { api, out, prompt } = deps;
  const required = async (label: string, field: Field, schema: z.ZodType<string>) => {
    const value = await prompt(label, field);
    if (value === undefined) throw new SetupMessage('Setup paused. Run anton slack setup to resume.');
    const result = schema.safeParse(value.trim());
    if (!result.success) throw new SetupMessage(`Invalid ${label.toLowerCase()}.`);
    return result.data;
  };

  const verifyBot = async (botToken: string, appId: string, teamId: string) => {
    const bot = await api.botIdentity(botToken, appId).catch(() => undefined);
    if (bot?.teamId !== teamId || bot.appId !== appId) return undefined;
    const id = userIdSchema.safeParse(bot.botUserId);
    return id.success ? id.data : undefined;
  };
  const verifyApp = async (appToken: string, appId: string) =>
    await api.appIdentity(appToken, appId).catch(() => undefined) === appId;

  const members = async (token: string, id: string) => {
    const ids = await api.channelMembers(token, id).catch(() => undefined);
    return ids && new Set(ids);
  };
  const inspectChannel = async (token: string, id: string, teamId: string) => {
    const channel = await api.channelInfo(token, id).catch(() => undefined);
    if (channel?.id !== id || channel.name !== 'anton' || !channel.isPrivate || channel.isShared
      || channel.isArchived || (channel.teamId !== undefined && channel.teamId !== teamId)) return undefined;
    return members(token, id);
  };
  const ensureChannelMembers = async (
    token: string, channelId: string, before: Set<string>, expected: { name: string; id: string }[],
  ) => {
    const absent = expected.filter(({ id }) => !before.has(id));
    if (!absent.length) return;
    for (const { id } of absent) await api.invite(token, channelId, id).catch(() => undefined);
    const after = await members(token, channelId);
    if (!after) throw new SetupMessage(`Slack could not check membership in #anton (${channelId}). Ensure Anton PM is a member and rerun setup.`);
    const missing = expected.filter(({ id }) => !after.has(id));
    if (missing.length) {
      for (const { name, id } of missing) out(`Add ${name} (${id}) to private #anton (${channelId}) in Slack.`);
      throw new SetupMessage('Rerun anton slack setup once the missing members have been added.');
    }
  };

  const clearSetup = async () => {
    await rm(join(folder, 'setup-credentials.json'), { force: true });
    await rm(join(folder, 'setup.json'), { force: true });
  };
  const existing = await loadSlackConfig(home);
  const credentials = await loadSlackCredentials(home);
  if (existing) {
    if (!credentials) throw new SetupMessage('Slack is configured, but credentials.json is missing. Restore it before starting Slack.');
    const selected = (await prompt(
      'Press Enter to finish, or type channel to rebind #anton or a role ID to renew its credentials',
      'repair',
    ))?.trim();
    if (selected === 'channel') {
      const pmToken = credentials.pm.botToken;
      const pm = existing.roles.pm;
      if (await verifyBot(pmToken, pm.appId, existing.teamId) !== pm.botUserId) {
        throw new SetupMessage('Renew the pm credentials before changing the channel.');
      }
      const id = await required('Channel ID for an active, private #anton with Anton PM added', 'channelId', channelIdSchema);
      const before = await inspectChannel(pmToken, id, existing.teamId);
      if (!before) throw new SetupMessage('Slack could not verify the replacement private #anton channel and its membership.');
      await ensureChannelMembers(pmToken, id, before, [
        { name: 'owner', id: existing.ownerId },
        ...SLACK_ROLES.map((role) => ({ name: role, id: existing.roles[role].botUserId })),
      ]);
      await writeSlackFile(home, 'config.json', { ...existing, channelId: id });
      existing.channelId = id;
    } else if (selected) {
      const requested = z.enum(SLACK_ROLES).safeParse(selected);
      if (!requested.success) {
        throw new SetupMessage(`Choose channel or a role ID (${SLACK_ROLES.join(', ')}).`);
      }
      const role = requested.data;
      const { appId, botUserId } = existing.roles[role];
      out(`Enter new credentials for ${role} app ${appId} in workspace ${existing.teamId}.`);
      const botToken = await required('Bot token', 'botToken', roleCredentialsSchema.shape.botToken);
      if (await verifyBot(botToken, appId, existing.teamId) !== botUserId) {
        throw new SetupMessage(`The bot token must match the configured ${role} app and bot member IDs.`);
      }
      const appToken = await required('App-level token', 'appToken', roleCredentialsSchema.shape.appToken);
      if (!await verifyApp(appToken, appId)) {
        throw new SetupMessage(`The app-level token for ${role} could not be verified for app ${appId} with connections:write.`);
      }
      await writeSlackFile(home, 'credentials.json', { ...credentials, [role]: { appToken, botToken } });
    }
    await clearSetup();
    out(`Slack setup is complete for ${existing.teamId} in #anton (${existing.channelId}).`);
    return;
  }

  const resumed = await readSlackFile(home, 'setup.json', setupSchema);
  if (!resumed) out('Copy the workspace ID from Slack and your member ID from your Slack profile.');
  const state: z.infer<typeof setupSchema> = resumed ?? {
    teamId: await required('Slack workspace ID', 'teamId', teamIdSchema),
    ownerId: await required('Your Slack member ID', 'ownerId', userIdSchema),
    apps: {},
  };
  const attempts = state.attempts ??= {};
  const checkpoint = () => writeSlackFile(home, 'setup.json', state);
  if (!resumed) await checkpoint();
  const savedRoles = await readSlackFile(home, 'setup-credentials.json', savedRolesSchema) ?? {};
  const ensureOwner = async (pmToken: string) => {
    if (!await api.ownerIsMember(pmToken, state.teamId, state.ownerId).catch(() => false)) {
      throw new SetupMessage(`Slack could not verify ${state.ownerId} as a person in workspace ${state.teamId}. Check the member ID in setup.json before resuming.`);
    }
  };
  let configToken: string | undefined;
  const token = async () => {
    if (configToken === undefined) {
      out(`In https://api.slack.com/apps, generate an App Configuration Token for workspace ${state.teamId}. Copy its access token.`);
      configToken = await required(`App configuration access token for ${state.teamId}`, 'configToken', z.string().regex(/^\S+$/));
    }
    return configToken;
  };

  const reconcileApp = async (role: SlackRole, attemptId: string, excludedId?: string) => {
    const manifest = slackManifest(role, attemptId);
    out(`Find ${manifest.display_information.name} in https://api.slack.com/apps. Its manifest description must be "${manifest.display_information.description}".`);
    out('If you have confirmed that a matching app does not exist in the target workspace, create it manually from this manifest:');
    out(JSON.stringify(manifest, null, 2));
    const recovered = await required('App ID to reconcile', 'recoverAppId', appIdSchema);
    if (recovered === excludedId || Object.values(state.apps).includes(recovered)) {
      throw new SetupMessage('Choose a different Slack app ID that is not already assigned to a role.');
    }
    const exported = await api.exportApp(await token(), recovered).catch(() => undefined);
    if (!matchesSlackManifest(exported, manifest)) {
      throw new SetupMessage('Slack could not verify that app ID against the saved setup attempt.');
    }
    return recovered;
  };

  for (const role of SLACK_ROLES) {
    let appId = state.apps[role];
    const hadApp = appId !== undefined;
    if (!appId) {
      if (state.pendingApp) {
        if (state.pendingApp.role !== role) throw new SetupMessage('The saved Slack app setup order is inconsistent.');
        const { attemptId, wrongWorkspaceApp } = state.pendingApp;
        if (wrongWorkspaceApp) {
          out(`Slack previously created app ${wrongWorkspaceApp} in a different workspace. Locate the matching app in ${state.teamId} before reconciling.`);
        }
        appId = await reconcileApp(role, attemptId, wrongWorkspaceApp);
        attempts[role] = attemptId;
      } else {
        const access = await token();
        const attemptId = randomUUID();
        state.pendingApp = { role, attemptId };
        await checkpoint();
        try {
          const created = await api.createApp(access, state.teamId, slackManifest(role, attemptId));
          appId = appIdSchema.parse(created.appId);
          if (created.teamId !== undefined && created.teamId !== state.teamId) {
            state.pendingApp.wrongWorkspaceApp = appId;
            await checkpoint();
            throw new SetupMessage(`Slack created app ${appId} in a different workspace. Rerun with a configuration token for ${state.teamId}.`);
          }
        } catch (error) {
          if (error instanceof SetupMessage) throw error;
          if (error instanceof AppCreateRejected) {
            delete state.pendingApp;
            await checkpoint();
            throw new SetupMessage(`Slack rejected creation for ${role}. Check the configuration token and workspace, then rerun setup.`);
          }
          throw new SetupMessage(`Slack did not confirm creation for ${role}. Rerun setup to reconcile by app ID before creating another app.`);
        }
        attempts[role] = attemptId;
      }
      if (Object.values(state.apps).includes(appId)) throw new SetupMessage('That Slack app ID is already assigned to a role.');
      state.apps[role] = appId;
      delete state.pendingApp;
      await checkpoint();
    }

    const saved = savedRoles[role];
    if (saved?.appId === appId && await verifyBot(saved.botToken, appId, state.teamId) === saved.botUserId
      && await verifyApp(saved.appToken, appId)) {
      if (role === 'pm') await ensureOwner(saved.botToken);
      continue;
    }
    if (saved) out(`The saved credentials for ${role} could not be verified.`);

    if (hadApp) {
      const answer = await prompt(`Press Enter to enter credentials for ${role} app ${appId}, or type replace to bind a different app`, 'replaceApp');
      if (answer === undefined) throw new SetupMessage('Setup paused. Run anton slack setup to resume.');
      if (answer.trim() === 'replace') {
        // Older checkpoints may predate persisted manifest attempt IDs.
        if (!attempts[role]) {
          attempts[role] = randomUUID();
          await checkpoint();
        }
        appId = await reconcileApp(role, attempts[role]);
      } else if (answer.trim()) {
        throw new SetupMessage('Enter replace to bind a different app, or press Enter to keep the saved app.');
      }
    }

    out(`For ${role}, install the app in ${state.teamId} at https://api.slack.com/apps/${appId}. Create an app-level token with connections:write in Basic Information, then copy the bot token from OAuth & Permissions.`);
    const botToken = await required('Bot token', 'botToken', roleCredentialsSchema.shape.botToken);
    const botUserId = await verifyBot(botToken, appId, state.teamId);
    if (!botUserId) {
      throw new SetupMessage(`The bot token for ${role} could not be verified for app ${appId} in workspace ${state.teamId}. Rerun to retry the credentials or bind a replacement app.`);
    }
    if (botUserId === state.ownerId || SLACK_ROLES.some((other) => other !== role && savedRoles[other]?.botUserId === botUserId)) {
      throw new SetupMessage(`The bot member ID for ${role} is already in use.`);
    }
    const appToken = await required('App-level token', 'appToken', roleCredentialsSchema.shape.appToken);
    if (!await verifyApp(appToken, appId)) {
      throw new SetupMessage(`The app-level token for ${role} could not be verified for app ${appId} with connections:write.`);
    }
    if (role === 'pm') await ensureOwner(botToken);
    if (state.apps[role] !== appId) {
      state.apps[role] = appId;
      await checkpoint();
    }
    savedRoles[role] = { appId, botUserId, appToken, botToken };
    await writeSlackFile(home, 'setup-credentials.json', savedRoles);
  }

  configToken = undefined;
  const pmToken = savedRoles.pm!.botToken;

  const savedChannel = channelIdSchema.safeParse(state.channelId).data;
  let channelId = savedChannel;
  if (!channelId && (state.pendingChannel || state.channelId !== undefined)) {
    channelId = await required('Channel ID for private #anton with Anton PM already added', 'channelId', channelIdSchema);
  }
  if (!channelId) {
    const value = await prompt(
      'Enter the channel ID to bind an existing private #anton with Anton PM already added, or press Enter to create it',
      'channelId',
    );
    if (value === undefined) throw new SetupMessage('Setup paused. Run anton slack setup to resume.');
    if (value.trim()) {
      const parsed = channelIdSchema.safeParse(value.trim());
      if (!parsed.success) throw new SetupMessage('Enter a valid Slack channel ID.');
      channelId = parsed.data;
    } else {
      state.pendingChannel = true;
      await checkpoint();
      const result = channelIdSchema.safeParse(await api.createChannel(pmToken).catch(() => undefined));
      if (!result.success) {
        throw new SetupMessage('Slack did not confirm private #anton. Find it or create it in Slack, add Anton PM, and rerun setup with its channel ID.');
      }
      channelId = result.data;
      state.channelId = channelId;
      delete state.pendingChannel;
      await checkpoint();
    }
  }
  let before = await inspectChannel(pmToken, channelId, state.teamId);
  if (!before && savedChannel) {
    out(`Could not verify the saved #anton channel (${savedChannel}) or its membership.`);
    channelId = await required('Channel ID for an active, private #anton with Anton PM added', 'channelId', channelIdSchema);
    before = await inspectChannel(pmToken, channelId, state.teamId);
  }
  if (!before) {
    throw new SetupMessage('Slack could not verify an active, private, workspace-local #anton channel and its membership. Add Anton PM and check the channel ID.');
  }
  if (state.channelId !== channelId) {
    state.channelId = channelId;
    delete state.pendingChannel;
    await checkpoint();
  }

  const expected = [{ name: 'owner', id: state.ownerId }, ...SLACK_ROLES.map((role) => ({
    name: role, id: savedRoles[role]!.botUserId,
  }))];
  await ensureChannelMembers(pmToken, channelId, before, expected);

  const config: SlackConfig = { teamId: state.teamId, ownerId: state.ownerId, channelId, roles: {} as SlackConfig['roles'] };
  const allCredentials = {} as SlackCredentials;
  for (const role of SLACK_ROLES) {
    const { appId, botUserId, appToken, botToken } = savedRoles[role]!;
    config.roles[role] = { appId, botUserId };
    allCredentials[role] = { appToken, botToken };
  }
  await writeSlackFile(home, 'credentials.json', allCredentials);
  await writeSlackFile(home, 'config.json', config);
  await clearSetup();
  out(`Slack setup is complete for ${state.teamId} in #anton (${channelId}).`);
}

export async function slackSetup(deps: SlackSetupDeps): Promise<number> {
  const home = deps.home ?? antonHome();
  try {
    const folder = (await slackDirectory(home, true))!;
    const release = await acquireLock(home, 'slack-setup.lock');
    try {
      await runSetup(deps, home, folder);
    } finally {
      await release();
    }
    return 0;
  } catch (error) {
    if (error instanceof SetupMessage) deps.err(error.message);
    else if (error instanceof AlreadyRunning) deps.err('Slack setup is already running.');
    else deps.err('Slack setup could not read or save local state. Check ownership and permissions in the Anton Slack directory.');
    return 1;
  }
}
