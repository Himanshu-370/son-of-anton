import { describe, it, expect } from 'vitest';
import { kitByName, KITS, selectKit } from '../../src/kits/index.js';
import { fallbackKit } from '../../src/kits/fallback/index.js';
import { webKit } from '../../src/kits/web/index.js';

describe('kit registry', () => {
  it('files with next.config.js select web', () => {
    expect(webKit.detect('a tool', ['package.json', 'next.config.js'])).toBe(0.9);
    expect(selectKit('a tool', ['package.json', 'next.config.js'])).toBe(webKit);
    expect(selectKit('x', ['src/App.tsx'])).toBe(webKit);
    expect(selectKit('x', ['public/index.html'])).toBe(webKit);
  });

  it('web-ish description with no files selects web', () => {
    expect(webKit.detect('Build a habit tracker web app', [])).toBe(0.8);
    expect(selectKit('A landing page for my bakery', [])).toBe(webKit);
    expect(selectKit('a React dashboard', [])).toBe(webKit);
  });

  it('CLI description selects fallback', () => {
    expect(webKit.detect('A CLI that sums numbers', ['main.py', 'README.md'])).toBe(0);
    expect(fallbackKit.detect('anything', [])).toBe(0.1);
    expect(selectKit('A CLI that sums numbers', ['main.py'])).toBe(fallbackKit);
  });

  it('registry lists web then fallback; kitByName finds each', () => {
    expect(KITS).toEqual([webKit, fallbackKit]);
    expect(kitByName('web')).toBe(webKit);
    expect(kitByName('fallback')).toBe(fallbackKit);
  });
});
