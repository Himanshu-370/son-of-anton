import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { addLesson, removeLesson, readLessons, cleanLessonText } from '../../src/lessons/store.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'anton-lessons-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
const log = async () => (await execa('git', ['log', '--format=%s'], { cwd: join(home, 'lessons') })).stdout.split('\n');

describe('lessons store', () => {
  it('add writes the line, inits git and commits', async () => {
    const l = await addLesson('web', 'Run the linter first', home);
    expect(l.id).toMatch(/^L-[0-9a-f]{8}$/);
    expect(await readFile(join(home, 'lessons', 'web.md'), 'utf8')).toBe(`- [${l.id}] Run the linter first\n`);
    expect(await log()).toEqual([`lessons: add ${l.id} to web`]);
    expect(await readLessons('web', home)).toEqual([l]);
  });

  it('C1 controls are stripped from lessons', () => {
    expect(cleanLessonText('Run\u0085 the\u009b lint\u009f first')).toBe('Run the lint first');
  });

  it('an untracked .gitignore is committed with the next lesson', async () => {
    const dir = join(home, 'lessons');
    const git = (...a: string[]) => execa('git', a, { cwd: dir });
    await addLesson('web', 'First lesson', home);
    // Simulate a Phase 5a leftover: the file exists on disk but git never tracked it.
    await git('rm', '-q', '--cached', '.gitignore');
    await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'untrack');
    await addLesson('web', 'Second lesson', home);
    expect((await git('ls-files', '.gitignore')).stdout).toBe('.gitignore');
    expect((await git('status', '--porcelain')).stdout).toBe('');
  });

  it('the first lesson commits a .gitignore that keeps proposals.jsonl untracked', async () => {
    const l = await addLesson('web', 'Run the linter first', home);
    await writeFile(join(home, 'lessons', 'proposals.jsonl'), '{}\n');
    const git = (...a: string[]) => execa('git', a, { cwd: join(home, 'lessons') });
    expect(await readFile(join(home, 'lessons', '.gitignore'), 'utf8')).toBe('proposals.jsonl\n');
    expect((await git('show', '--name-only', '--format=', 'HEAD')).stdout.split('\n').sort()).toEqual(['.gitignore', 'web.md']);
    expect((await git('status', '--porcelain')).stdout).toBe('');
    expect(await log()).toEqual([`lessons: add ${l.id} to web`]);
  });

  it('21st lesson is refused with the remove hint', async () => {
    for (let i = 0; i < 20; i++) await addLesson('web', `lesson ${i}`, home);
    await expect(addLesson('web', 'one too many', home)).rejects.toThrow('web.md has 20 lessons — remove one with anton lessons remove <id>');
  });

  it('duplicate lesson is refused', async () => {
    await addLesson('web', 'same', home);
    await expect(addLesson('web', 'same', home)).rejects.toThrow(/duplicate/i);
  });

  it('text is cleaned to one line', async () => {
    expect(cleanLessonText('  a\u0000b\n\n c\t d  ')).toBe('ab c d');
    expect(() => cleanLessonText(' \n ')).toThrow('Lesson is empty');
  });

  it('invisible and bidi format characters are stripped before saving', async () => {
    const l = await addLesson('web', 'Run \u202Elint\u200B first\u2066\uFEFF', home);
    expect(l.text).toBe('Run lint first');
    expect(await readFile(join(home, 'lessons', 'web.md'), 'utf8')).toBe(`- [${l.id}] Run lint first\n`);
  });

  it('over 300 characters is refused', async () => {
    await expect(addLesson('web', 'x'.repeat(301), home)).rejects.toThrow('Lesson is longer than 300 characters');
  });

  it('remove rewrites the file and commits', async () => {
    const a = await addLesson('web', 'one', home);
    const b = await addLesson('fallback', 'two', home);
    const r = await removeLesson(a.id, home);
    expect(r).toEqual({ file: 'web', lesson: a });
    expect(await readLessons('web', home)).toEqual([]);
    expect(await readLessons('fallback', home)).toEqual([b]);
    expect((await log())[0]).toBe(`lessons: remove ${a.id}`);
    await expect(removeLesson('L-00000000', home)).rejects.toThrow('No lesson L-00000000');
  });

  it('malformed lines are ignored', async () => {
    await mkdir(join(home, 'lessons'), { recursive: true });
    await writeFile(join(home, 'lessons', 'web.md'), '# title\n- [L-abcdef12] good\nrandom\n- [bad] no\n');
    expect(await readLessons('web', home)).toEqual([{ id: 'L-abcdef12', text: 'good' }]);
    expect(await readLessons('fallback', home)).toEqual([]);
  });
});
