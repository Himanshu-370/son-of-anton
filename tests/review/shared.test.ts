import { describe, it, expect } from 'vitest';
import { fenceDiff, MAX_DIFF_CHARS, MAX_DIFF_LINE_CHARS } from '../../src/review/shared.js';

describe('fenceDiff size caps', () => {
  it('caps each diff line at 2000 chars with a truncation marker', () => {
    expect(MAX_DIFF_LINE_CHARS).toBe(2000);
    const long = '+' + 'x'.repeat(5000);
    const out = fenceDiff(`diff --git a/x b/x\n${long}\n+short`);
    const line = out.split('\n').find((l) => l.startsWith('+x'))!;
    expect(line).toBe('+' + 'x'.repeat(1999) + '… [line truncated]');
    expect(out).toContain('+short');
  });

  it('caps the whole trimmed diff at 60000 chars with a marker', () => {
    expect(MAX_DIFF_CHARS).toBe(60000);
    // 700 lines of 1000 chars: under the 800-line trim, but ~700k chars.
    const diff = Array.from({ length: 700 }, (_, i) => `+${String(i).padStart(4, '0')}${'y'.repeat(995)}`).join('\n');
    const out = fenceDiff(diff);
    expect(out.length).toBeLessThan(MAX_DIFF_CHARS + 500);
    expect(out).toContain('[diff truncated at 60000 characters; read the full code in /workspace]');
    expect(out.startsWith('```diff\n+0000')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('leaves a small diff unchanged', () => {
    expect(fenceDiff('+a\n-b')).toBe('```diff\n+a\n-b\n```');
  });
});
