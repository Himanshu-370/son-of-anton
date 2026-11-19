import { createHash } from 'node:crypto';
import { trimOutput } from '../core/trim.js';

/** First 8 hex chars of sha256(text). */
export function sha8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** Trims a diff to 400 head / 400 tail lines and wraps it in a fence longer than any backtick run inside it. */
export function fenceDiff(diff: string): string {
  const trimmed = trimOutput(diff, { headLines: 400, tailLines: 400 });
  const longest = Math.max(0, ...(trimmed.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}diff`, trimmed, fence].join('\n');
}
