import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScanners } from '../../src/security/scanners.js';

const fx = (n: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', n), 'utf8');

type R = { exitCode: number; stdout: string; stderr: string };
const r = (exitCode: number, stdout = ''): R => ({ exitCode, stdout, stderr: '' });

type Outs = { gitleaks?: R; report?: R; osv?: R; semgrep?: R };
function fake(o: Outs) {
  const cmds: string[] = [];
  const runIn = async (_c: string, cmd: string): Promise<R> => {
    cmds.push(cmd);
    if (cmd.includes('cat /tmp/gitleaks.json')) return o.report ?? r(0, '[]');
    if (cmd.includes('gitleaks detect')) return o.gitleaks ?? r(0);
    if (cmd.includes('osv-scanner')) return o.osv ?? r(0, '{"results":[]}');
    if (cmd.includes('semgrep')) return o.semgrep ?? r(0, '{"results":[]}');
    return r(0);
  };
  return { runIn, cmds };
}

const osvWith = (score: string): string => {
  const o = JSON.parse(fx('osv.json'));
  const pkg = o.results[0].packages[0];
  pkg.groups = [{ ...pkg.groups[0], max_severity: score }];
  return JSON.stringify(o);
};

describe('runScanners', () => {
  it('maps gitleaks leak to high', async () => {
    const f = fake({ gitleaks: r(1), report: r(0, fx('gitleaks.json')) });
    const out = await runScanners('c', { runIn: f.runIn });
    expect(out.unavailable).toEqual([]);
    expect(out.findings).toContainEqual({
      tool: 'gitleaks',
      ruleId: 'aws-access-token',
      severity: 'high',
      file: 'config.js',
      line: 1,
      message: expect.stringContaining('AWS'),
    });
    expect(f.cmds.some((c) => c.includes('timeout 300') && c.includes('--report-path /tmp/gitleaks.json'))).toBe(true);
  });

  it('maps osv CVSS 9.8 to critical, 5.0 to medium', async () => {
    const hi = await runScanners('c', { runIn: fake({ osv: r(1, osvWith('9.8')) }).runIn });
    const osvHi = hi.findings.filter((x) => x.tool === 'osv-scanner');
    expect(osvHi).toHaveLength(1);
    expect(osvHi[0]!.severity).toBe('critical');
    expect(osvHi[0]!.file).toBe('package-lock.json');
    const lo = await runScanners('c', { runIn: fake({ osv: r(1, osvWith('5.0')) }).runIn });
    expect(lo.findings.find((x) => x.tool === 'osv-scanner')!.severity).toBe('medium');
  });

  it('maps osv 7.0 to high, 3.9 to low, missing score to medium', async () => {
    const sev = async (s: string) =>
      (await runScanners('c', { runIn: fake({ osv: r(1, osvWith(s)) }).runIn })).findings[0]!.severity;
    expect(await sev('7.0')).toBe('high');
    expect(await sev('3.9')).toBe('low');
    expect(await sev('')).toBe('medium');
  });

  it('real osv fixture yields one finding per group', async () => {
    const out = await runScanners('c', { runIn: fake({ osv: r(1, fx('osv.json')) }).runIn });
    const osv = out.findings.filter((x) => x.tool === 'osv-scanner');
    expect(osv.map((x) => x.severity).sort()).toEqual(['high', 'high', 'high', 'medium', 'medium']);
  });

  it('maps semgrep ERROR/WARNING/INFO to high/medium/low', async () => {
    const out = await runScanners('c', { runIn: fake({ semgrep: r(0, fx('semgrep.json')) }).runIn });
    const by = Object.fromEntries(out.findings.filter((x) => x.tool === 'semgrep').map((x) => [x.ruleId.split('.').pop(), x]));
    expect(by['code-string-concat']!.severity).toBe('high');
    expect(by['eval-detected']!.severity).toBe('medium');
    expect(by['express-check-csurf-middleware-usage']!.severity).toBe('low');
    expect(by['eval-detected']!.file).toBe('app.js');
    expect(by['eval-detected']!.line).toBeGreaterThan(0);
  });

  it('missing tool (exit 127) → unavailable, no throw', async () => {
    const out = await runScanners('c', { runIn: fake({ osv: r(127), semgrep: r(127), gitleaks: r(127) }).runIn });
    expect(out.unavailable.sort()).toEqual(['gitleaks', 'osv-scanner', 'semgrep']);
    expect(out.findings).toEqual([]);
  });

  it('timeout (exit 124) → unavailable', async () => {
    const out = await runScanners('c', { runIn: fake({ semgrep: r(124) }).runIn });
    expect(out.unavailable).toEqual(['semgrep']);
  });

  it('a throwing runIn → unavailable, no throw', async () => {
    const runIn = async (): Promise<R> => {
      throw new Error('docker gone');
    };
    const out = await runScanners('c', { runIn });
    expect(out.unavailable.sort()).toEqual(['gitleaks', 'osv-scanner', 'semgrep']);
  });

  it('invalid JSON → unavailable', async () => {
    const out = await runScanners('c', {
      runIn: fake({ osv: r(0, 'not json'), semgrep: r(0, '{oops'), gitleaks: r(1), report: r(0, 'nope') }).runIn,
    });
    expect(out.unavailable.sort()).toEqual(['gitleaks', 'osv-scanner', 'semgrep']);
  });

  it('findings under .anton/ and node_modules/ are dropped', async () => {
    const sg = JSON.parse(fx('semgrep.json'));
    const base = sg.results[0];
    sg.results = [
      { ...base, path: '/workspace/.anton/evidence/x.js' },
      { ...base, path: '.anton/y.js' },
      { ...base, path: 'node_modules/a/b.js' },
      { ...base, path: 'packages/p/node_modules/a/b.js' },
      { ...base, path: 'src/keep.js' },
    ];
    const gl = JSON.parse(fx('gitleaks.json'));
    gl.push({ ...gl[0], File: '/workspace/.anton/z.txt' });
    const out = await runScanners('c', {
      runIn: fake({ semgrep: r(0, JSON.stringify(sg)), gitleaks: r(1), report: r(0, JSON.stringify(gl)) }).runIn,
    });
    expect(out.findings.filter((x) => x.tool === 'semgrep').map((x) => x.file)).toEqual(['src/keep.js']);
    expect(out.findings.filter((x) => x.tool === 'gitleaks').map((x) => x.file)).toEqual(['config.js']);
  });
});
