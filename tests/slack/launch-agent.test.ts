import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { slackServiceCommand, type SlackServiceCommandDeps } from '../../src/slack/launch-agent.js';

const domain = 'gui/501';
const label = 'com.son-of-anton.slack';
const target = `${domain}/${label}`;
const fakeSecret = 'REDACTED_TEST_VALUE';
const success = { exitCode: 0, stdout: '', stderr: '' };
const absent = { exitCode: 113, stdout: '', stderr: `Could not find service "${label}" in domain for user gui: 501` };

describe('Slack LaunchAgent', () => {
  let root: string;
  let plist: string;
  let antonHome: string;
  let deps: SlackServiceCommandDeps;
  let loaded: boolean;
  let installedConfig: string | undefined;
  let dockerPath: string;
  let keychainItem: boolean;
  const out = vi.fn<(line: string) => void>();
  const err = vi.fn<(line: string) => void>();
  const exec = vi.fn<NonNullable<SlackServiceCommandDeps['exec']>>();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anton-launch-agent-'));
    plist = join(root, 'Library', 'LaunchAgents', `${label}.plist`);
    antonHome = join(root, `Anton & <dev> "test" 'home'`);
    const nodePath = join(root, 'bin & tools', 'node');
    const antonPath = join(root, 'Anton <cli>', 'index.js');
    await mkdir(dirname(nodePath));
    await mkdir(dirname(antonPath));
    await writeFile(nodePath, '', { mode: 0o700 });
    await writeFile(antonPath, '');
    dockerPath = join(root, 'docker bin', 'docker');
    await mkdir(dirname(dockerPath));
    await writeFile(dockerPath, '', { mode: 0o700 });
    deps = { platform: 'darwin', uid: 501, user: 'tester', homeDir: root, nodePath, antonPath, exec, out, err,
      searchPath: `${join(root, 'empty')}:${dirname(dockerPath)}` };
    keychainItem = false;
    vi.stubEnv('ANTON_HOME', antonHome);
    vi.stubEnv('SLACK_BOT_TOKEN', fakeSecret);
    out.mockClear();
    err.mockClear();
    loaded = false;
    installedConfig = undefined;
    exec.mockReset().mockImplementation(async (command, args) => {
      if (command === '/usr/bin/security') {
        expect(args).toEqual(['find-generic-password', '-a', 'tester', '-s', 'anthropic-api-key']);
        return keychainItem ? success : { exitCode: 44, stdout: '', stderr: 'not found' };
      }
      if (command === '/usr/bin/plutil') {
        const key = args[1]!.replace('EnvironmentVariables.', '');
        const xml = await readFile(plist, 'utf8').catch(() => '');
        const value = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1];
        return value === undefined ? { exitCode: 1, stdout: '', stderr: '' } : { ...success, stdout: `${value}\n` };
      }
      expect(command).toBe('/bin/launchctl');
      switch (args[0]) {
        case 'print':
          expect(args).toEqual(['print', target]);
          return loaded ? { ...success, stdout: `state = running\n SLACK_BOT_TOKEN => ${fakeSecret}` } : absent;
        case 'bootstrap':
          expect(args).toEqual(['bootstrap', domain, plist]);
          expect(loaded).toBe(false);
          installedConfig = await readFile(plist, 'utf8');
          loaded = true;
          return success;
        case 'bootout':
          expect(args).toEqual(['bootout', target]);
          expect(loaded).toBe(true);
          loaded = false;
          return success;
        default:
          throw new Error('Unexpected launchctl command');
      }
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('installs at login with absolute arguments, durable logs and only ANTON_HOME and PATH in the environment', async () => {
    expect(await slackServiceCommand('install', deps)).toBe(0);
    const xml = await readFile(plist, 'utf8');
    expect(xml).not.toContain(fakeSecret);
    expect(xml).not.toContain('SLACK_BOT_TOKEN');
    expect(xml).toContain('Anton &amp; &lt;dev&gt; &quot;test&quot; &apos;home&apos;');
    const logs = join(antonHome, 'slack', 'logs');
    expect((await stat(logs)).isDirectory()).toBe(true);

    if (process.platform === 'darwin') {
      execFileSync('/usr/bin/plutil', ['-lint', '--', plist]);
      const config = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plist], {
        encoding: 'utf8',
      }));
      expect(config).toMatchObject({
        Label: label,
        ProgramArguments: [deps.nodePath, deps.antonPath, 'serve'],
        EnvironmentVariables: { ANTON_HOME: antonHome },
        RunAtLoad: true,
        StandardOutPath: join(logs, 'stdout.log'),
        StandardErrorPath: join(logs, 'stderr.log'),
        AbandonProcessGroup: true,
      });
      expect(config.EnvironmentVariables).toEqual({
        ANTON_HOME: antonHome,
        PATH: [dirname(dockerPath), dirname(deps.nodePath!), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      });
      expect(xml).not.toContain('ANTHROPIC_API_KEY');
    }
  });

  it('leaves an identical running agent loaded and reloads it when the config changes', async () => {
    expect(await slackServiceCommand('install', deps)).toBe(0);
    exec.mockClear();
    expect(await slackServiceCommand('install', deps)).toBe(0);
    expect(exec.mock.calls.map(([, args]) => args[0])).toEqual(['print']);

    vi.stubEnv('ANTON_HOME', join(root, 'next-home'));
    expect(await slackServiceCommand('install', deps)).toBe(0);
    expect(exec.mock.calls.slice(1).map(([, args]) => args[0])).toEqual(['print', 'bootout', 'bootstrap']);
    expect(installedConfig).toContain('next-home');
  });

  it('refuses to install when docker cannot be found', async () => {
    expect(await slackServiceCommand('install', { ...deps, searchPath: join(root, 'empty') })).toBe(1);
    await expect(stat(plist)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(err.mock.lastCall?.[0]).toMatch(/docker/i);
  });

  it('adds the real directory of a linked docker so its helpers resolve', async () => {
    const linked = join(root, 'links');
    await mkdir(linked);
    await symlink(dockerPath, join(linked, 'docker'));
    expect(await slackServiceCommand('install', { ...deps, searchPath: linked })).toBe(0);
    const path = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(await readFile(plist, 'utf8'))?.[1] ?? '';
    expect(path.split(':').slice(0, 2)).toEqual([linked, dirname(await realpath(dockerPath))]);
  });

  it('lets job runners outlive the agent', async () => {
    expect(await slackServiceCommand('install', deps)).toBe(0);
    expect(await readFile(plist, 'utf8')).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  });

  it('reports whether docker and the Keychain key were found, never the key', async () => {
    expect(await slackServiceCommand('install', deps)).toBe(0);
    out.mockClear();
    expect(await slackServiceCommand('status', deps)).toBe(0);
    const lines = out.mock.calls.map(([line]) => line);
    expect(lines).toContain(`Docker: found at ${dockerPath}.`);
    expect(lines.some((line) => /API key: not found in the macOS Keychain/.test(line))).toBe(true);
    keychainItem = true;
    out.mockClear();
    expect(await slackServiceCommand('status', deps)).toBe(0);
    expect(out.mock.calls.map(([line]) => line)).toContain('Anthropic API key: found in the macOS Keychain.');
    expect(exec.mock.calls.every(([, args]) => !args.includes('-w'))).toBe(true);
    await rm(dockerPath);
    out.mockClear();
    expect(await slackServiceCommand('status', deps)).toBe(0);
    expect(out.mock.calls.map(([line]) => line).some((line) => /^Docker: not found/.test(line))).toBe(true);
  });

  it('reports status without printing the launchctl dump', async () => {
    const said = (text: string) => out.mock.calls.some(([line]) => line.includes(text));
    expect(await slackServiceCommand('status', deps)).toBe(0);
    expect(said('not installed')).toBe(true);
    expect(await slackServiceCommand('install', deps)).toBe(0);
    expect(await slackServiceCommand('status', deps)).toBe(0);
    expect(out.mock.calls.map(([line]) => line)).toContain('Slack LaunchAgent is running.');
    expect(said('health is not available')).toBe(true);
    loaded = false;
    expect(await slackServiceCommand('status', deps)).toBe(0);
    expect(said('installed but not loaded')).toBe(true);
    expect(JSON.stringify(out.mock.calls)).not.toContain(fakeSecret);
  });

  it('reports live role health from the installed home in a fresh shell', async () => {
    expect(await slackServiceCommand('install', deps)).toBe(0);
    await writeFile(join(antonHome, 'slack', 'service-health.json'), JSON.stringify({ pid: 345, roles: { pm: 'connected' } }));
    vi.stubEnv('ANTON_HOME', join(root, 'another-home'));
    exec.mockResolvedValueOnce({ ...success, stdout: 'state = running\npid = 345' });
    exec.mockImplementationOnce(async (command, args) => {
      expect(command).toBe('/usr/bin/plutil');
      expect(args).toEqual(['-extract', 'EnvironmentVariables.ANTON_HOME', 'raw', '-o', '-', plist]);
      return { ...success, stdout: `${antonHome}\n` };
    });
    expect(await slackServiceCommand('status', deps)).toBe(0);
    expect(out.mock.calls.some(([line]) => /^Slack roles offline: tech_lead,/.test(line))).toBe(true);
  });

  it('removes the agent repeatedly and preserves its logs', async () => {
    expect(await slackServiceCommand('install', deps)).toBe(0);
    const stdout = join(antonHome, 'slack', 'logs', 'stdout.log');
    await writeFile(stdout, 'previous run');
    exec.mockClear();
    expect(await slackServiceCommand('uninstall', deps)).toBe(0);
    expect(await slackServiceCommand('uninstall', deps)).toBe(0);
    expect(exec.mock.calls.map(([, args]) => args[0])).toEqual(['print', 'bootout', 'print']);
    await expect(stat(plist)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(stdout, 'utf8')).toBe('previous run');
  });

  it('retains the plist when bootout fails and hides raw launchctl errors', async () => {
    expect(await slackServiceCommand('install', deps)).toBe(0);
    exec.mockResolvedValueOnce(success).mockResolvedValueOnce({ exitCode: 5, stdout: '', stderr: fakeSecret });
    expect(await slackServiceCommand('uninstall', deps)).toBe(1);
    expect((await stat(plist)).isFile()).toBe(true);
    expect(err.mock.lastCall?.[0]).toContain('bootout');
    expect(JSON.stringify(err.mock.calls)).not.toContain(fakeSecret);
  });

  it('can retry a failed bootstrap using the installed plist', async () => {
    exec.mockResolvedValueOnce(absent).mockResolvedValueOnce({ exitCode: 5, stdout: '', stderr: '' });
    expect(await slackServiceCommand('install', deps)).toBe(1);
    expect((await stat(plist)).isFile()).toBe(true);
    expect(await slackServiceCommand('install', deps)).toBe(0);
    expect(loaded).toBe(true);
  });

  it('fails before writing an agent when the built CLI is missing', async () => {
    expect(await slackServiceCommand('install', { ...deps, antonPath: join(root, 'missing.js') })).toBe(1);
    await expect(stat(plist)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(exec.mock.calls.some(([, args]) => args[0] === 'bootstrap')).toBe(false);
    expect(err.mock.lastCall?.[0]).toContain('Anton CLI');
  });

  it('does not confuse a missing GUI domain with an absent service', async () => {
    exec.mockResolvedValueOnce({ exitCode: 113, stdout: '', stderr: 'Could not find domain for gui/501' });
    expect(await slackServiceCommand('status', deps)).toBe(1);
    expect(out).not.toHaveBeenCalled();
  });

  it('rejects non-macOS hosts before invoking launchctl or writing files', async () => {
    expect(await slackServiceCommand('install', { ...deps, platform: 'linux' })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    await expect(stat(plist)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
