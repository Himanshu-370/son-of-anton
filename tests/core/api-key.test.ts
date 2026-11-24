import { describe, expect, it, vi } from 'vitest';
import { ensureAnthropicKey, keychainHasAnthropicKey } from '../../src/core/api-key.js';
import type { ExecFn } from '../../src/core/exec.js';

const fakeKey = 'fake-test-key-not-real';

describe('Anthropic API key lookup', () => {
  it('keeps a key that is already in the environment without touching the Keychain', async () => {
    const exec = vi.fn<ExecFn>();
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: fakeKey };
    expect(await ensureAnthropicKey({ exec, env, platform: 'darwin', user: 'tester' })).toBe('environment');
    expect(exec).not.toHaveBeenCalled();
  });

  it('reads the Keychain item for the current user and holds the key in memory only', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ exitCode: 0, stdout: `${fakeKey}\n`, stderr: '' }));
    const env: NodeJS.ProcessEnv = {};
    expect(await ensureAnthropicKey({ exec, env, platform: 'darwin', user: 'tester' })).toBe('keychain');
    expect(exec).toHaveBeenCalledWith('/usr/bin/security', ['find-generic-password', '-a', 'tester', '-s', 'anthropic-api-key', '-w']);
    expect(env.ANTHROPIC_API_KEY).toBe(fakeKey);
  });

  it('reports no key when the item is missing, the lookup fails or the host is not macOS', async () => {
    const missing = vi.fn<ExecFn>(async () => ({ exitCode: 44, stdout: '', stderr: 'The specified item could not be found.' }));
    const env: NodeJS.ProcessEnv = {};
    expect(await ensureAnthropicKey({ exec: missing, env, platform: 'darwin', user: 'tester' })).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    const broken = vi.fn<ExecFn>(async () => { throw new Error('spawn failed'); });
    expect(await ensureAnthropicKey({ exec: broken, env, platform: 'darwin', user: 'tester' })).toBeUndefined();
    const other = vi.fn<ExecFn>();
    expect(await ensureAnthropicKey({ exec: other, env, platform: 'linux', user: 'tester' })).toBeUndefined();
    expect(other).not.toHaveBeenCalled();
  });

  it('checks for the item without reading the key', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ exitCode: 0, stdout: 'keychain: "login"', stderr: '' }));
    expect(await keychainHasAnthropicKey({ exec, platform: 'darwin', user: 'tester' })).toBe(true);
    expect(exec.mock.calls[0]![1]).not.toContain('-w');
  });
});
