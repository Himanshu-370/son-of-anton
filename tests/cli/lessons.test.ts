import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CliDeps } from '../../src/cli/deps.js';
import { lessonsListCommand, lessonsRemoveCommand, lessonsReviewCommand } from '../../src/cli/commands/lessons.js';
import { appendProposals, readProposals, type Proposal } from '../../src/lessons/proposals.js';
import { addLesson, readLessons } from '../../src/lessons/store.js';
import { registerProject } from '../../src/core/registry.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-cli-lessons-'));
  process.env.ANTON_HOME = home;
});

const prop = (o: Partial<Proposal> = {}): Proposal => ({
  id: 'p1', project: 'proj', jobId: 'job1', kind: 'lesson', target: 'web', text: 'Run the linter first', why: 'it failed once', at: '2026-01-01', ...o,
});

function harness(answers: string[] = [], tty = true) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const deps: CliDeps = {
    out: (s) => out.push(s), err: (s) => err.push(s), isTTY: () => tty, retro: { home, env: {} },
    ask: async (qs) => { asked.push(...qs); return [answers.shift() ?? 's']; },
  };
  return { deps, text: () => out.join('\n'), errText: () => err.join('\n'), asked };
}

describe('anton lessons', () => {
  it('review accepts a lesson into its file and drops the proposal', async () => {
    await appendProposals([prop()], home);
    const h = harness(['A']);
    expect(await lessonsReviewCommand(h.deps)).toBe(0);
    expect((await readLessons('web', home)).map((l) => l.text)).toEqual(['Run the linter first']);
    expect(await readProposals(home)).toEqual([]);
    expect(h.text()).toContain('Accepted 1, rejected 0, kept 0.');
  });

  it('edit replaces the text before accepting', async () => {
    await appendProposals([prop()], home);
    const h = harness(['e', 'Lint  before\ncommit']);
    await lessonsReviewCommand(h.deps);
    expect((await readLessons('web', home)).map((l) => l.text)).toEqual(['Lint before commit']);
    expect(h.text()).toContain('Lint before commit');
    expect(await readProposals(home)).toEqual([]);
  });

  it('reject drops it; skip keeps it', async () => {
    await appendProposals([prop({ id: 'a' }), prop({ id: 'b', text: 'other' })], home);
    const h = harness(['r', 's']);
    await lessonsReviewCommand(h.deps);
    expect((await readProposals(home)).map((p) => p.id)).toEqual(['b']);
    expect(await readLessons('web', home)).toEqual([]);
    expect(h.text()).toContain('Accepted 0, rejected 1, kept 1.');
  });

  it('unknown answer re-asks once, then skips', async () => {
    await appendProposals([prop()], home);
    const h = harness(['x', 'y']);
    await lessonsReviewCommand(h.deps);
    expect(h.asked).toHaveLength(2);
    expect(await readProposals(home)).toHaveLength(1);
  });

  it('full file refuses and keeps the proposal', async () => {
    for (let i = 0; i < 20; i++) await addLesson('web', `lesson ${i}`, home);
    await appendProposals([prop()], home);
    const h = harness(['a']);
    await lessonsReviewCommand(h.deps);
    expect(h.text()).toContain('web.md has 20 lessons');
    expect(await readProposals(home)).toHaveLength(1);
    expect(h.text()).toContain('Accepted 0, rejected 0, kept 1.');
  });

  it('a tampered target is refused and the proposal kept', async () => {
    await appendProposals([prop({ target: '../../evil' })], home);
    const h = harness(['a']);
    await lessonsReviewCommand(h.deps);
    expect(await readProposals(home)).toHaveLength(1);
    expect(h.text()).toContain('Not added: Unknown lesson file');
  });

  it('plugin proposal prints the add command and never installs', async () => {
    await appendProposals([prop({ kind: 'plugin', target: undefined, text: undefined, plugin: 'cave@acme/mkt', stage: 'build' })], home);
    const h = harness(['a']);
    await lessonsReviewCommand(h.deps);
    expect(h.text()).toContain('To add it: anton plugins add cave@acme/mkt');
    expect(h.text()).toContain('and list it under stages.build in ~/anton/config.yaml');
    expect(await readProposals(home)).toEqual([]);
    expect(h.text()).toContain('Accepted 1');
  });

  it('strips control characters from queued fields', async () => {
    await appendProposals([prop({ why: 'bad\u001b[31mred' })], home);
    const h = harness(['s']);
    await lessonsReviewCommand(h.deps);
    expect(h.text()).not.toContain('\u001b');
  });

  it('bidi and zero-width characters are neither shown nor saved', async () => {
    await appendProposals([prop({ text: 'Run \u202Elint\u200B first', why: 'w\u2067hy' })], home);
    const h = harness(['a']);
    await lessonsReviewCommand(h.deps);
    expect(h.text()).not.toMatch(/[\u200B\u202E\u2067]/);
    expect(h.text()).toContain('Lesson for web.md: Run lint first');
    expect((await readLessons('web', home)).map((l) => l.text)).toEqual(['Run lint first']);
  });

  it('collect notes and failures (job folder names) print without control characters', async () => {
    const repo = join(home, 'projects', 'p');
    const dir = join(repo, '.anton', 'jobs', '1-\u001b[31mred');
    await mkdir(dir, { recursive: true });
    await registerProject('p', repo);
    await writeFile(join(dir, 'retro.json'), 'not json');
    const h = harness();
    await lessonsReviewCommand(h.deps);
    expect(h.text()).toContain('Retro failed: p/1-[31mred: retro.json is unreadable');
    expect(h.text()).not.toContain('\u001b');
  });

  it('list prints lesson text without control characters', async () => {
    await mkdir(join(home, 'lessons'), { recursive: true });
    await writeFile(join(home, 'lessons', 'web.md'), '- [L-0000000a] hand \u001b[2Jedited\u202E\n');
    const h = harness();
    await lessonsListCommand(h.deps);
    expect(h.text()).toContain('L-0000000a  hand [2Jedited');
    expect(h.text()).not.toMatch(/[\u001b\u202E]/);
  });

  it('a batch still running is reported before the empty-queue line', async () => {
    const repo = join(home, 'projects', 'p');
    const dir = join(repo, '.anton', 'jobs', '1-init');
    await mkdir(dir, { recursive: true });
    await registerProject('p', repo);
    await writeFile(join(dir, 'retro.json'), JSON.stringify({ status: 'submitted', batchId: 'msgbatch_1', submittedAt: 't' }));
    const h = harness();
    const client = { createBatch: async () => 'x', getBatch: async () => ({ ended: false as const }), send: async () => { throw new Error('unused'); } };
    h.deps.retro = { home, env: { ANTHROPIC_API_KEY: 'test-key-not-real' }, client: () => client };
    await lessonsReviewCommand(h.deps);
    expect(h.text()).toContain('1 Retro(s) still running — try again later.\nNo lessons waiting.');
  });

  it('empty queue prints No lessons waiting.', async () => {
    const h = harness();
    expect(await lessonsReviewCommand(h.deps)).toBe(0);
    expect(h.text()).toContain('No lessons waiting.');
  });

  it('no TTY lists and changes nothing', async () => {
    await appendProposals([prop()], home);
    const h = harness(['a'], false);
    expect(await lessonsReviewCommand(h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.text()).toContain('Run the linter first');
    expect(await readProposals(home)).toHaveLength(1);
    expect(await readLessons('web', home)).toEqual([]);
  });

  it('list shows counts and ids', async () => {
    const l = await addLesson('web', 'one', home);
    const h = harness();
    expect(await lessonsListCommand(h.deps)).toBe(0);
    expect(h.text()).toContain('web.md (1/20)');
    expect(h.text()).toContain(`${l.id}  one`);
    expect(h.text()).toContain('fallback.md (0/20)');
  });

  it('remove deletes by id', async () => {
    const l = await addLesson('web', 'one', home);
    const h = harness();
    expect(await lessonsRemoveCommand(l.id, h.deps)).toBe(0);
    expect(await readLessons('web', home)).toEqual([]);
    expect(await lessonsRemoveCommand('L-00000000', harness().deps)).toBe(1);
  });
});
