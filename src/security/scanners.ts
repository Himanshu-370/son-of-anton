import { runIn as defaultRunIn } from '../docker/container.js';
import { sha8 } from '../review/shared.js';

export type ScannerFinding = {
  tool: 'gitleaks' | 'osv-scanner' | 'semgrep';
  ruleId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  /** Occurrence identity independent of line numbers: gitleaks Fingerprint, semgrep hash of matched text, osv vuln id. */
  key: string;
  message: string;
};

type RunResult = { exitCode?: number; stdout: string; stderr: string };
type RunIn = (container: string, shellCmd: string) => Promise<RunResult>;
type Severity = ScannerFinding['severity'];
type Tool = ScannerFinding['tool'];

const TIMEOUT = 'timeout 300';
const WORKSPACE = '/workspace';

class Unavailable extends Error {}

function normalizePath(p: string): string {
  return p.startsWith(`${WORKSPACE}/`) ? p.slice(WORKSPACE.length + 1) : p.replace(/^\.\//, '');
}

function excluded(file: string): boolean {
  return file === '.anton' || file.startsWith('.anton/') || /(^|\/)node_modules\//.test(file);
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Unavailable('unparseable output');
  }
}

function checkExit(r: RunResult, okCodes: number[]): void {
  if (r.exitCode === undefined || !okCodes.includes(r.exitCode)) throw new Unavailable(`exit ${r.exitCode}`);
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

async function gitleaks(container: string, run: RunIn): Promise<ScannerFinding[]> {
  // exit 1 = leaks found (not a failure)
  const r = await run(
    container,
    `rm -f /tmp/gitleaks.json; cd ${WORKSPACE} && ${TIMEOUT} gitleaks detect --no-banner --report-format json --report-path /tmp/gitleaks.json`,
  );
  checkExit(r, [0, 1]);
  const rep = await run(container, 'cat /tmp/gitleaks.json');
  // gitleaks 8.30.1 writes `[]` on a clean scan, but a missing/empty report only means "clean"
  // when it exited 0; exit 1 (leaks claimed) without a readable report is a real error.
  const missing = rep.exitCode !== 0 || rep.stdout.trim() === '';
  if (missing) {
    if (r.exitCode === 0) return [];
    throw new Unavailable('leaks reported but no report file');
  }
  const data = parse(rep.stdout);
  if (!Array.isArray(data)) throw new Unavailable('unexpected shape');
  return data.map((x) => {
    const o = rec(x);
    return {
      tool: 'gitleaks' as const,
      ruleId: str(o.RuleID, 'gitleaks'),
      severity: 'high' as const,
      file: normalizePath(str(o.File)),
      ...(typeof o.StartLine === 'number' ? { line: o.StartLine } : {}),
      key: str(o.Fingerprint, `${str(o.File)}:${str(o.RuleID)}:${String(o.StartLine)}`),
      message: str(o.Description, 'Potential secret detected'),
    };
  });
}

function osvSeverity(score: string | undefined): Severity {
  const n = score === undefined || score.trim() === '' ? NaN : Number(score);
  if (Number.isNaN(n)) return 'medium';
  if (n >= 9) return 'critical';
  if (n >= 7) return 'high';
  if (n >= 4) return 'medium';
  return 'low';
}

async function osv(container: string, run: RunIn): Promise<ScannerFinding[]> {
  // exit 1 = vulnerabilities found; 128 = no packages found
  const r = await run(container, `cd ${WORKSPACE} && ${TIMEOUT} osv-scanner scan source -r --format json .`);
  checkExit(r, [0, 1, 128]);
  if (r.exitCode === 128) {
    if (r.stdout.trim() === '' && /no package sources/i.test(r.stderr)) return [];
    throw new Unavailable('osv-scanner exit 128');
  }
  const root = rec(parse(r.stdout));
  if (!Array.isArray(root.results)) throw new Unavailable('unexpected shape');
  const out: ScannerFinding[] = [];
  for (const res of arr(root.results)) {
    const file = normalizePath(str(rec(rec(res).source).path));
    for (const p of arr(rec(res).packages)) {
      const pkg = rec(p);
      const info = rec(pkg.package);
      const vulns = arr(pkg.vulnerabilities).map(rec);
      for (const g of arr(pkg.groups)) {
        const grp = rec(g);
        const ids = arr(grp.ids).map((i) => str(i));
        const id = ids[0] ?? 'unknown';
        const v = vulns.find((x) => ids.includes(str(x.id)));
        const summary = str(v?.summary, id);
        out.push({
          tool: 'osv-scanner',
          ruleId: id,
          severity: osvSeverity(typeof grp.max_severity === 'string' ? grp.max_severity : undefined),
          file,
          key: id,
          message: `${str(info.name)}@${str(info.version)}: ${summary}`,
        });
      }
    }
  }
  return out;
}

const SEMGREP_SEVERITY: Record<string, Severity> = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };

async function semgrep(container: string, run: RunIn, notes: string[]): Promise<ScannerFinding[]> {
  const r = await run(
    container,
    `cd ${WORKSPACE} && ${TIMEOUT} semgrep scan --config p/default --json --metrics=off .`,
  );
  checkExit(r, [0, 1]);
  const root = rec(parse(r.stdout));
  if (!Array.isArray(root.results)) throw new Unavailable('unexpected shape');
  if (arr(root.errors).length > 0) notes.push('semgrep (partial)');
  return arr(root.results).map((x) => {
    const o = rec(x);
    const extra = rec(o.extra);
    const line = rec(o.start).line;
    const lines = str(extra.lines);
    const ruleId = str(o.check_id, 'semgrep');
    const file = normalizePath(str(o.path));
    // semgrep hides `lines` without login; fall back to rule+file so the key stays stable.
    const key = sha8(lines && lines !== 'requires login' ? lines : `${ruleId}\n${file}`);
    return {
      tool: 'semgrep' as const,
      ruleId,
      severity: SEMGREP_SEVERITY[str(extra.severity)] ?? 'low',
      file,
      ...(typeof line === 'number' ? { line } : {}),
      key,
      message: str(extra.message),
    };
  });
}

export async function runScanners(
  container: string,
  deps: { runIn?: RunIn } = {},
): Promise<{ findings: ScannerFinding[]; unavailable: string[] }> {
  const run: RunIn = deps.runIn ?? ((c, cmd) => defaultRunIn(c, cmd));
  const scanners: [Tool, (c: string, r: RunIn, notes: string[]) => Promise<ScannerFinding[]>][] = [
    ['gitleaks', gitleaks],
    ['osv-scanner', osv],
    ['semgrep', semgrep],
  ];
  const findings: ScannerFinding[] = [];
  const unavailable: string[] = [];
  for (const [name, fn] of scanners) {
    try {
      findings.push(...(await fn(container, run, unavailable)).filter((f) => !excluded(f.file)));
    } catch {
      unavailable.push(name);
    }
  }
  return { findings, unavailable };
}
