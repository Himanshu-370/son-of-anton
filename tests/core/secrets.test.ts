import { describe, it, expect, beforeEach } from 'vitest';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecrets, secretsPath } from '../../src/core/secrets.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-secrets-'));
  process.env.ANTON_HOME = home;
});

async function write(project: string, body: string, mode = 0o600) {
  const p = secretsPath(project);
  await mkdir(join(home, 'secrets'), { recursive: true });
  await writeFile(p, body);
  await chmod(p, mode);
  return p;
}

describe('secrets', () => {
  it('loadSecrets parses, strips quotes, ignores comments', async () => {
    await write('app', '# note\n\nA=FAKE_VALUE_1\nB="FAKE VALUE 2"\nC=\'not-a-secret\'\nD=x=y\n');
    expect(await loadSecrets('app')).toEqual({ A: 'FAKE_VALUE_1', B: 'FAKE VALUE 2', C: 'not-a-secret', D: 'x=y' });
  });

  it('world-readable file → throws chmod message', async () => {
    const p = await write('app', 'A=FAKE_VALUE_1\n', 0o644);
    await expect(loadSecrets('app')).rejects.toThrow(`Secrets file must be private: chmod 600 ${p}`);
  });

  it('missing file → {}', async () => {
    expect(await loadSecrets('app')).toEqual({});
  });

  it('secretsPath rejects names that are not slugs (no traversal)', () => {
    expect(secretsPath('my-app')).toBe(join(home, 'secrets', 'my-app.env'));
    for (const bad of ['../x', 'a/b', 'My App', '']) {
      expect(() => secretsPath(bad)).toThrow('Project names may only use a-z, 0-9 and -');
    }
  });
});
