import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetSettings, DEFAULT_ALLOWANCES, loadAntonConfig, resolveEntries, retroBatch, STAGE_GROUP } from '../../src/core/anton-config.js';

async function homeWith(yaml?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'anton-cfg-'));
  if (yaml !== undefined) await writeFile(join(home, 'config.yaml'), yaml);
  return home;
}

describe('loadAntonConfig', () => {
  it('missing config gives empty', async () => {
    expect(await loadAntonConfig(await homeWith())).toEqual({});
  });
  it('unknown key is rejected', async () => {
    await expect(loadAntonConfig(await homeWith('bogus: 1\n'))).rejects.toThrow(
      /Invalid ~\/anton\/config\.yaml/,
    );
  });
  it('retro.batch defaults to true, can be false, and rejects unknown keys', async () => {
    expect(retroBatch(await loadAntonConfig(await homeWith()))).toBe(true);
    expect(retroBatch(await loadAntonConfig(await homeWith('retro:\n  batch: false\n')))).toBe(false);
    await expect(loadAntonConfig(await homeWith('retro:\n  bogus: 1\n'))).rejects.toThrow(/Invalid ~\/anton\/config\.yaml/);
  });
  it('bad entry name is rejected', async () => {
    await expect(loadAntonConfig(await homeWith('stages:\n  build: ["Bad Name"]\n'))).rejects.toThrow(
      /Invalid ~\/anton\/config\.yaml/,
    );
  });
  it('bad YAML is rejected', async () => {
    await expect(loadAntonConfig(await homeWith('a: [\n'))).rejects.toThrow(
      /Invalid ~\/anton\/config\.yaml/,
    );
  });
});

describe('resolveEntries', () => {
  const cfg = {
    stages: { spec: ['s1'], plan: ['p1'], build: ['b1', 'shared'], verify: ['v1'] },
    kits: { web: ['k1', 'shared'] },
    roles: { frontend: ['r1', 'b1'] },
  };
  it('build frontend web: stage + kit + role entries, deduped, stable order', () => {
    expect(resolveEntries(cfg, { stage: 'build', role: 'frontend', kit: 'web' })).toEqual([
      'b1', 'shared', 'k1', 'r1',
    ]);
  });
  it('kit entries are not applied in spec', () => {
    expect(resolveEntries(cfg, { stage: 'spec', role: 'pm', kit: 'web' })).toEqual(['s1']);
  });
  it('read-only roles resolve to nothing', () => {
    expect(resolveEntries(cfg, { stage: 'build', role: 'code_reviewer', kit: 'web' })).toEqual([]);
  });
  it('baseline uses the plan entries', () => {
    expect(resolveEntries(cfg, { stage: 'baseline', role: 'qa', kit: 'fallback' })).toEqual(['p1']);
  });
  it('deliver uses the verify entries', () => {
    expect(STAGE_GROUP.deliver).toBe('verify');
    expect(resolveEntries(cfg, { stage: 'deliver', role: 'qa', kit: 'fallback' })).toEqual(['v1']);
  });
  it('unknown stage throws (fail closed)', () => {
    expect(() => resolveEntries(cfg, { stage: 'bogus', role: 'qa', kit: 'web' })).toThrow(
      'Unknown stage "bogus"',
    );
  });
});

describe('budget config', () => {
  it('allowances must add up to 100', async () => {
    const y = 'budget:\n  allowances: { spec: 10, plan: 10, build: 50, verify: 25, retro: 6 }\n';
    await expect(loadAntonConfig(await homeWith(y))).rejects.toThrow('budget.allowances must add up to 100');
  });
  it('allowances need all five stages', async () => {
    const y = 'budget:\n  allowances: { spec: 50, plan: 50 }\n';
    await expect(loadAntonConfig(await homeWith(y))).rejects.toThrow(/Invalid ~\/anton\/config\.yaml/);
  });
  it('defaultUsd must be above 0 (F1)', async () => {
    await expect(loadAntonConfig(await homeWith('budget:\n  defaultUsd: 0\n'))).rejects.toThrow(/Invalid ~\/anton\/config\.yaml/);
  });
  it('budgetSettings fills defaults', async () => {
    expect(budgetSettings({})).toEqual({ defaultUsd: 10, allowances: DEFAULT_ALLOWANCES, taskBudgets: true });
    const cfg = await loadAntonConfig(await homeWith('budget:\n  defaultUsd: 3\n  taskBudgets: false\n'));
    expect(budgetSettings(cfg)).toEqual({ defaultUsd: 3, allowances: DEFAULT_ALLOWANCES, taskBudgets: false });
  });
});

describe('chat settings', () => {
  it('defaults to $5 a month and $0.10 an answer, reads overrides and rejects unknown keys', async () => {
    const { chatSettings } = await import('../../src/core/anton-config.js');
    expect(chatSettings(await loadAntonConfig(await homeWith()))).toEqual({ monthlyUsd: 5, perAnswerUsd: 0.1 });
    expect(chatSettings(await loadAntonConfig(await homeWith('chat:\n  monthlyUsd: 2\n  perAnswerUsd: 0.05\n'))))
      .toEqual({ monthlyUsd: 2, perAnswerUsd: 0.05 });
    await expect(loadAntonConfig(await homeWith('chat:\n  model: x\n'))).rejects.toThrow(/Invalid ~\/anton\/config\.yaml/);
    await expect(loadAntonConfig(await homeWith('chat:\n  perAnswerUsd: 0\n'))).rejects.toThrow(/Invalid ~\/anton\/config\.yaml/);
  });
});
