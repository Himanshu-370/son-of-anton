import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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

  it('fallback verify kills container processes before host evidence writes', async () => {
    const d = fake(0);
    await fallbackKit.verify(mk({ install: 'npm i', test: 'npm test', run: 'npm start' }), d);
    const kill = d.calls.indexOf('kill -s KILL -- -1 2>/dev/null; true');
    expect(kill).toBeGreaterThan(d.calls.findIndex((c) => c.includes('npm test')));
    expect(kill).toBeGreaterThan(d.calls.findIndex((c) => c.includes('npm start')));
    expect(kill).toBeLessThan(d.calls.findIndex((c) => c.startsWith('cat ')));
  });

  it('install failure kills container processes before writing evidence', async () => {
    const d = fake(0, 2);
    await fallbackKit.verify(mk({ install: 'npm i', test: 'npm test' }), d);
    expect(d.calls).toEqual(['npm i', 'kill -s KILL -- -1 2>/dev/null; true']);
  });

  it('baseline install failure kills container processes', async () => {
    const d = fake(0, 2);
    const out = await fallbackKit.baseline(mk({ install: 'npm i', test: 'npm test' }), d);
    expect(out.ran).toBe(false);
    expect(d.calls).toEqual(['npm i', 'kill -s KILL -- -1 2>/dev/null; true']);
  });

  it('evidence dir swapped for a symlink during the tests: verify and baseline refuse the host write', async () => {
    for (const which of ['verify', 'baseline'] as const) {
      const repo = mkdtempSync(join(tmpdir(), 'repo-'));
      const jobDir = join(repo, '.anton', 'jobs', 'j');
      mkdirSync(join(jobDir, 'evidence'), { recursive: true });
      const target = mkdtempSync(join(tmpdir(), 'host-target-'));
      const runIn = async (_c: string, cmd: string) => {
        if (cmd.includes('npm test')) {
          rmSync(join(jobDir, 'evidence'), { recursive: true });
          symlinkSync(target, join(jobDir, 'evidence'));
        }
        return { exitCode: 0, stdout: cmd.startsWith('cat ') ? xml : '', stderr: '' };
      };
      const ctx = { ...mk({ install: 'npm i', test: 'npm test' }), jobDir, repo, stage: { repo } as never };
      const run = which === 'verify' ? fallbackKit.verify(ctx, { runIn }) : fallbackKit.baseline(ctx, { runIn });
      await expect(run).rejects.toThrow(/symlink/);
      expect(readdirSync(target)).toEqual([]);
    }
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

  it('baseline lists passing testcases from a separate junit file; install failure → ran false', async () => {
    const cmds = { install: 'npm i', test: 'npm test' };
    const ok = fake(0);
    expect(await fallbackKit.baseline({ container: 'c', jobDir: mk(cmds).jobDir, commands: cmds }, ok)).toEqual({ passingTests: ['AC-1 ok'], ran: true });
    expect(ok.calls.some((c) => c.includes('baseline-junit.xml'))).toBe(true);
    const bad = fake(0, 1);
    expect(await fallbackKit.baseline({ container: 'c', jobDir: mk(cmds).jobDir, commands: cmds }, bad)).toEqual({ passingTests: [], ran: false });
    const none = fake(0, 0, null);
    expect((await fallbackKit.baseline({ container: 'c', jobDir: mk(cmds).jobDir, commands: cmds }, none)).ran).toBe(false);
  });
});

describe('fallbackKit redaction', () => {
  const S = { TOKEN: 'FAKE_SECRET_VALUE_123' };
  it('test-output.txt, failure report and junit are redacted', async () => {
    const leaky = `<testsuite><testcase name="AC-1 ok"/><testcase name="AC-2 bad"><failure message="saw FAKE_SECRET_VALUE_123"/></testcase></testsuite>`;
    const d = fake(0, 0, leaky);
    const ctx = { ...mk({ install: 'npm i', test: 'npm test' }), secrets: S };
    const run = async (c: string, cmd: string) => {
      const r = await d.runIn(c, cmd);
      return cmd === 'npm test' || cmd.includes('npm test') ? { ...r, stdout: 'out FAKE_SECRET_VALUE_123' } : r;
    };
    const out = await fallbackKit.verify(ctx, { runIn: run });
    const text = readFileSync(join(ctx.jobDir, 'evidence', 'test-output.txt'), 'utf8');
    expect(text).not.toContain('FAKE_SECRET_VALUE_123');
    expect(text).toContain('[REDACTED:TOKEN]');
    expect(JSON.stringify(out)).not.toContain('FAKE_SECRET_VALUE_123');
  });
});

describe('fallbackKit XML-escaped secrets and junit on disk', () => {
  const S = { TOKEN: 'FAKE&VALUE_123' };
  const leaky = `<testsuite><testcase name="AC-1 FAKE&amp;VALUE_123"/><testcase name="AC-2 bad"><failure message="x"/></testcase></testsuite>`;
  const run = async (_c: string, cmd: string) =>
    cmd.startsWith('cat ') ? { exitCode: 0, stdout: leaky, stderr: '' } : { exitCode: 0, stdout: '', stderr: '' };

  it('junit.xml and baseline-junit.xml are rewritten redacted; baseline and verify names agree', async () => {
    const ctx = { ...mk({ install: 'npm i', test: 'npm test' }), secrets: S };
    const v = await fallbackKit.verify(ctx, { runIn: run });
    const b = await fallbackKit.baseline(ctx, { runIn: run });
    for (const f of ['junit.xml', 'baseline-junit.xml']) {
      const t = readFileSync(join(ctx.jobDir, 'evidence', f), 'utf8');
      expect(t, f).not.toContain('VALUE_123');
      expect(t).toContain('[REDACTED:TOKEN]');
    }
    const passed = v.tests.filter((t) => t.passed).map((t) => t.name);
    expect(b.passingTests).toEqual(passed);
    expect(b.passingTests[0]).toContain('[REDACTED:TOKEN]');
  });
});

describe('fallbackKit testsRan', () => {
  const cmds = { install: 'npm i', test: 'npm test' };
  it('false on install failure, missing XML and invalid XML; true on valid XML', async () => {
    expect((await fallbackKit.verify(mk(cmds), fake(0, 2))).testsRan).toBe(false);
    expect((await fallbackKit.verify(mk(cmds), fake(0, 0, null))).testsRan).toBe(false);
    expect((await fallbackKit.verify(mk(cmds), fake(0, 0, 'not xml'))).testsRan).toBe(false);
    expect((await fallbackKit.verify(mk(cmds), fake(0))).testsRan).toBe(true);
  });
});
