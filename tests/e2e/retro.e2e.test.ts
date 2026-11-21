import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunRecord } from '../../src/retro/record.js';
import { RetroOutputSchema, retroPrompt } from '../../src/retro/prompt.js';
import { anthropicRetroClient, retroParams, retroUserMessage } from '../../src/retro/run.js';

/**
 * Real-API test (costs a few cents). Needs ANTHROPIC_API_KEY and ANTON_E2E=1.
 * Sends one fixture run record straight to Haiku (retro.batch: false path) and checks the output schema.
 */
let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'anton-e2e-retro-'));
  const jobDir = join(repo, '.anton', 'jobs', 'job-1');
  await mkdir(jobDir, { recursive: true });
  const w = (name: string, v: unknown) => writeFile(join(jobDir, name), JSON.stringify(v));
  await w('spec.json', { kit: 'web', checks: ['page shows Hello'] });
  await w('spec.approved.json', { kit: 'web', checks: ['page shows Hello', 'page has a title'] });
  await writeFile(join(jobDir, 'questions.md'), '- Assumed plain HTML, no framework (fixture content).\n');
});
afterAll(() => rm(repo, { recursive: true, force: true }));

describe.skipIf(!process.env.ANTON_E2E || !process.env.ANTHROPIC_API_KEY)('retro e2e', () => {
  it('returns output that parses with RetroOutputSchema', async () => {
    const record = await buildRunRecord({ repo, jobDir: join(repo, '.anton', 'jobs', 'job-1') });
    const params = retroParams(await retroPrompt(), retroUserMessage(record, 'approved'));
    const msg = await anthropicRetroClient(process.env.ANTHROPIC_API_KEY!).send(params);
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    expect(RetroOutputSchema.safeParse(JSON.parse(text)).success).toBe(true);
  }, 120_000);
});
