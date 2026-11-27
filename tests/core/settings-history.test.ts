import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySettingsChange, readSettingsHistory, SettingsConflict } from '../../src/core/settings-history.js';

describe('settings history', () => {
  let home: string;
  let path: string;
  const original = '# Spending\r\nbudget: { defaultUsd: 10, taskBudgets: true } # keep\r\nchat:\r\n    monthlyUsd: 5   # chat pool\r\n';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'anton-settings-'));
    path = join(home, 'config.yaml');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function setBudget(value: number, expectedHash?: string) {
    return applySettingsChange({
      expectedHash: expectedHash ?? (await readSettingsHistory(home)).hash,
      intent: 'set_budget',
      edits: [{ path: ['budget', 'defaultUsd'], value }],
    }, home);
  }

  it('preserves scalar formatting and comments and records application and undo', async () => {
    await writeFile(path, original);
    const applied = (await setBudget(25))!;
    expect(await readFile(path, 'utf8')).toBe(original.replace('10,', '25,'));
    expect(applied).toMatchObject({
      intent: 'set_budget', source: 'slack',
      changes: [{ path: ['budget', 'defaultUsd'], before: 10, after: 25 }],
    });
    const undo = await applySettingsChange({ expectedHash: applied.hash, undoId: applied.id }, home);
    expect(undo).toMatchObject({ intent: 'undo_setting', undoOf: applied.id });
    expect(await readFile(path, 'utf8')).toBe(original);
    const lines = (await readFile(join(home, 'settings-history.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).id)).toEqual([applied.id, undo?.id]);
  });

  it('rejects an invalid batch without applying its valid edits', async () => {
    await writeFile(path, original);
    const { hash } = await readSettingsHistory(home);
    await expect(applySettingsChange({
      expectedHash: hash, intent: 'update',
      edits: [
        { path: ['chat', 'monthlyUsd'], value: 20 },
        { path: ['budget', 'allowances'], value: { spec: 10, plan: 10, build: 10, verify: 10, retro: 10 } },
      ],
    }, home)).rejects.toThrow('add up to 100');
    expect(await readFile(path, 'utf8')).toBe(original);
    expect((await readSettingsHistory(home)).history).toEqual([]);
  });

  it('logs a hand edit once, rejects stale confirmations and refuses to undo an edited setting', async () => {
    await writeFile(path, original);
    const applied = (await setBudget(25))!;
    await writeFile(path, original.replace('10,', '30,'));
    await expect(setBudget(40, applied.hash)).rejects.toThrow(SettingsConflict);
    const { hash, history } = await readSettingsHistory(home);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      source: 'file', changes: [{ path: ['budget', 'defaultUsd'], before: 25, after: 30 }],
    });
    await expect(applySettingsChange({ expectedHash: hash, undoId: applied.id }, home)).rejects.toThrow('budget.defaultUsd has changed');
    expect(await readFile(path, 'utf8')).toBe(original.replace('10,', '30,'));
  });

  it('undoes a change without reverting an unrelated hand edit', async () => {
    await writeFile(path, original);
    const applied = (await setBudget(25))!;
    await writeFile(path, original.replace('10,', '25,').replace('monthlyUsd: 5', 'monthlyUsd: 9'));
    const { hash } = await readSettingsHistory(home);
    await applySettingsChange({ expectedHash: hash, undoId: applied.id }, home);
    expect(await readFile(path, 'utf8')).toBe(original.replace('monthlyUsd: 5', 'monthlyUsd: 9'));
  });

  it('recovers the history entry when a config write finished before the log write', async () => {
    const applied = (await setBudget(25))!;
    const state = join(home, 'settings-history-state.json');
    const pending = join(home, 'settings-history-pending.json');
    await writeFile(pending, await readFile(state));
    await rm(state);
    await rm(join(home, 'settings-history.jsonl'));
    expect((await readSettingsHistory(home)).history).toEqual([expect.objectContaining({ id: applied.id })]);
    expect((await readSettingsHistory(home)).history).toHaveLength(1);
  });

  it('keeps unrelated sections verbatim when inserting a setting', async () => {
    await writeFile(path, original);
    const { hash } = await readSettingsHistory(home);
    await applySettingsChange({
      expectedHash: hash, intent: 'set_preset', edits: [{ path: ['models', 'preset'], value: 'economy' }],
    }, home);
    expect(await readFile(path, 'utf8')).toBe(original + 'models:\r\n  preset: economy\r\n');
  });

  it('enforces the phase budget limits', async () => {
    await expect(setBudget(0.25)).rejects.toThrow('must be between');
    await expect(setBudget(501)).rejects.toThrow('must be between');
    expect((await readSettingsHistory(home)).history).toEqual([]);
  });

  it('serializes concurrent confirmations and removes a newly created section on undo', async () => {
    const { hash } = await readSettingsHistory(home);
    const results = await Promise.allSettled([setBudget(25, hash), setBudget(30, hash)]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({ reason: expect.any(SettingsConflict) });
    const snapshot = await readSettingsHistory(home);
    expect(snapshot.history).toHaveLength(1);
    await applySettingsChange({ expectedHash: snapshot.hash, undoId: snapshot.history[0]!.id }, home);
    expect((await readSettingsHistory(home)).config).toEqual({});
  });
});
