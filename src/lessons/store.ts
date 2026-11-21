import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import type { Role } from '../core/config.js';
import { commitPaths, initRepoIfMissing } from '../core/git.js';
import { antonHome } from '../core/paths.js';
import { sha8 } from '../review/shared.js';

export const MAX_LESSONS_PER_FILE = 20;
const MAX_LEN = 300;

/** Roles without an entry (coach, plugin_reviewer) get no lessons. */
export const LESSON_FILES: Partial<Record<Role, string>> = {
  pm: 'spec-pm',
  tech_lead: 'plan-tech-lead',
  frontend: 'build-frontend',
  backend: 'build-backend',
  infra: 'build-infra',
  qa: 'verify-qa',
  code_reviewer: 'code-reviewer',
  security_reviewer: 'security-reviewer',
  browser_tester: 'verify-browser-tester',
  mapper: 'repo-mapper',
};
export const KIT_LESSON_FILES = ['fallback', 'web'];

export type Lesson = { id: string; text: string };

const LINE = /^- \[(L-[0-9a-f]{8})\] (.+)$/;
const dir = (home: string) => join(home, 'lessons');
const path = (file: string, home: string) => join(dir(home), `${file}.md`);
const idOf = (file: string, text: string) => `L-${sha8(`${file}\n${text}`)}`;

export function cleanLessonText(s: string): string {
  // \p{Cf} (zero-width, bidi overrides, BOM) could make the shown text differ from what reaches prompts.
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('Lesson is empty');
  if (t.length > MAX_LEN) throw new Error(`Lesson is longer than ${MAX_LEN} characters`);
  return t;
}

export async function readLessons(file: string, home = antonHome()): Promise<Lesson[]> {
  let raw: string;
  try {
    raw = await readFile(path(file, home), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return raw.split('\n').flatMap((l) => {
    const m = LINE.exec(l);
    return m ? [{ id: m[1]!, text: m[2]! }] : [];
  });
}

const render = (ls: Lesson[]) => ls.map((l) => `- [${l.id}] ${l.text}\n`).join('');

export async function addLesson(file: string, text: string, home = antonHome()): Promise<Lesson> {
  const clean = cleanLessonText(text);
  const lesson = { id: idOf(file, clean), text: clean };
  const all = await readLessons(file, home);
  if (all.some((l) => l.id === lesson.id)) throw new Error(`Duplicate lesson ${lesson.id} in ${file}.md`);
  if (all.length >= MAX_LESSONS_PER_FILE) {
    throw new Error(`${file}.md has ${MAX_LESSONS_PER_FILE} lessons — remove one with anton lessons remove <id>`);
  }
  await initRepoIfMissing(dir(home));
  await writeFileAtomic(path(file, home), render([...all, lesson]));
  await commitPaths(dir(home), [`${file}.md`], `lessons: add ${lesson.id} to ${file}`);
  return lesson;
}

export async function removeLesson(id: string, home = antonHome()): Promise<{ file: string; lesson: Lesson }> {
  for (const file of [...Object.values(LESSON_FILES), ...KIT_LESSON_FILES] as string[]) {
    const all = await readLessons(file, home);
    const lesson = all.find((l) => l.id === id);
    if (!lesson) continue;
    await writeFileAtomic(path(file, home), render(all.filter((l) => l !== lesson)));
    await commitPaths(dir(home), [`${file}.md`], `lessons: remove ${id}`);
    return { file, lesson };
  }
  throw new Error(`No lesson ${id}`);
}
