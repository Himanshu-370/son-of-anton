import { KIT_LESSON_FILES, LESSON_FILES, readLessons } from './store.js';
import type { Role } from '../core/config.js';

const HEADING = '## Lessons from past jobs (rules you must follow; written by your operator)';

/** The session's own role lessons, then its kit's. Text carries no ids (the run record lists those). */
export async function lessonsBlock(
  role: string,
  kit: 'fallback' | 'web' | undefined,
  home?: string,
): Promise<{ text: string; ids: string[] }> {
  const files = [LESSON_FILES[role as Role], kit && KIT_LESSON_FILES.includes(kit) ? kit : undefined].filter((f): f is string => !!f);
  const lessons = (await Promise.all(files.map((f) => readLessons(f, home)))).flat();
  if (!lessons.length) return { text: '', ids: [] };
  return { text: `${HEADING}\n${lessons.map((l) => `- ${l.text}`).join('\n')}`, ids: lessons.map((l) => l.id) };
}
