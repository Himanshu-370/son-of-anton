import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugify, registerProject, getProject, listProjects, uniqueName, UnknownProject } from '../../src/core/registry.js';

beforeEach(async () => {
  process.env.ANTON_HOME = await mkdtemp(join(tmpdir(), 'anton-reg-'));
});

describe('slugify', () => {
  it('slugs text', () => {
    expect(slugify('A CLI that "cleans" my Downloads!!')).toBe('a-cli-that-cleans-my-downloads');
  });
  it('falls back to project', () => {
    expect(slugify('!!!')).toBe('project');
  });
  it('caps length and trims dashes', () => {
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(40);
    const s = slugify('a'.repeat(39) + ' b');
    expect(s.endsWith('-')).toBe(false);
  });
});

describe('registry', () => {
  it('registers, gets and lists', async () => {
    await registerProject('foo', '/tmp/foo');
    expect(await getProject('foo')).toEqual({ name: 'foo', repoPath: '/tmp/foo' });
    expect(await listProjects()).toEqual([{ name: 'foo', repoPath: '/tmp/foo' }]);
    const raw = JSON.parse(await readFile(join(process.env.ANTON_HOME!, 'registry.json'), 'utf8'));
    expect(raw.projects.foo.repoPath).toBe('/tmp/foo');
  });
  it('throws UnknownProject', async () => {
    await expect(getProject('nope')).rejects.toBeInstanceOf(UnknownProject);
  });
  it('lists empty with no registry', async () => {
    expect(await listProjects()).toEqual([]);
  });
  it('uniqueName appends suffix', async () => {
    expect(await uniqueName('foo')).toBe('foo');
    await registerProject('foo', '/tmp/foo');
    expect(await uniqueName('foo')).toBe('foo-2');
    await registerProject('foo-2', '/tmp/foo2');
    expect(await uniqueName('foo')).toBe('foo-3');
  });
});
