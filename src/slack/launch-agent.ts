import { constants } from 'node:fs';
import { access, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { cliPath } from '../cli/deps.js';
import { readRegularFile, writeFileAtomic } from '../core/atomic.js';
import { keychainHasAnthropicKey, KEYCHAIN_SERVICE } from '../core/api-key.js';
import { defaultExec, type ExecFn } from '../core/exec.js';
import { antonHome } from '../core/paths.js';
import { SLACK_ROLES, slackDirectory } from './config.js';

const LABEL = 'com.son-of-anton.slack';

const fileSystem = { access, lstat, mkdir, realpath, rm, stat, readRegularFile, writeFileAtomic };
/** Where Docker Desktop and Homebrew put their commands when the shell PATH does not have them. */
const COMMON_BIN = ['/usr/local/bin', '/opt/homebrew/bin', '/Applications/Docker.app/Contents/Resources/bin'];
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export type SlackServiceCommandDeps = {
  platform?: NodeJS.Platform;
  uid?: number;
  homeDir?: string;
  nodePath?: string;
  antonPath?: string;
  exec?: ExecFn;
  /** Directories searched for `docker` at install (default: the shell PATH, then common install dirs). */
  searchPath?: string;
  /** macOS account for the Keychain check (default: the current user). */
  user?: string;
  fs?: typeof fileSystem;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

function escapeXml(value: string): string {
  if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(value)) {
    throw new Error('A LaunchAgent path contains a character that XML cannot represent.');
  }
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('\r', '&#13;');
}

async function isExecutable(fs: typeof fileSystem, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile() && (await fs.access(path, constants.X_OK), true);
  } catch {
    return false;
  }
}

/** First executable `name` in the absolute directories of `searchPath`. */
async function findCommand(fs: typeof fileSystem, name: string, searchPath: string): Promise<string | undefined> {
  for (const dir of searchPath.split(':')) {
    if (isAbsolute(dir) && await isExecutable(fs, join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/**
 * The service PATH: docker's directory (and, for a link such as Docker Desktop's, the real one, which holds
 * its credential helpers), node's, then the system directories. launchd gives an agent almost no PATH.
 */
async function servicePath(fs: typeof fileSystem, docker: string, node: string): Promise<string> {
  const dirs = [dirname(docker)];
  if ((await fs.lstat(docker)).isSymbolicLink()) dirs.push(dirname(await fs.realpath(docker)));
  dirs.push(dirname(node), ...SYSTEM_PATH);
  const unique = [...new Set(dirs)];
  if (unique.some((dir) => dir.includes(':'))) throw new Error('The docker or node directory contains ":", which PATH cannot hold.');
  return unique.join(':');
}

function agentPlist(node: string, anton: string, home: string, logs: string, path: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(anton)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTON_HOME</key>
    <string>${escapeXml(home)}</string>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(logs, 'stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logs, 'stderr.log'))}</string>
</dict>
</plist>
`;
}

function serviceMissing(result: Awaited<ReturnType<ExecFn>>): boolean {
  return result.exitCode === 113 && /Could not find service\b/i.test(result.stderr);
}

async function checkFile(fs: typeof fileSystem, path: string, mode: number, name: string): Promise<void> {
  try {
    if ((await fs.stat(path)).isFile()) {
      await fs.access(path, mode);
      return;
    }
  } catch {
    // Give the operator the expected path for a missing or inaccessible file.
  }
  throw new Error(`${name} is unavailable at ${path}.`);
}

export async function slackServiceCommand(
  action: 'install' | 'status' | 'uninstall',
  deps: SlackServiceCommandDeps = {},
): Promise<number> {
  const { exec = defaultExec, fs = fileSystem, out = console.log, err = console.error } = deps;
  try {
    if ((deps.platform ?? process.platform) !== 'darwin') {
      throw new Error('Slack LaunchAgent management requires macOS.');
    }
    const uid = deps.uid ?? process.getuid?.();
    if (uid === undefined || uid === 0) {
      throw new Error('Run this command as the logged-in macOS user without sudo.');
    }
    const domain = `gui/${uid}`;
    const target = `${domain}/${LABEL}`;
    const plist = resolve(deps.homeDir ?? homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const launchctl = async (command: 'print' | 'bootstrap' | 'bootout', ...args: string[]) => {
      try {
        return await exec('/bin/launchctl', [command, ...args]);
      } catch {
        throw new Error(`Could not run launchctl ${command} for ${domain}.`);
      }
    };

    const probe = await launchctl('print', target);
    const loaded = probe.exitCode === 0;
    if (!loaded && !serviceMissing(probe)) {
      throw new Error(`launchctl print failed for ${domain} (exit ${probe.exitCode}). Check that the user is logged in to macOS.`);
    }
    const current = await fs.readRegularFile(plist);
    if (action === 'status') {
      if (loaded) {
        const running = /^\s*state\s*=\s*running\s*$/m.test(probe.stdout);
        out(`Slack LaunchAgent is ${running ? 'running' : 'loaded but not running'}${current === undefined ? ' (plist missing)' : ''}.`);
        const pid = Number(/^\s*pid\s*=\s*(\d+)\s*$/m.exec(probe.stdout)?.[1]);
        if (running) {
          let reported = false;
          try {
            const property = current !== undefined && await exec('/usr/bin/plutil', [
              '-extract', 'EnvironmentVariables.ANTON_HOME', 'raw', '-o', '-', plist,
            ]);
            const installedHome = property && property.exitCode === 0 ? property.stdout.replace(/\r?\n$/, '') : '';
            const root = isAbsolute(installedHome) ? await slackDirectory(installedHome) : undefined;
            const raw = root && await fs.readRegularFile(join(root, 'service-health.json'));
            const health = raw ? JSON.parse(raw) as { pid?: unknown; roles?: Record<string, unknown> } : undefined;
            if (Number.isSafeInteger(pid) && pid > 0 && health?.pid === pid && health.roles) {
              const offline = SLACK_ROLES.filter((role) => health.roles?.[role] !== 'connected');
              out(offline.length ? `Slack roles offline: ${offline.join(', ')}.` : 'All nine Slack roles are connected.');
              reported = true;
            }
          } catch {
            // A health snapshot is optional while the service is starting up.
          }
          if (!reported) out('Slack role health is not available for this process yet.');
        }
      } else {
        out(current === undefined ? 'Slack LaunchAgent is not installed.' : 'Slack LaunchAgent is installed but not loaded.');
      }
      // What the service itself will see: the installed PATH, and the Keychain (its shell environment is empty).
      let path = '';
      if (current !== undefined) {
        const property = await exec('/usr/bin/plutil', ['-extract', 'EnvironmentVariables.PATH', 'raw', '-o', '-', plist]).catch(() => undefined);
        path = property?.exitCode === 0 ? property.stdout.replace(/\r?\n$/, '') : '';
      }
      const docker = path ? await findCommand(fs, 'docker', path) : undefined;
      out(docker ? `Docker: found at ${docker}.`
        : current === undefined ? 'Docker: not checked (the service is not installed).'
          : 'Docker: not found on the service PATH. Reinstall with docker on your PATH.');
      out(await keychainHasAnthropicKey({ exec, platform: 'darwin', user: deps.user })
        ? 'Anthropic API key: found in the macOS Keychain.'
        : `Anthropic API key: not found in the macOS Keychain (service ${KEYCHAIN_SERVICE}). Slack job controls and paid answers need it.`);
      return 0;
    }

    const bootout = async () => {
      const result = await launchctl('bootout', target);
      if (result.exitCode !== 0 && !serviceMissing(result)) {
        throw new Error(`launchctl bootout failed for ${domain} (exit ${result.exitCode}).`);
      }
    };
    if (action === 'uninstall') {
      if (loaded) await bootout();
      if (current !== undefined) await fs.rm(plist, { force: true });
      out('Slack LaunchAgent uninstalled.');
      return 0;
    }

    const node = resolve(deps.nodePath ?? process.execPath);
    const anton = resolve(deps.antonPath ?? cliPath());
    const home = resolve(antonHome());
    const slack = await slackDirectory(home, true);
    const logs = join(slack!, 'logs');
    const docker = await findCommand(fs, 'docker', deps.searchPath ?? [process.env.PATH ?? '', ...COMMON_BIN].join(':'));
    if (!docker) {
      throw new Error('Could not find docker on your PATH. Install Docker Desktop (or put docker on PATH), then re-run install.');
    }
    const config = agentPlist(node, anton, home, logs, await servicePath(fs, docker, node));
    if (loaded && current === config) {
      await fs.mkdir(logs, { recursive: true, mode: 0o700 });
      out('Slack LaunchAgent is already installed and loaded.');
      return 0;
    }
    await checkFile(fs, node, constants.X_OK, 'Node executable');
    await checkFile(fs, anton, constants.R_OK, 'Built Anton CLI');
    await fs.mkdir(logs, { recursive: true, mode: 0o700 });
    if (loaded) await bootout();
    if (current !== config) await fs.writeFileAtomic(plist, config);
    const result = await launchctl('bootstrap', domain, plist);
    if (result.exitCode !== 0) {
      throw new Error(`launchctl bootstrap failed for ${domain} (exit ${result.exitCode}). The plist is installed. Re-run install to retry.`);
    }
    out(`Slack LaunchAgent installed. Logs are in ${logs}.`);
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
