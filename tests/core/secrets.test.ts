import { describe, it, expect, beforeEach } from 'vitest';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecrets, redact, secretsEnvFile, secretsPath } from '../../src/core/secrets.js';

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
  it('loadSecrets parses verbatim like docker, ignores comments and blanks', async () => {
    await write('app', '# note\n\n  # indented comment\nA=FAKE_VALUE_1\nB=FAKE VALUE 2\nC=it\'s\nD=x=y\nE=\n');
    expect(await loadSecrets('app')).toEqual({ A: 'FAKE_VALUE_1', B: 'FAKE VALUE 2', C: "it's", D: 'x=y', E: '' });
  });

  it.each([
    ['quoted value', 'A="FAKE_VALUE_1"', /line 2.*quotes/],
    ['single-quoted value', "A='FAKE_VALUE_1'", /line 2.*quotes/],
    ['space before =', 'A =FAKE_VALUE_1', /line 2.*whitespace/],
    ['space after =', 'A= FAKE_VALUE_1', /line 2.*whitespace/],
    ['export prefix', 'export A=FAKE_VALUE_1', /line 2.*whitespace/],
    ['bare name', 'FAKE_NAME', /line 2.*bare name/],
    ['empty key', '=FAKE_VALUE_1', /line 2.*empty name/],
  ])('rejects %s, naming the line but never the value', async (_n, line, re) => {
    await write('app', `# header\n${line}\n`);
    const err = await loadSecrets('app').then(() => '', (e: Error) => e.message);
    expect(err).toMatch(re);
    expect(err).not.toContain('FAKE_VALUE_1');
  });

  it('0640 file → throws chmod message', async () => {
    await write('app', 'A=FAKE_VALUE_1\n', 0o640);
    await expect(loadSecrets('app')).rejects.toThrow('Secrets file must be private: chmod 600');
  });

  it('secretsEnvFile: undefined when missing, path when valid, throws when loose', async () => {
    expect(await secretsEnvFile('app')).toBeUndefined();
    const p = await write('app', 'A=FAKE_VALUE_1\n');
    expect(await secretsEnvFile('app')).toBe(p);
    await chmod(p, 0o644);
    await expect(secretsEnvFile('app')).rejects.toThrow('chmod 600');
  });

  it('world-readable file → throws chmod message', async () => {
    const p = await write('app', 'A=FAKE_VALUE_1\n', 0o644);
    await expect(loadSecrets('app')).rejects.toThrow(`Secrets file must be private: chmod 600 ${p}`);
  });

  it('missing file → {}', async () => {
    expect(await loadSecrets('app')).toEqual({});
  });

  it('secretsPath accepts a 42-char uniqueName result (40-char base plus -2)', () => {
    const name = `${'a'.repeat(40)}-2`;
    expect(secretsPath(name)).toBe(join(home, 'secrets', `${name}.env`));
  });

  it('secretsPath rejects names that are not slugs (no traversal)', () => {
    expect(secretsPath('my-app')).toBe(join(home, 'secrets', 'my-app.env'));
    for (const bad of ['../x', 'a/b', 'My App', '', '-a', 'a-', 'a--b', '.', 'a.b']) {
      expect(() => secretsPath(bad)).toThrow('Project names may only use a-z, 0-9 and -');
    }
  });
});

describe('redact', () => {
  it('redact replaces >=8-char values, leaves short ones', () => {
    expect(redact('a FAKE_SECRET_VALUE_123 b short12 c', { KEY: 'FAKE_SECRET_VALUE_123', S: 'short12' })).toBe('a [REDACTED:KEY] b short12 c');
    expect(redact('x', undefined)).toBe('x');
  });

  it('longest first: overlapping values fully hidden', () => {
    const out = redact('v=FAKE_SECRET_VALUE_123_LONGER', { A: 'FAKE_SECRET_VALUE_123', B: 'FAKE_SECRET_VALUE_123_LONGER' });
    expect(out).toBe('v=[REDACTED:B]');
  });

  it('JSON-escaped form of a value is hidden too', () => {
    const v = 'FAKE"SECRET\\VALUE';
    const text = JSON.stringify({ log: `got ${v}` });
    expect(JSON.parse(redact(text, { K: v }))).toEqual({ log: 'got [REDACTED:K]' });
  });
});
