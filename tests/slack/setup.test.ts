import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promptSlackSetup, slackSetupCommand } from '../../src/cli/commands/slack.js';
import { loadSlackConfig, loadSlackCredentials, SLACK_ROLES } from '../../src/slack/config.js';
import { matchesSlackManifest, slackManifest } from '../../src/slack/manifests.js';
import { slackSetupApi } from '../../src/slack/setup-api.js';
import { AppCreateRejected, slackSetup, type SlackSetupDeps } from '../../src/slack/setup.js';

const roles = ['pm', 'tech_lead', 'frontend', 'backend', 'infra', 'qa', 'code_reviewer', 'security_reviewer', 'coach'] as const;
const channel = { id: 'CANTON', name: 'anton', isPrivate: true, isShared: false, isArchived: false, teamId: 'TTEST' };
// Clearly fake, deliberately short credential placeholders.
const configToken = '<redacted-configuration-token>';
const botToken = 'xoxb-<redacted>';
const appToken = 'xapp-<redacted>';
let home: string;
const file = (name: string) => join(home, 'slack', name);

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'anton-slack-')); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(home, { recursive: true, force: true }); });

function fixture() {
  const members = new Set(['U0']);
  const created = new Map<string, ReturnType<typeof slackManifest>>();
  const api = {
    createApp: vi.fn<SlackSetupDeps['api']['createApp']>(async (_token, _team, manifest) => {
      const id = `A${created.size}`;
      created.set(id, manifest);
      return { appId: id, teamId: 'TTEST' };
    }),
    exportApp: vi.fn<SlackSetupDeps['api']['exportApp']>(async (_token, id) => created.get(id)),
    botIdentity: vi.fn<SlackSetupDeps['api']['botIdentity']>(async (_token, appId) => ({
      teamId: 'TTEST', appId, botUserId: `U${appId.slice(1)}`,
    })),
    appIdentity: vi.fn<SlackSetupDeps['api']['appIdentity']>(async (_token, appId) => appId),
    ownerIsMember: vi.fn<SlackSetupDeps['api']['ownerIsMember']>(async () => true),
    createChannel: vi.fn<SlackSetupDeps['api']['createChannel']>(async () => channel.id),
    channelInfo: vi.fn<SlackSetupDeps['api']['channelInfo']>(async () => channel),
    channelMembers: vi.fn<SlackSetupDeps['api']['channelMembers']>(async () => [...members]),
    invite: vi.fn<SlackSetupDeps['api']['invite']>(async (_token, _channel, member) => { members.add(member); }),
  };
  const reply: SlackSetupDeps['prompt'] = async (_label, field) => {
    switch (field) {
      case 'teamId': return 'TTEST';
      case 'ownerId': return 'UOWNER';
      case 'configToken': return configToken;
      case 'appToken': return appToken;
      case 'botToken': return botToken;
      case 'recoverAppId': return 'A0';
      case 'replaceApp': return '';
      case 'repair': return '';
      case 'channelId': return '';
    }
  };
  const deps = { home, api, prompt: vi.fn(reply), out: vi.fn(), err: vi.fn() } satisfies SlackSetupDeps;
  return { deps, api, created, members, reply };
}

describe('Slack setup', () => {
  it('bundles exactly the nine roles with PM-only command and management scopes', () => {
    expect(SLACK_ROLES).toEqual(roles);
    for (const role of roles) {
      const manifest = slackManifest(role, 'test-marker');
      const { bot } = manifest.oauth_config.scopes;
      expect(manifest.settings.socket_mode_enabled).toBe(true);
      expect(manifest.settings.event_subscriptions.bot_events).toEqual(expect.arrayContaining(['app_mention', 'message.im']));
      expect(manifest.settings.event_subscriptions.bot_events.includes('message.groups')).toBe(role === 'pm');
      expect(manifest.settings.event_subscriptions.bot_events.includes('app_home_opened')).toBe(role === 'pm');
      expect(manifest.features.app_home.home_tab_enabled).toBe(role === 'pm');
      expect(manifest.features.slash_commands?.map((command) => command.command) ?? []).toEqual(role === 'pm' ? ['/anton'] : []);
      for (const scope of ['commands', 'groups:write', 'groups:read'] as const) expect(bot.includes(scope)).toBe(role === 'pm');
      expect(bot.includes('files:write')).toBe(role === 'pm' || role === 'qa');
    }
  });

  it('creates and checkpoints all nine roles and a private workspace channel', async () => {
    const { deps, api } = fixture();
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createApp).toHaveBeenCalledTimes(9);
    expect(api.invite).toHaveBeenCalledTimes(9);
    expect(api.createChannel).toHaveBeenCalledOnce();
    const config = await loadSlackConfig(home);
    expect(config).toMatchObject({ teamId: 'TTEST', ownerId: 'UOWNER', channelId: 'CANTON' });
    expect(Object.keys(config!.roles)).toEqual(roles);
    expect(Object.keys((await loadSlackCredentials(home))!)).toEqual(roles);
    expect((await stat(file('credentials.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(file('.'))).mode & 0o777).toBe(0o700);
    expect(await readFile(file('config.json'), 'utf8')).not.toContain(botToken);
    expect(await readFile(file('credentials.json'), 'utf8')).not.toContain(configToken);
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createApp).toHaveBeenCalledTimes(9);
  });

  it('uses default CLI output when the caller passes undefined callbacks', async () => {
    const { deps } = fixture();
    expect(await slackSetup(deps)).toBe(0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await slackSetupCommand({ home, out: undefined, err: undefined })).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Slack setup is complete'));
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ['another workspace', { teamId: 'TOTHER', appId: 'A0', botUserId: 'U0' }],
    ['a different bot app', { teamId: 'TTEST', appId: 'AOTHER', botUserId: 'U0' }],
    ['an unidentified bot app', { teamId: 'TTEST', appId: undefined, botUserId: 'U0' }],
  ] as const)('rejects a bot token for %s and resumes the saved app', async (_reason, identity) => {
    const { deps, api } = fixture();
    api.botIdentity.mockResolvedValueOnce(identity);
    expect(await slackSetup(deps)).toBe(1);
    expect(await loadSlackConfig(home)).toBeUndefined();
    expect(await loadSlackCredentials(home)).toBeUndefined();
    expect(api.createApp).toHaveBeenCalledTimes(1);
    expect(api.appIdentity).not.toHaveBeenCalled();
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createApp).toHaveBeenCalledTimes(9);
  });

  it('checks app-level token identity and leaves earlier roles ready to reuse', async () => {
    const { deps, api } = fixture();
    api.appIdentity.mockResolvedValueOnce('A0').mockResolvedValueOnce('AOTHER');
    expect(await slackSetup(deps)).toBe(1);
    expect(api.createApp).toHaveBeenCalledTimes(2);
    expect(await loadSlackCredentials(home)).toBeUndefined();
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createApp).toHaveBeenCalledTimes(9);
    expect(api.botIdentity.mock.calls.filter(([, appId]) => appId === 'A0')).toHaveLength(2);
  });

  it('blocks another create after an unknown result until an app ID matches the saved manifest', async () => {
    const { deps, api, created, reply } = fixture();
    api.createApp.mockImplementationOnce(async (_token, _team, manifest) => {
      created.set('A0', manifest);
      created.set('AOTHER', {
        ...manifest,
        oauth_config: { scopes: { bot: [...manifest.oauth_config.scopes.bot, 'chat:write.public'] } },
      });
      throw new Error(`request failed with ${configToken}`);
    });
    expect(await slackSetup(deps)).toBe(1);
    deps.prompt.mockImplementation(async (label, field) => field === 'recoverAppId' ? 'AOTHER' : reply(label, field));
    expect(await slackSetup(deps)).toBe(1);
    expect(api.createApp).toHaveBeenCalledTimes(1);
    deps.prompt.mockImplementation(reply);
    // Fake IDs are allocated by the size of the map.
    created.delete('AOTHER');
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createApp).toHaveBeenCalledTimes(9);
    const output = JSON.stringify([deps.out.mock.calls, deps.err.mock.calls, deps.prompt.mock.calls]);
    for (const token of [configToken, appToken, botToken]) expect(output).not.toContain(token);
  });

  it('retries only when Slack explicitly rejected the app create', async () => {
    const { deps, api } = fixture();
    api.createApp.mockRejectedValueOnce(new AppCreateRejected());
    expect(await slackSetup(deps)).toBe(1);
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createApp).toHaveBeenCalledTimes(10);
    expect(api.exportApp).not.toHaveBeenCalled();
  });

  it('blocks a create response for the wrong workspace and records the app ID', async () => {
    const { deps, api, created } = fixture();
    api.createApp.mockImplementationOnce(async (_token, _team, manifest) => {
      created.set('A0', manifest);
      return { appId: 'A0', teamId: 'TOTHER' };
    });
    expect(await slackSetup(deps)).toBe(1);
    expect(await readFile(file('setup.json'), 'utf8')).toContain('A0');
    expect(api.botIdentity).not.toHaveBeenCalled();
    expect(await slackSetup(deps)).toBe(1);
    expect(api.createApp).toHaveBeenCalledOnce();
  });

  it('can replace a mismatched saved app when manifest creation did not report its workspace', async () => {
    const { deps, api, created, reply } = fixture();
    api.createApp
      .mockImplementationOnce(async (_token, _team, manifest) => {
        created.set('A0', manifest);
        return { appId: 'A0', teamId: 'TTEST' };
      })
      .mockImplementationOnce(async (_token, _team, manifest) => {
        created.set('A1', manifest);
        return { appId: 'A1' };
      });
    api.botIdentity
      .mockImplementationOnce(async () => ({ teamId: 'TTEST', appId: 'A0', botUserId: 'U0' }))
      .mockImplementationOnce(async () => ({ teamId: 'TWRONG', appId: 'A1', botUserId: 'U1' }));
    expect(await slackSetup(deps)).toBe(1);
    expect(api.createApp).toHaveBeenCalledTimes(2);
    created.set('AREPLACEMENT', created.get('A1')!);
    deps.prompt.mockImplementation(async (label, field) => {
      if (field === 'replaceApp') return 'replace';
      if (field === 'recoverAppId') return 'AREPLACEMENT';
      return reply(label, field);
    });
    api.appIdentity.mockResolvedValueOnce('A0').mockResolvedValueOnce('AWRONG');
    expect(await slackSetup(deps)).toBe(1);
    expect(JSON.parse(await readFile(file('setup.json'), 'utf8')).apps.tech_lead).toBe('A1');
    expect(api.createApp).toHaveBeenCalledTimes(2);

    expect(await slackSetup(deps)).toBe(0);
    const config = await loadSlackConfig(home);
    expect(config?.roles.pm.appId).toBe('A0');
    expect(config?.roles.tech_lead.appId).toBe('AREPLACEMENT');
    expect(api.createApp).toHaveBeenCalledTimes(9);
  });

  it('renews stale saved credentials for just the affected role on a partial rerun', async () => {
    const { deps, api, reply } = fixture();
    api.channelInfo.mockResolvedValueOnce({ ...channel, isArchived: true });
    expect(await slackSetup(deps)).toBe(1);
    api.botIdentity.mockImplementation(async (token, appId) => {
      if (appId === 'A1' && token === botToken) throw new Error('revoked');
      return { teamId: 'TTEST', appId, botUserId: `U${appId.slice(1)}` };
    });
    deps.prompt.mockClear().mockImplementation(async (label, field) =>
      field === 'botToken' ? 'xoxb-<replacement>' : reply(label, field));
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createApp).toHaveBeenCalledTimes(9);
    expect(deps.prompt.mock.calls.filter(([, field]) => field === 'botToken')).toHaveLength(1);
    expect((await loadSlackCredentials(home))?.tech_lead.botToken).toBe('xoxb-<replacement>');
    expect((await loadSlackCredentials(home))?.pm.botToken).toBe(botToken);
  });

  it('repairs a malformed partial credential entry without discarding other entries', async () => {
    const { deps, api } = fixture();
    api.channelInfo.mockResolvedValueOnce({ ...channel, isArchived: true });
    expect(await slackSetup(deps)).toBe(1);
    const path = file('setup-credentials.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.tech_lead.appToken = 'broken';
    await writeFile(path, JSON.stringify(saved));
    deps.prompt.mockClear();
    expect(await slackSetup(deps)).toBe(0);
    expect(deps.prompt.mock.calls.filter(([, field]) => field === 'botToken')).toHaveLength(1);
    expect(api.createApp).toHaveBeenCalledTimes(9);
  });

  it('requires an explicit channel ID when a saved channel checkpoint is malformed', async () => {
    const { deps, api, reply } = fixture();
    api.channelInfo.mockResolvedValueOnce({ ...channel, isArchived: true });
    expect(await slackSetup(deps)).toBe(1);
    const path = file('setup.json');
    const state = JSON.parse(await readFile(path, 'utf8'));
    state.channelId = 'invalid ID';
    await writeFile(path, JSON.stringify(state));
    expect(await slackSetup(deps)).toBe(1);
    expect(api.createChannel).toHaveBeenCalledOnce();
    deps.prompt.mockImplementation(async (label, field) => field === 'channelId' ? 'CANTON' : reply(label, field));
    expect(await slackSetup(deps)).toBe(0);
    expect((await loadSlackConfig(home))?.channelId).toBe('CANTON');
    expect(api.createChannel).toHaveBeenCalledOnce();
  });

  it('rotates credentials for an explicitly selected completed role without changing its identity', async () => {
    const { deps, api, reply } = fixture();
    expect(await slackSetup(deps)).toBe(0);
    const original = await loadSlackConfig(home);
    api.botIdentity.mockClear();
    api.botIdentity.mockImplementation(async (token, appId) => ({
      teamId: 'TTEST', appId, botUserId: token === 'xoxb-<wrong-member>' ? 'UBAD' : 'U1',
    }));
    let nextToken = 'xoxb-<wrong-member>';
    deps.prompt.mockImplementation(async (label, field) => {
      if (field === 'repair') return 'tech_lead';
      if (field === 'botToken') return nextToken;
      return reply(label, field);
    });
    expect(await slackSetup(deps)).toBe(1);
    expect((await loadSlackCredentials(home))?.tech_lead.botToken).toBe(botToken);
    nextToken = 'xoxb-<replacement>';
    expect(await slackSetup(deps)).toBe(0);
    expect(await loadSlackConfig(home)).toEqual(original);
    expect((await loadSlackCredentials(home))?.tech_lead.botToken).toBe(nextToken);
    expect((await loadSlackCredentials(home))?.pm.botToken).toBe(botToken);
    expect(api.botIdentity.mock.calls.map(([, id]) => id)).toEqual(['A1', 'A1']);
    expect(api.createApp).toHaveBeenCalledTimes(9);
  });

  it('rebinds a completed channel by explicit ID without rotating credentials', async () => {
    const { deps, api, reply } = fixture();
    expect(await slackSetup(deps)).toBe(0);
    const original = await loadSlackCredentials(home);
    deps.prompt.mockImplementation(async (label, field) => {
      if (field === 'repair') return 'channel';
      if (field === 'channelId') return 'CNEW';
      return reply(label, field);
    });
    api.channelInfo.mockImplementation(async (_token, id) => ({ ...channel, id, isShared: true }));
    expect(await slackSetup(deps)).toBe(1);
    expect((await loadSlackConfig(home))?.channelId).toBe('CANTON');
    api.channelInfo.mockImplementation(async (_token, id) => ({ ...channel, id, isArchived: id === 'CANTON' }));
    expect(await slackSetup(deps)).toBe(0);
    expect((await loadSlackConfig(home))?.channelId).toBe('CNEW');
    expect(await loadSlackCredentials(home)).toEqual(original);
    expect(api.createChannel).toHaveBeenCalledOnce();
  });

  it('recovers an invalid saved channel by explicit ID and preserves it until replacement verifies', async () => {
    const { deps, api, reply } = fixture();
    api.channelInfo.mockResolvedValue({ ...channel, isArchived: true });
    expect(await slackSetup(deps)).toBe(1);
    deps.prompt.mockImplementation(async (label, field) => field === 'channelId' ? 'CNEW' : reply(label, field));
    api.channelInfo.mockImplementation(async (_token, id) => ({ ...channel, id, isShared: true }));
    expect(await slackSetup(deps)).toBe(1);
    expect(JSON.parse(await readFile(file('setup.json'), 'utf8')).channelId).toBe('CANTON');
    expect(api.invite).not.toHaveBeenCalled();
    api.channelInfo.mockImplementation(async (_token, id) => ({ ...channel, id, isArchived: id === 'CANTON' }));
    expect(await slackSetup(deps)).toBe(0);
    expect((await loadSlackConfig(home))?.channelId).toBe('CNEW');
    expect(api.createChannel).toHaveBeenCalledOnce();
    expect(api.createApp).toHaveBeenCalledTimes(9);
  });

  it.each([
    ['App Home', (manifest: ReturnType<typeof slackManifest>) => ({
      ...manifest, features: { ...manifest.features, app_home: { messages_tab_enabled: false, messages_tab_read_only_enabled: true } },
    })],
    ['interactivity', (manifest: ReturnType<typeof slackManifest>) => ({
      ...manifest, settings: { ...manifest.settings, interactivity: { is_enabled: false } },
    })],
  ] as const)('rejects a recovered manifest with changed %s', (_field, change) => {
    const manifest = slackManifest('pm', 'test-marker');
    expect(matchesSlackManifest(change(manifest), manifest)).toBe(false);
  });

  it.each(['invalid_team_id', 'not_in_team', 'team_access_not_granted'])('classifies %s as a definitive create rejection', async (error) => {
    const fetchSlack = vi.fn<typeof fetch>(async () => Response.json({ ok: false, error }));
    vi.stubGlobal('fetch', fetchSlack);
    await expect(slackSetupApi.createApp(configToken, 'TTEST', slackManifest('pm', 'test-marker')))
      .rejects.toBeInstanceOf(AppCreateRejected);
    expect(fetchSlack).toHaveBeenCalledOnce();
  });

  it('bounds membership pagination and fails closed if Slack still has another page', async () => {
    let page = 0;
    const fetchSlack = vi.fn<typeof fetch>(async () => Response.json({
      ok: true, members: ['U0'], response_metadata: { next_cursor: ++page < 30 ? `cursor${page}` : '' },
    }));
    vi.stubGlobal('fetch', fetchSlack);
    await expect(slackSetupApi.channelMembers(botToken, 'CANTON')).rejects.toThrow(/limit/);
    expect(fetchSlack).toHaveBeenCalledTimes(5);
  });

  it('checks bot and Socket Mode identities through the setup adapter', async () => {
    const fetchSlack = vi.fn<typeof fetch>(async (url) => {
      switch (String(url).split('/').pop()) {
        case 'auth.test': return Response.json({ ok: true, team_id: 'TTEST', bot_id: 'BTEST', user_id: 'UTEST' });
        case 'bots.info': return Response.json({ ok: true, bot: { id: 'BTEST', user_id: 'UTEST', app_id: 'ATEST' } });
        case 'apps.connections.open': return Response.json({ ok: true, url: 'wss://wss.slack.com/link/' });
        default: throw new Error('Unexpected Slack request');
      }
    });
    const closed = vi.fn();
    class FakeSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ type: 'hello', connection_info: { app_id: 'ATEST' } }),
        })));
      }
      close() { closed(); }
    }
    vi.stubGlobal('fetch', fetchSlack);
    vi.stubGlobal('WebSocket', FakeSocket);
    await expect(slackSetupApi.botIdentity(botToken, 'ATEST')).resolves.toEqual({
      teamId: 'TTEST', botUserId: 'UTEST', appId: 'ATEST',
    });
    await expect(slackSetupApi.appIdentity(appToken, 'ATEST')).resolves.toBe('ATEST');
    expect(fetchSlack).toHaveBeenCalledTimes(3);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('sends the target workspace and serialized manifest with zero retries on a dropped request', async () => {
    const fetchSlack = vi.fn<typeof fetch>().mockRejectedValue(new Error(configToken));
    vi.stubGlobal('fetch', fetchSlack);
    const manifest = slackManifest('pm', 'test-marker');
    await expect(slackSetupApi.createApp(configToken, 'TTEST', manifest)).rejects.toThrow();
    expect(fetchSlack).toHaveBeenCalledOnce();
    const [url, options] = fetchSlack.mock.calls[0];
    expect(String(url)).toMatch(/apps\.manifest\.create$/);
    const form = new URLSearchParams(String(options?.body));
    expect(form.get('team_id')).toBe('TTEST');
    expect(JSON.parse(form.get('manifest')!)).toEqual(manifest);
  });

  it('reads a token without echo and restores terminal mode on answer or cancellation', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    let displayed = '';
    output.on('data', (chunk) => { displayed += String(chunk); });
    const ask = () => promptSlackSetup('Bot token', 'botToken', input as unknown as ReadStream, output as unknown as WriteStream);
    const reply = ask();
    input.write(botToken + '\n');
    await expect(reply).resolves.toBe(botToken);
    expect(displayed).toContain('input hidden');
    expect(displayed).not.toContain(botToken);
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);

    const cancelled = ask();
    input.write('\x03');
    await expect(cancelled).resolves.toBeUndefined();
    expect(input.setRawMode.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it('only binds a private, local #anton channel by explicit ID', async () => {
    const { deps, api, reply } = fixture();
    deps.prompt.mockImplementation(async (label, field) => field === 'channelId' ? 'CANTON' : reply(label, field));
    api.channelInfo.mockResolvedValueOnce({ ...channel, isShared: true });
    expect(await slackSetup(deps)).toBe(1);
    expect(await loadSlackConfig(home)).toBeUndefined();
    expect(api.invite).not.toHaveBeenCalled();
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createChannel).not.toHaveBeenCalled();
  });

  it('requires explicit channel ID after creation returns an unknown result', async () => {
    const { deps, api, reply } = fixture();
    api.createChannel.mockRejectedValueOnce(new Error('lost response'));
    expect(await slackSetup(deps)).toBe(1);
    expect(await slackSetup(deps)).toBe(1);
    expect(api.createChannel).toHaveBeenCalledOnce();
    deps.prompt.mockImplementation(async (label, field) => field === 'channelId' ? 'CANTON' : reply(label, field));
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createChannel).toHaveBeenCalledOnce();
  });

  it('guides the owner through restricted invitations and recognizes membership on rerun', async () => {
    const { deps, api, members } = fixture();
    api.invite.mockRejectedValueOnce(new Error(`restricted ${botToken}`));
    expect(await slackSetup(deps)).toBe(1);
    expect(await loadSlackConfig(home)).toBeUndefined();
    const output = JSON.stringify([deps.out.mock.calls, deps.err.mock.calls]);
    expect(output).toContain('UOWNER');
    expect(output).not.toContain(botToken);
    members.add('UOWNER');
    expect(await slackSetup(deps)).toBe(0);
    expect(api.createChannel).toHaveBeenCalledOnce();
  });

  it('rejects unreadable or overly broad permissions, symlinks and malformed data without printing contents', async () => {
    const { deps } = fixture();
    expect(await slackSetup(deps)).toBe(0);
    const path = file('credentials.json');
    const original = await readFile(path, 'utf8');
    for (const mode of [0o644, 0o000]) {
      await chmod(path, mode);
      await expect(loadSlackCredentials(home)).rejects.toThrow();
    }
    await rm(path);
    const other = join(home, 'other.json');
    await writeFile(other, original, { mode: 0o600 });
    await symlink(other, path);
    await expect(loadSlackCredentials(home)).rejects.toThrow();
    await rm(path);
    await writeFile(path, `malformed ${botToken}`, { mode: 0o600 });
    await expect(loadSlackCredentials(home)).rejects.toThrow(/credentials.json/);
    await expect(loadSlackCredentials(home)).rejects.not.toThrow(botToken);
    await chmod(file('.'), 0o755);
    await expect(loadSlackConfig(home)).rejects.toThrow();
  });
});
