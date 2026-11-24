import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveCommand } from '../../src/cli/commands/serve.js';

describe('anton serve API key', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'anton-serve-'));
    vi.stubEnv('ANTON_HOME', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('loads the key before anything else and says where it came from, never the key', async () => {
    const lines: string[] = [];
    const ensureApiKey = vi.fn(async () => 'keychain' as const);
    expect(await serveCommand({ ensureApiKey, out: (l) => lines.push(l), err: (l) => lines.push(l) })).toBe(1);
    expect(ensureApiKey).toHaveBeenCalledOnce();
    expect(lines).toContain('Anthropic API key: loaded from the macOS Keychain.');
  });

  it('warns when no key is found', async () => {
    const lines: string[] = [];
    await serveCommand({ ensureApiKey: async () => undefined, out: (l) => lines.push(l), err: (l) => lines.push(l) });
    expect(lines.some((l) => /No Anthropic API key/.test(l) && /anthropic-api-key/.test(l))).toBe(true);
  });
});
