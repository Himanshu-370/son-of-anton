import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSamples } from '../../src/bench/samples.js';
import { ensureImage, startContainer, stopContainer } from '../../src/docker/container.js';
import { fallbackKit } from '../../src/kits/fallback/index.js';

const CLI = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));

describe.skipIf(!process.env.ANTON_E2E)('bench e2e', () => {
  let home: string | undefined;

  const anton = (...args: string[]) => execa(process.execPath, ['--import', 'tsx', CLI, ...args], {
    env: { ANTON_HOME: home },
  });

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'anton-e2e-bench-'));
    await anton('bench', '--init');
  }, 30_000);

  afterAll(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('initializes and validates the bundled samples', async () => {
    const samples = await loadSamples(home);
    expect(samples.map((sample) => sample.name).sort()).toEqual([
      'api-todo', 'change-greeting', 'cli-wordcount', 'web-counter',
    ]);
  });

  it('passes the change-greeting baseline in the fallback kit', async () => {
    const [sample] = await loadSamples(home, ['change-greeting']);
    const repo = sample.repoDir;
    if (!repo) throw new Error('change-greeting is missing its baseline repo');
    const image = await ensureImage(fallbackKit);
    const slug = `e2e-bench-${randomUUID()}`;
    try {
      const container = await startContainer(slug, repo, image, undefined, { home });
      const baseline = await fallbackKit.baseline({
        container,
        repo,
        jobDir: join(repo, '.anton', 'jobs', 'baseline'),
        commands: {
          install: 'true',
          test: 'npm --silent test -- --test-reporter=junit > "$ANTON_JUNIT"',
        },
      });
      expect(baseline.ran).toBe(true);
      expect(baseline.passingTests).toEqual([expect.stringContaining('greet says hello to the world')]);
    } finally {
      await stopContainer(`anton-${slug}`);
    }
  }, 300_000);

  it.skipIf(!process.env.ANTHROPIC_API_KEY)('delivers cli-wordcount and saves the result (paid API)', async () => {
    await anton('bench', '--only', 'cli-wordcount', '--yes');
    const resultsDir = join(home!, 'bench', 'results');
    const files = (await readdir(resultsDir)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const result = JSON.parse(await readFile(join(resultsDir, files[0]), 'utf8'));
    expect(result.results).toEqual([expect.objectContaining({ sample: 'cli-wordcount', outcome: 'delivered' })]);
  }, 20 * 60_000);
});
