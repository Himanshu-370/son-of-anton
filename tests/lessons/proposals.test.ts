import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendProposals, proposalsPath, readProposals, removeProposal, type Proposal } from '../../src/lessons/proposals.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-proposals-'));
});

const lesson = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'P-00000001', project: 'p', jobId: '1-init', kind: 'lesson', target: 'build-backend', text: 'Run the type check.', why: 'tsc failed', at: 't', ...over,
});

describe('proposal queue', () => {
  it('bad queue lines are skipped', async () => {
    await mkdir(join(home, 'lessons'), { recursive: true });
    const good = lesson();
    await writeFile(proposalsPath(home), ['not json', JSON.stringify({ id: 'x' }), JSON.stringify(good), '[]', ''].join('\n'));
    expect(await readProposals(home)).toEqual([good]);
  });

  it('missing file reads as empty', async () => {
    expect(await readProposals(home)).toEqual([]);
  });

  it('append skips ids already queued; remove rewrites without the id', async () => {
    const a = lesson();
    const b = lesson({ id: 'P-00000002', kind: 'plugin', target: undefined, text: undefined, plugin: 'tdd@acme/mkt', stage: 'build' });
    await appendProposals([a], home);
    await appendProposals([a, b], home);
    expect((await readProposals(home)).map((p) => p.id)).toEqual(['P-00000001', 'P-00000002']);
    await removeProposal('P-00000001', home);
    expect(await readProposals(home)).toEqual([b]);
    expect((await readFile(proposalsPath(home), 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});
