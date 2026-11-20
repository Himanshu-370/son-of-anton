import { XMLParser } from 'fast-xml-parser';
import type { AcceptanceCheck, CheckResult } from '../kits/types.js';

type Case = { label: string; classname: string; name: string; ok: boolean; error?: string; skipped?: boolean };

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

const arr = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function text(node: unknown): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  const o = node as Record<string, unknown>;
  const msg = o['@_message'];
  if (typeof msg === 'string' && msg) return msg;
  const body = o['#text'];
  return body === undefined ? '' : String(body).trim();
}

function collectSuites(node: Record<string, unknown>, out: Record<string, unknown>[]): void {
  out.push(node);
  for (const s of arr(node.testsuite as Record<string, unknown> | Record<string, unknown>[])) {
    if (s && typeof s === 'object') collectSuites(s, out);
  }
}

function parseCases(xml: string): Case[] | null {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }
  const roots: Record<string, unknown>[] = [];
  const top = (doc.testsuites ?? doc.testsuite) as unknown;
  if (!top || typeof top !== 'object') return null;
  if (doc.testsuites) collectSuites({ testsuite: (top as Record<string, unknown>).testsuite }, roots);
  else for (const s of arr<Record<string, unknown>>(top as Record<string, unknown> | Record<string, unknown>[])) collectSuites(s, roots);

  const cases: Case[] = [];
  for (const suite of roots) {
    for (const tc of arr(suite.testcase as Record<string, unknown> | Record<string, unknown>[])) {
      if (!tc || typeof tc !== 'object') continue;
      const name = String(tc['@_name'] ?? '');
      const classname = String(tc['@_classname'] ?? '');
      const failure = tc.failure ?? tc.error;
      const skipped = tc.skipped;
      let ok = true;
      let error: string | undefined;
      let wasSkipped = false;
      if (failure !== undefined) {
        ok = false;
        error = text(failure) || 'test failed';
      } else if (skipped !== undefined) {
        ok = false;
        error = 'test skipped';
        wasSkipped = true;
      }
      cases.push({ label: name || classname, classname, name, ok, error, skipped: wasSkipped });
    }
  }
  return cases;
}

function mentions(haystack: string, id: string): boolean {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(haystack);
}

/** Evidence label from a check's tests: real only when a passing test has `[real]` in its name. */
export function evidenceFor(tests: { label: string; name?: string; ok: boolean }[]): 'real' | 'stand-in' | undefined {
  if (tests.length === 0) return undefined;
  return tests.some((t) => t.ok && (t.label.includes('[real]') || t.name?.includes('[real]'))) ? 'real' : 'stand-in';
}

export function mapJUnit(xml: string, checks: AcceptanceCheck[]): CheckResult[] {
  const cases = parseCases(xml) ?? [];
  return checks.map((c) => {
    // A skipped [real] test is the expected default without secrets: it neither passes nor fails the check.
    const mine = cases
      .filter((t) => mentions(t.name, c.id) || mentions(t.classname, c.id))
      .filter((t) => !(t.skipped && (t.label.includes('[real]') || t.name.includes('[real]'))));
    if (mine.length === 0) return { id: c.id, status: 'fail', reason: 'no_test', tests: [] };
    const tests = mine.map((t) => t.label);
    const bad = mine.find((t) => !t.ok);
    const evidence = evidenceFor(mine);
    if (bad) return { id: c.id, status: 'fail', reason: 'failing', tests, evidence, error: bad.error };
    return { id: c.id, status: 'pass', tests, evidence };
  });
}

/** True when the XML parses into a testsuite/testsuites root. */
export function isValidJUnit(xml: string): boolean {
  return parseCases(xml) !== null;
}

/** Every testcase as `{name, passed}`; skipped is not passed. Names are `classname::name` so same-named tests stay distinct (mapJUnit labels are unchanged). Empty when the XML is invalid. */
export function allTests(xml: string): { name: string; passed: boolean }[] {
  return (parseCases(xml) ?? []).map((t) => ({ name: t.classname && t.name ? `${t.classname}::${t.name}` : t.label, passed: t.ok }));
}

/** Names of the passing testcases, labelled as in allTests. */
export function passingTests(xml: string): string[] {
  return allTests(xml).filter((t) => t.passed).map((t) => t.name);
}
