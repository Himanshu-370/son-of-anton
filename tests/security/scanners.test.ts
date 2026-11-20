import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScanners } from '../../src/security/scanners.js';
import { scannerRef } from '../../src/security/review.js';

const fx = (n: string): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', n), 'utf8');

type R = { exitCode: number; stdout: string; stderr: string };
const r = (exitCode: number, stdout = '', stderr = ''): R => ({ exitCode, stdout, stderr });

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
      key: '0000000000000000000000000000000000000000:config.js:aws-access-token:1',
      message: expect.stringContaining('AWS'),
    });
    expect(f.cmds.some((c) => c.includes('timeout 300') && c.includes('--report-path /tmp/gitleaks.json'))).toBe(true);
  });

  it('two gitleaks hits of the same rule in the same file get different refs', async () => {
    const [a] = JSON.parse(fx('gitleaks.json'));
    const b = { ...a, StartLine: 9, Fingerprint: 'other-fingerprint' };
    const out = await runScanners('c', { runIn: fake({ gitleaks: r(1), report: r(0, JSON.stringify([a, b])) }).runIn });
    const refs = out.findings.map(scannerRef);
    expect(refs).toHaveLength(2);
    expect(new Set(refs).size).toBe(2);
  });

  it('the same semgrep match on a shifted line keeps its ref', async () => {
    const withLine = (line: number): string => {
      const sg = JSON.parse(fx('semgrep.json'));
      sg.results = [{ ...sg.results[1], start: { line }, extra: { ...sg.results[1].extra, lines: 'eval(req.body.x)' } }];
      return JSON.stringify(sg);
    };
    const ref = async (line: number) =>
      scannerRef((await runScanners('c', { runIn: fake({ semgrep: r(0, withLine(line)) }).runIn })).findings.find((x) => x.tool === 'semgrep')!);
    expect(await ref(3)).toBe(await ref(40));
  });

  const sgRefs = async (hits: Array<{ line: number; lines: string; rule?: string }>): Promise<string[]> => {
    const sg = JSON.parse(fx('semgrep.json'));
    sg.results = hits.map((h) => ({
      ...sg.results[1], check_id: h.rule ?? 'r.eval', start: { line: h.line }, extra: { ...sg.results[1].extra, lines: h.lines },
    }));
    const out = await runScanners('c', { runIn: fake({ semgrep: r(0, JSON.stringify(sg)) }).runIn });
    return out.findings.filter((x) => x.tool === 'semgrep').map(scannerRef);
  };

  it('requires-login: two hits of one rule in one file get different refs', async () => {
    const refs = await sgRefs([{ line: 3, lines: 'requires login' }, { line: 9, lines: 'requires login' }]);
    expect(new Set(refs).size).toBe(2);
  });

  it('identical matched lines at two places get different refs', async () => {
    const refs = await sgRefs([{ line: 3, lines: 'eval(x)' }, { line: 9, lines: '  eval(x)' }]);
    expect(new Set(refs).size).toBe(2);
  });

  it('an indentation-only change keeps the ref', async () => {
    const [a] = await sgRefs([{ line: 3, lines: 'eval(x)' }]);
    const [b] = await sgRefs([{ line: 3, lines: '    eval(x)  ' }]);
    expect(a).toBe(b);
  });

  it('gitleaks without Fingerprint falls back to file:rule:line, never "undefined"', async () => {
    const [a] = JSON.parse(fx('gitleaks.json'));
    const { Fingerprint: _f, ...noFp } = a;
    const { StartLine: _l, ...noLine } = noFp;
    const keys = async (x: object) =>
      (await runScanners('c', { runIn: fake({ gitleaks: r(1), report: r(0, JSON.stringify([x])) }).runIn })).findings[0]!.key;
    expect(await keys(noFp)).toBe('config.js:aws-access-token:1');
    expect(await keys(noLine)).toBe('config.js:aws-access-token:?');
  });

  it('osv key is the vulnerability id', async () => {
    const out = await runScanners('c', { runIn: fake({ osv: r(1, fx('osv.json')) }).runIn });
    expect(out.findings.find((x) => x.tool === 'osv-scanner')!.key).toBe('GHSA-29mw-wpgm-hmr9');
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

  it('gitleaks command removes any stale report first', async () => {
    const f = fake({});
    await runScanners('c', { runIn: f.runIn });
    expect(f.cmds.find((c) => c.includes('gitleaks detect'))!.startsWith('rm -f /tmp/gitleaks.json;')).toBe(true);
  });

  it('gitleaks exit 0 with missing or empty report → no findings, not unavailable', async () => {
    for (const rep of [r(1, '', 'cat: no such file'), r(0, '')]) {
      const out = await runScanners('c', { runIn: fake({ gitleaks: r(0), report: rep }).runIn });
      expect(out.unavailable).toEqual([]);
      expect(out.findings).toEqual([]);
    }
  });

  it('gitleaks exit 1 with missing/empty report → unavailable', async () => {
    for (const rep of [r(1, '', 'cat: no such file'), r(0, '')]) {
      const out = await runScanners('c', { runIn: fake({ gitleaks: r(1), report: rep }).runIn });
      expect(out.unavailable).toEqual(['gitleaks']);
    }
  });

  it('osv exit 128 is "no findings" only for empty stdout + "No package sources" stderr', async () => {
    const ok = await runScanners('c', { runIn: fake({ osv: r(128, '', 'Error: No package sources found') }).runIn });
    expect(ok.unavailable).toEqual([]);
    const other = await runScanners('c', { runIn: fake({ osv: r(128, '', 'boom') }).runIn });
    expect(other.unavailable).toEqual(['osv-scanner']);
    const withOut = await runScanners('c', { runIn: fake({ osv: r(128, '{}', 'No package sources found') }).runIn });
    expect(withOut.unavailable).toEqual(['osv-scanner']);
  });

  it('semgrep with non-empty errors keeps findings but flags partial', async () => {
    const sg = JSON.parse(fx('semgrep.json'));
    sg.errors = [{ code: 3, message: 'parse error' }];
    const out = await runScanners('c', { runIn: fake({ semgrep: r(0, JSON.stringify(sg)) }).runIn });
    expect(out.unavailable).toEqual(['semgrep (partial)']);
    expect(out.findings.filter((x) => x.tool === 'semgrep')).toHaveLength(5);
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
