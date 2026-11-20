import { describe, it, expect, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecFn } from '../../src/core/exec.js';
import { startOrReuseContainer } from '../../src/pipeline/runner.js';

describe('runner secrets guard', () => {
  it.each([0o644, 0o640])('refuses a %o secrets file before any docker call', async (mode) => {
    const home = await mkdtemp(join(tmpdir(), 'anton-runner-sec-'));
    process.env.ANTON_HOME = home;
    await mkdir(join(home, 'secrets'));
    const f = join(home, 'secrets', 'app.env');
    await writeFile(f, 'A=FAKE_VALUE_1\n');
    await chmod(f, mode);
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) as unknown as ExecFn;
    await expect(startOrReuseContainer('app', '/repo', exec)).rejects.toThrow(`Secrets file must be private: chmod 600 ${f}`);
    expect(exec).not.toHaveBeenCalled();
  });
});
