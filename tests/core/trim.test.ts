import { describe, expect, it } from 'vitest';
import { trimOutput } from '../../src/core/trim.js';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

describe('trimOutput', () => {
  it('returns short text unchanged', () => {
    expect(trimOutput('a\nb\nc')).toBe('a\nb\nc');
  });

  it('returns text at exactly head+tail lines unchanged', () => {
    const t = lines(120);
    expect(trimOutput(t)).toBe(t);
  });

  it('trims 500 lines to 40 + 80 + 1 lines', () => {
    const out = trimOutput(lines(500));
    const parts = out.split('\n');
    expect(parts).toHaveLength(121);
    expect(parts[0]).toBe('line 1');
    expect(parts[39]).toBe('line 40');
    expect(parts[41]).toBe('line 421');
    expect(parts[120]).toBe('line 500');
  });

  it('marker mentions trimmed count', () => {
    const out = trimOutput(lines(500));
    expect(out.split('\n')[40]).toBe('… [380 lines trimmed] …');
  });

  it('marker includes fullPath when given', () => {
    const out = trimOutput(lines(500), { fullPath: '/x/log.txt' });
    expect(out.split('\n')[40]).toBe('… [380 lines trimmed; full output at /x/log.txt] …');
  });

  it('honors custom head/tail', () => {
    const out = trimOutput(lines(10), { headLines: 2, tailLines: 3 });
    expect(out.split('\n')).toEqual(['line 1', 'line 2', '… [5 lines trimmed] …', 'line 8', 'line 9', 'line 10']);
  });
});
