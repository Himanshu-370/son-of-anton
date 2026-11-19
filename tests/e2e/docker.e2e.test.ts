import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execa } from 'execa';
import { startContainer, runIn, stopContainer } from '../../src/docker/container.js';

const IMAGE = 'alpine:3.20';
const slug = `e2e-test-${randomBytes(4).toString('hex')}`;
const name = `anton-${slug}`;
let repo: string | undefined;

describe.skipIf(!process.env.ANTON_E2E)('docker e2e', () => {
  afterAll(async () => {
    await stopContainer(name);
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it('starts container, runIn echo returns "hi", stop removes it', async () => {
    repo = await mkdtemp(join(tmpdir(), 'anton-e2e-'));
    const have = await execa('docker', ['image', 'inspect', IMAGE], { reject: false });
    if (have.exitCode !== 0) await execa('docker', ['pull', IMAGE]);

    const started = await startContainer(slug, repo, IMAGE);
    expect(started).toBe(name);

    const r = await runIn(name, 'echo hi');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hi');

    await stopContainer(name);
    const ps = await execa('docker', ['ps', '-aq', '--filter', `name=^${name}$`]);
    expect(ps.stdout.trim()).toBe('');
  }, 120_000);
});
