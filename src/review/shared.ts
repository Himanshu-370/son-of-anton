import { createHash } from 'node:crypto';
import { trimOutput } from '../core/trim.js';

/** First 8 hex chars of sha256(text). */
export function sha8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** Longest diff line kept in a reviewer prompt (minified bundles and lockfiles have huge lines). */
export const MAX_DIFF_LINE_CHARS = 2000;
/** Cap on the whole trimmed diff in a reviewer prompt. */
export const MAX_DIFF_CHARS = 60000;

function capLine(line: string): string {
  return line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS)}… [line truncated]` : line;
}

/**
 * Caps each line at MAX_DIFF_LINE_CHARS, trims to 400 head / 400 tail lines, caps the result at
 * MAX_DIFF_CHARS, and wraps it in a fence longer than any backtick run inside it.
 */
export function fenceDiff(diff: string): string {
  let trimmed = trimOutput(diff.split('\n').map(capLine).join('\n'), { headLines: 400, tailLines: 400 });
  if (trimmed.length > MAX_DIFF_CHARS) {
    trimmed = `${trimmed.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated at ${MAX_DIFF_CHARS} characters; read the full code in /workspace]`;
  }
  return fenceText(trimmed, 'diff');
}

/** Wraps text in a code fence longer than any backtick run inside it. */
export function fenceText(text: string, lang = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return [`${fence}${lang}`, text, fence].join('\n');
}
