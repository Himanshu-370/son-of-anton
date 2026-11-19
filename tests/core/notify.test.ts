import { describe, it, expect } from 'vitest';
import { notify } from '../../src/core/notify.js';
import type { ExecFn } from '../../src/core/exec.js';

describe('notify', () => {
  it('notify escapes double quotes', async () => {
    const calls: [string, string[]][] = [];
    const exec: ExecFn = async (c, a) => { calls.push([c, a]); return { exitCode: 0, stdout: '', stderr: '' }; };
    await notify('Ti"tle', 'say "hi"', exec, 'darwin');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('osascript');
    expect(calls[0][1][0]).toBe('-e');
    expect(calls[0][1][1]).toBe('display notification "say \\"hi\\"" with title "Ti\\"tle"');
  });

  it('notify swallows exec failure', async () => {
    const exec: ExecFn = async () => { throw new Error('boom'); };
    await expect(notify('t', 'm', exec, 'darwin')).resolves.toBeUndefined();
  });

  it('is a no-op on other platforms', async () => {
    let n = 0;
    const exec: ExecFn = async () => { n++; return { exitCode: 0, stdout: '', stderr: '' }; };
    await notify('t', 'm', exec, 'linux');
    expect(n).toBe(0);
  });
});
