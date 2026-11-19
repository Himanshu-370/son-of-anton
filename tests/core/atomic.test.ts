import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../../src/core/atomic.js';

describe('writeFileAtomic', () => {
  it('creates dirs, writes, overwrites, leaves no tmp files', async () => {
    const d = await mkdtemp(join(tmpdir(), 'anton-at-'));
    const p = join(d, 'sub', 'dir', 'f.txt');
    await writeFileAtomic(p, 'one');
    await writeFileAtomic(p, 'two');
    expect(await readFile(p, 'utf8')).toBe('two');
    expect(await readdir(join(d, 'sub', 'dir'))).toEqual(['f.txt']);
  });
  it('concurrent writes do not collide', async () => {
    const d = await mkdtemp(join(tmpdir(), 'anton-at-'));
    const p = join(d, 'f.txt');
    await Promise.all(['a', 'b', 'c', 'd'].map((x) => writeFileAtomic(p, x)));
    expect(['a', 'b', 'c', 'd']).toContain(await readFile(p, 'utf8'));
    expect(await readdir(d)).toEqual(['f.txt']);
  });
});
