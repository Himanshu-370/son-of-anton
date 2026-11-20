import { describe, expect, it } from 'vitest';
import { evidenceFor, mapJUnit } from '../../src/verify/junit.js';

const checks = [
  { id: 'AC-1', text: 'one' },
  { id: 'AC-2', text: 'two' },
  { id: 'AC-3', text: 'three' },
];

describe('mapJUnit', () => {
  it('passes a check when all its tests pass; fails with message when one fails; no_test when none', () => {
    const xml = `<testsuite>
      <testcase classname="a" name="AC-1 does x"/>
      <testcase classname="a" name="AC-1 does y"/>
      <testcase classname="a" name="AC-2 breaks"><failure message="expected 1 got 2">stack</failure></testcase>
    </testsuite>`;
    const [r1, r2, r3] = mapJUnit(xml, checks);
    expect(r1).toMatchObject({ id: 'AC-1', status: 'pass', tests: ['AC-1 does x', 'AC-1 does y'] });
    expect(r2).toMatchObject({ status: 'fail', reason: 'failing', error: 'expected 1 got 2' });
    expect(r3).toMatchObject({ status: 'fail', reason: 'no_test', tests: [] });
  });

  it('does not match AC-10 for AC-1', () => {
    const xml = `<testsuite><testcase name="AC-10 foo"/></testsuite>`;
    const [r1] = mapJUnit(xml, checks);
    expect(r1).toMatchObject({ status: 'fail', reason: 'no_test' });
  });

  it('matches on classname and handles a single testcase and testsuites root', () => {
    const xml = `<testsuites><testsuite><testcase classname="AC-1.suite" name="t"/></testsuite><testsuite><testcase name="AC-2 e"><error>boom text</error></testcase></testsuite></testsuites>`;
    const [r1, r2] = mapJUnit(xml, checks);
    expect(r1.status).toBe('pass');
    expect(r2).toMatchObject({ reason: 'failing', error: 'boom text' });
  });

  it('treats skipped as not passing', () => {
    const xml = `<testsuite><testcase name="AC-1 s"><skipped/></testcase></testsuite>`;
    expect(mapJUnit(xml, checks)[0]).toMatchObject({ status: 'fail', reason: 'failing' });
  });

  it('malformed or empty XML fails every check with no_test, no throw', () => {
    for (const xml of ['<<<not xml', '', '<foo/>']) {
      const rs = mapJUnit(xml, checks);
      expect(rs).toHaveLength(3);
      expect(rs.every((r) => r.status === 'fail' && r.reason === 'no_test')).toBe(true);
    }
  });
});

describe('passingTests', () => {
  it('same-named tests in different classes get distinct labels; no classname falls back to name', async () => {
    const { passingTests } = await import('../../src/verify/junit.js');
    const xml = '<testsuite><testcase classname="A" name="works"/><testcase classname="B" name="works"/><testcase name="solo"/></testsuite>';
    expect(passingTests(xml)).toEqual(['A::works', 'B::works', 'solo']);
  });
});

describe('allTests', () => {
  it('labels match passingTests and flag failures and skips', async () => {
    const { allTests, passingTests } = await import('../../src/verify/junit.js');
    const xml = '<testsuite><testcase classname="A" name="ok"/><testcase classname="A" name="bad"><failure>x</failure></testcase><testcase name="solo"/><testcase classname="B" name="sk"><skipped/></testcase></testsuite>';
    expect(allTests(xml)).toEqual([
      { name: 'A::ok', passed: true }, { name: 'A::bad', passed: false }, { name: 'solo', passed: true }, { name: 'B::sk', passed: false },
    ]);
    expect(passingTests(xml)).toEqual(['A::ok', 'solo']);
  });

  it('check with a passing [real] test → evidence real; otherwise stand-in', () => {
    const xml = `<testsuite>
      <testcase classname="a" name="AC-1 [real] charges"/>
      <testcase classname="a" name="AC-1 stub charges"/>
      <testcase classname="a" name="AC-2 [real] sends"><skipped/></testcase>
      <testcase classname="a" name="AC-2 stub sends"/>
    </testsuite>`;
    const [r1, r2] = mapJUnit(xml, checks);
    expect(r1!.evidence).toBe('real');
    expect(r2!.evidence).toBe('stand-in'); // the skipped [real] test is ignored
    expect(r2!.status).toBe('pass');
    expect(mapJUnit(xml, [{ id: 'AC-9', text: 'x' }])[0]!.evidence).toBeUndefined();
  });

  it('evidenceFor is pure: no tests → undefined', () => {
    expect(evidenceFor([])).toBeUndefined();
    expect(evidenceFor([{ label: 'x [real]', ok: false }])).toBe('stand-in');
  });

  it('skipped [real] tests are ignored for status; skipped stand-ins still fail', () => {
    const xml = `<testsuite>
      <testcase name="AC-1 stub"/><testcase name="AC-1 [real] x"><skipped/></testcase>
      <testcase name="AC-2 [real] only"><skipped/></testcase>
      <testcase name="AC-3 stub"><skipped/></testcase>
    </testsuite>`;
    const [r1, r2, r3] = mapJUnit(xml, checks);
    expect(r1).toMatchObject({ status: 'pass', evidence: 'stand-in' });
    expect(r2).toMatchObject({ status: 'fail', reason: 'no_test', tests: [] });
    expect(r3).toMatchObject({ status: 'fail', reason: 'failing' });
  });
});
