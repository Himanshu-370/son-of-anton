import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lessonsBlock } from '../../src/lessons/prompt.js';
import { addLesson } from '../../src/lessons/store.js';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'anton-lp-')); });

describe('lessonsBlock', () => {
  it('lists role then kit lessons', async () => {
    const r = await addLesson('build-frontend', 'Use the design tokens', home);
    const k = await addLesson('web', 'Serve on port 3000', home);
    const b = await lessonsBlock('frontend', 'web', home);
    expect(b.text).toBe(
      '## Lessons from past jobs (rules you must follow; written by your operator)\n- Use the design tokens\n- Serve on port 3000',
    );
    expect(b.ids).toEqual([r.id, k.id]);
    expect(b.text).not.toContain('L-');
  });

  it('gives an empty block when there are no lessons', async () => {
    expect(await lessonsBlock('frontend', 'web', home)).toEqual({ text: '', ids: [] });
    expect(await lessonsBlock('coach', undefined, home)).toEqual({ text: '', ids: [] });
  });

  it('a frontend session never sees backend lessons', async () => {
    await addLesson('build-backend', 'Validate input', home);
    expect((await lessonsBlock('frontend', 'fallback', home)).text).toBe('');
  });
});
