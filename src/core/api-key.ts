import { userInfo } from 'node:os';
import { defaultExec, type ExecFn } from './exec.js';

/** macOS Keychain item that holds the Anthropic API key for `anton serve` (account = the macOS user). */
export const KEYCHAIN_SERVICE = 'anthropic-api-key';
const SECURITY = '/usr/bin/security';

export type ApiKeyDeps = {
  exec?: ExecFn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  user?: string;
};

function account(deps: ApiKeyDeps): string | undefined {
  try {
    return deps.user ?? userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * Makes sure `env.ANTHROPIC_API_KEY` is set. Keeps a key that is already in the environment;
 * otherwise reads the Keychain item and sets it on `env` (memory only: the value is never written or logged).
 * Returns where the key came from, or undefined when none was found.
 */
export async function ensureAnthropicKey(deps: ApiKeyDeps = {}): Promise<'environment' | 'keychain' | undefined> {
  const env = deps.env ?? process.env;
  if (env.ANTHROPIC_API_KEY) return 'environment';
  if ((deps.platform ?? process.platform) !== 'darwin') return undefined;
  const user = account(deps);
  if (!user) return undefined;
  try {
    const result = await (deps.exec ?? defaultExec)(SECURITY, ['find-generic-password', '-a', user, '-s', KEYCHAIN_SERVICE, '-w']);
    const key = result.exitCode === 0 ? result.stdout.replace(/\r?\n$/, '') : '';
    if (!key || /[\r\n]/.test(key)) return undefined;
    env.ANTHROPIC_API_KEY = key;
    return 'keychain';
  } catch {
    return undefined;
  }
}

/** Whether the Keychain item exists. Reads only its attributes, never the key itself. */
export async function keychainHasAnthropicKey(deps: ApiKeyDeps = {}): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== 'darwin') return false;
  const user = account(deps);
  if (!user) return false;
  try {
    return (await (deps.exec ?? defaultExec)(SECURITY, ['find-generic-password', '-a', user, '-s', KEYCHAIN_SERVICE])).exitCode === 0;
  } catch {
    return false;
  }
}
