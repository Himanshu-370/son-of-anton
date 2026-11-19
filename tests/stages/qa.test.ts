import { describe, it, expect } from 'vitest';
import type { CheckResult } from '../../src/kits/types.js';
import type { Plan } from '../../src/stages/plan.js';
import { attributeFailures, failuresPath, renderFailureReport, type FailureItem } from '../../src/stages/qa.js';

const task = (id: string, area: Plan['tasks'][number]['area'], checks: string[]): Plan['tasks'][number] => ({
  id, title: id, acceptanceChecks: checks, instructions: 'x', area,
});
const pass = (id: string): CheckResult => ({ id, status: 'pass', tests: [] });
const fail = (id: string, reason: CheckResult['reason'] = 'failing', error?: string): CheckResult => ({
  id, status: 'fail', reason, tests: [`${id}: t`], ...(error ? { error } : {}),
});

describe('attributeFailures', () => {
  it('failing AC covered by backend+frontend tasks yields two items', () => {
    const plan: Plan = {
      commands: { install: 'i', test: 't' },
      tasks: [task('T1', 'backend', ['AC-1']), task('T2', 'frontend', ['AC-1', 'AC-2']), task('T3', 'backend', ['AC-1'])],
      contract: 'c',
    };
    const items = attributeFailures([fail('AC-1', 'failing', 'boom'), pass('AC-2')], true, plan, 'run text');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.area).sort()).toEqual(['backend', 'frontend']);
    for (const i of items) {
      expect(i).toMatchObject({ kind: 'check', id: 'AC-1:failing' });
      expect(i.text).toContain('AC-1');
      expect(i.text).toContain('boom');
    }
  });

  it('run failure goes to infra when infra tasks exist, else backend', () => {
    const withInfra: Plan = {
      commands: { install: 'i', test: 't' },
      tasks: [task('T1', 'backend', ['AC-1']), task('T2', 'infra', [])],
      contract: 'c',
    };
    expect(attributeFailures([pass('AC-1')], false, withInfra, 'crashed')).toEqual([
      { area: 'infra', kind: 'run', id: 'run:failed', text: 'crashed' },
    ]);
    const noInfra: Plan = {
      commands: { install: 'i', test: 't' },
      tasks: [task('T1', 'frontend', []), task('T2', 'backend', ['AC-1'])],
      contract: 'c',
    };
    expect(attributeFailures([pass('AC-1')], false, noInfra, 'crashed')[0]!.area).toBe('backend');
    const frontendOnly: Plan = { commands: { install: 'i', test: 't' }, tasks: [task('T1', 'frontend', ['AC-1'])] };
    expect(attributeFailures([pass('AC-1')], false, frontendOnly, 'crashed')[0]!.area).toBe('frontend');
  });

  it('no failures → no items', () => {
    const plan: Plan = { commands: { install: 'i', test: 't' }, tasks: [task('T1', 'backend', ['AC-1'])] };
    expect(attributeFailures([pass('AC-1')], true, plan, 'x')).toEqual([]);
  });
});

describe('failuresPath / renderFailureReport', () => {
  it('failuresPath is evidence/failures.json', () => {
    expect(failuresPath('/j')).toBe('/j/evidence/failures.json');
  });

  it('groups items by area in AREA_ORDER and keeps the kit check details', () => {
    const items: FailureItem[] = [
      { area: 'frontend', kind: 'check', id: 'AC-1:failing', text: 'AC-1 fe' },
      { area: 'backend', kind: 'review', id: 'CR-1', text: 'review text' },
      { area: 'infra', kind: 'run', id: 'run:failed', text: 'run text\nline two' },
    ];
    const md = renderFailureReport(items, '### AC-1 — failing\nkit detail');
    const infra = md.indexOf('### infra');
    const backend = md.indexOf('### backend');
    const frontend = md.indexOf('### frontend');
    expect(infra).toBeGreaterThan(-1);
    expect(backend).toBeGreaterThan(infra);
    expect(frontend).toBeGreaterThan(backend);
    expect(md).toContain('review text');
    expect(md).toContain('line two');
    expect(md).toContain('kit detail');
  });
});
