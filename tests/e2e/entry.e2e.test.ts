import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureImage, execIn, startContainer, stopContainer } from '../../src/docker/container.js';
import { AgentEventSchema, type AgentEvent, type AgentRequest } from '../../src/agent/protocol.js';

// Requires `npm run build:image` first (which stages the entry into the build context).
const slug = `e2e-entry-${randomBytes(4).toString('hex')}`;
let container: string | undefined;
let repo: string | undefined;

describe.skipIf(!process.env.ANTON_E2E || !process.env.ANTHROPIC_API_KEY)('entry e2e (real API)', () => {
  afterAll(async () => {
    if (container) await stopContainer(container);
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it('a one-sentence request on claude-haiku-5-5 yields a result with totalUsd > 0', async () => {
    const image = await ensureImage({ name: 'fallback', dockerfile: join(process.cwd(), 'src/kits/fallback/Dockerfile') });
    repo = await mkdtemp(join(tmpdir(), 'anton-entry-e2e-'));
    const req: AgentRequest = {
      role: 'e2e', model: 'claude-haiku-5-5', effort: 'low', systemPrompt: 'Reply in one short sentence.',
      prompt: 'Say hello.', maxTurns: 1, budgetUsd: 0.05,
    };
    await mkdir(join(repo, 'req'), { recursive: true });
    await writeFile(join(repo, 'req', 'r.json'), JSON.stringify(req));
    container = await startContainer(slug, repo, image);

    const r = await execIn(container, ['node', '/opt/anton/entry.js', '/workspace/req/r.json'], { timeoutMs: 120_000 });
    const events: AgentEvent[] = String(r.stdout).split('\n').filter(Boolean).map((l) => AgentEventSchema.parse(JSON.parse(l)));
    const last = events.at(-1);
    expect(last?.type, JSON.stringify(events)).toBe('result');
    expect(last && 'totalUsd' in last ? last.totalUsd : 0).toBeGreaterThan(0);
  }, 180_000);
});
