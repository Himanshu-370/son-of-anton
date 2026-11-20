import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptRisk, loadAcceptedRisks } from '../../src/security/risks.js';

describe('accepted risks', () => {
  it('missing file loads as empty', async () => {
    expect(await loadAcceptedRisks(await mkdtemp(join(tmpdir(), 'anton-r-')))).toEqual([]);
  });
  it('acceptRisk then loadAcceptedRisks round-trips; re-accept updates reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anton-r-'));
    await acceptRisk(dir, 'SEC-aaaaaaaa', 'first');
    await acceptRisk(dir, 'SEC-bbbbbbbb', 'other');
    let r = await loadAcceptedRisks(dir);
    expect(r.map((x) => x.id).sort()).toEqual(['SEC-aaaaaaaa', 'SEC-bbbbbbbb']);
    expect(r.find((x) => x.id === 'SEC-aaaaaaaa')!.reason).toBe('first');
    expect(Number.isNaN(Date.parse(r[0]!.acceptedAt))).toBe(false);
    await acceptRisk(dir, 'SEC-aaaaaaaa', 'second');
    r = await loadAcceptedRisks(dir);
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.id === 'SEC-aaaaaaaa')!.reason).toBe('second');
  });
});
