import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fallbackKit } from '../../src/kits/fallback/index.js';

const checks = [
  { id: 'AC-1', text: 'one' },
  { id: 'AC-2', text: 'two' },
];
const xml = `<testsuite><testcase name="AC-1 ok"/><testcase name="AC-2 bad"><failure message="nope"/></testcase></testsuite>`;

function fake(runExit: number, installExit = 0, xmlText: string | null = xml, runOut = '') {
  const calls: string[] = [];
  const runIn = async (_c: string, cmd: string) => {
    calls.push(cmd);
    if (cmd.startsWith('rm -f')) return { exitCode: 0, stdout: '', stderr: '' };
    if (cmd.startsWith('cat ')) return xmlText === null ? { exitCode: 1, stdout: '', stderr: 'no such file' } : { exitCode: 0, stdout: xmlText, stderr: '' };
    if (cmd === 'npm i') return { exitCode: installExit, stdout: 'installing', stderr: installExit ? 'install broke' : '' };
    if (cmd.includes('npm start')) return { exitCode: runExit, stdout: runOut, stderr: '' };
    return { exitCode: 1, stdout: 'test out', stderr: '' };
  };
  return { runIn, calls };
}
const mk = (commands: { install: string; test: string; run?: string }) => ({
  container: 'c',
  jobDir: mkdtempSync(join(tmpdir(), 'job-')),
  checks,
  commands,
});

describe('fallbackKit', () => {
  it('detect is 0.1 and dockerfile is absolute', () => {
    expect(fallbackKit.detect('anything')).toBe(0.1);
    expect(fallbackKit.dockerfile.endsWith('kits/fallback/Dockerfile')).toBe(true);
  });

  it('runOk false when run command exits 1; true on 124 and when unset', async () => {
    const cmds = { install: 'npm i', test: 'npm test', run: 'npm start' };
    expect((await fallbackKit.verify(mk(cmds), fake(1))).runOk).toBe(false);
    expect((await fallbackKit.verify(mk(cmds), fake(124))).runOk).toBe(true);
    expect((await fallbackKit.verify(mk(cmds), fake(0))).runOk).toBe(true);
    expect((await fallbackKit.verify(mk({ install: 'npm i', test: 'npm test' }), fake(1))).runOk).toBe(true);
  });

  it('sets ANTON_JUNIT, saves test output, and reports only failing checks', async () => {
    const d = fake(0);
    const ctx = mk({ install: 'npm i', test: 'npm test' });
    const out = await fallbackKit.verify(ctx, d);
    expect(d.calls.some((c) => c.startsWith("export ANTON_JUNIT='/workspace/.anton/jobs/") && c.endsWith("/evidence/junit.xml'; npm test"))).toBe(true);
    expect(readFileSync(join(ctx.jobDir, 'evidence', 'test-output.txt'), 'utf8')).toContain('test out');
    expect(out.failureReport).toContain('### AC-2');
    expect(out.failureReport).toContain('nope');
    expect(out.failureReport).not.toContain('AC-1');
  });

  it('install failure fails every check with run_failed and skips tests', async () => {
    const d = fake(0, 2);
    const out = await fallbackKit.verify(mk({ install: 'npm i', test: 'npm test' }), d);
    expect(out.results.every((r) => r.reason === 'run_failed' && r.error?.includes('install broke'))).toBe(true);
    expect(d.calls.some((c) => c.includes('npm test'))).toBe(false);
  });

  it('exports ANTON_JUNIT before a chained test command', async () => {
    const d = fake(0);
    await fallbackKit.verify(mk({ install: 'npm i', test: 'cd app && npm test' }), d);
    const c = d.calls.find((x) => x.includes('cd app && npm test'))!;
    expect(c.startsWith('export ANTON_JUNIT=')).toBe(true);
    expect(c.indexOf('export')).toBeLessThan(c.indexOf('cd app'));
    expect(c).toMatch(/; cd app && npm test$/);
  });

  it('removes stale junit before running the test command', async () => {
    const d = fake(0);
    await fallbackKit.verify(mk({ install: 'npm i', test: 'npm test' }), d);
    const rm = d.calls.findIndex((x) => x.startsWith('rm -f') && x.includes('junit.xml'));
    const t = d.calls.findIndex((x) => x.includes('npm test'));
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(t);
  });

  it('missing XML puts the test output and exit code in errors and report', async () => {
    const out = await fallbackKit.verify(mk({ install: 'npm i', test: 'npm test' }), fake(0, 0, null));
    expect(out.results.every((r) => r.error?.includes('test out'))).toBe(true);
    expect(out.failureReport).toContain('test out');
    expect(out.failureReport).toContain('exited 1');
  });

  it('run failure adds a Run failed section even when checks pass', async () => {
    const allPass = '<testsuite><testcase name="AC-1 a"/><testcase name="AC-2 b"/></testsuite>';
    const out = await fallbackKit.verify(
      mk({ install: 'npm i', test: 'npm test', run: 'npm start' }),
      fake(3, 0, allPass, 'server crashed'),
    );
    expect(out.results.every((r) => r.status === 'pass')).toBe(true);
    expect(out.runOk).toBe(false);
    expect(out.failureReport).toContain('### Run failed');
    expect(out.failureReport).toContain('Exit code: 3');
    expect(out.failureReport).toContain('server crashed');
  });

  it('dockerfile path exists on disk', () => {
    expect(existsSync(fallbackKit.dockerfile)).toBe(true);
  });
});
