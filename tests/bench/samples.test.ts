import { mkdtemp, readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initBench, loadSamples } from '../../src/bench/samples.js';

const home = () => mkdtemp(join(tmpdir(), 'anton-bench-'));

describe('bench samples', () => {
  it('shipped manifest and specs validate', async () => {
    const h = await home();
    await initBench(h);
    const samples = await loadSamples(h);
    for (const s of samples) {
      expect(s.budgetUsd).toBe(3);
      expect(s.spec.acceptanceChecks.length).toBeGreaterThanOrEqual(2);
      expect(s.spec.acceptanceChecks.length).toBeLessThanOrEqual(4);
      expect(s.spec.kit).toBe(s.kit);
    }
  });

  it('there are 4 samples covering both kits and one change job', async () => {
    const h = await home();
    await initBench(h);
    const samples = await loadSamples(h);
    expect(samples.map((s) => s.name).sort()).toEqual(['api-todo', 'change-greeting', 'cli-wordcount', 'web-counter']);
    expect(new Set(samples.map((s) => s.kit))).toEqual(new Set(['fallback', 'web']));
    expect(samples.filter((s) => s.kind === 'change').map((s) => s.name)).toEqual(['change-greeting']);
    expect(samples.find((s) => s.name === 'change-greeting')!.repoDir).toBe(join(h, 'bench', 'change-greeting', 'repo'));
  });

  it('init copies without overwriting edits', async () => {
    const h = await home();
    const first = await initBench(h);
    expect(first.copied.length).toBeGreaterThan(5);
    expect(first.kept).toEqual([]);
    const edited = join(h, 'bench', 'cli-wordcount', 'spec.json');
    await writeFile(edited, '{"edited":true}');
    const second = await initBench(h);
    expect(second.copied).toEqual([]);
    expect(second.kept).toContain('cli-wordcount/spec.json');
    expect(await readFile(edited, 'utf8')).toBe('{"edited":true}');
  });

  it('--only filters and rejects unknown names', async () => {
    const h = await home();
    await initBench(h);
    expect((await loadSamples(h, ['api-todo'])).map((s) => s.name)).toEqual(['api-todo']);
    await expect(loadSamples(h, ['nope'])).rejects.toThrow('Unknown bench sample "nope" (have: cli-wordcount, web-counter, api-todo, change-greeting)');
  });

  it('rejects a spec that does not validate', async () => {
    const h = await home();
    await initBench(h);
    await writeFile(join(h, 'bench', 'api-todo', 'spec.json'), '{"title":""}');
    await expect(loadSamples(h)).rejects.toThrow(/api-todo/);
  });

  it('ignores symlinks in the home bench folder when copying', async () => {
    const h = await home();
    await mkdir(join(h, 'bench'), { recursive: true });
    await symlink('/etc/hosts', join(h, 'bench', 'manifest.json'));
    const r = await initBench(h);
    expect(r.kept).toContain('manifest.json');
  });
});
