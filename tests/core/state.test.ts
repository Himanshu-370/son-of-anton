import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const calls: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (...a: Parameters<typeof actual.writeFile>) => {
      calls.push(`write:${String(a[0]).split('/').pop()}`);
      return actual.writeFile(...a);
    },
    rename: (...a: Parameters<typeof actual.rename>) => {
      calls.push(`rename:${String(a[0]).split('/').pop()}->${String(a[1]).split('/').pop()}`);
      return actual.rename(...a);
    },
  };
});

import {
  InvalidTransition,
  loadState,
  pause,
  saveState,
  transition,
  unpause,
  type JobState,
  type Stage,
} from '../../src/core/state.js';

function base(stage: Stage = 'spec', extra: Partial<JobState> = {}): JobState {
  return {
    jobId: 'j1',
    project: 'p',
    stage,
    round: 0,
    maxRounds: 3,
    budgetUsd: 10,
    spentUsd: 0,
    warned80: false,
    completedTasks: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('state transitions', () => {
  it('allows spec→awaiting_spec_approval→plan→build→verify→deliver→awaiting_final_review→done', () => {
    const path: Stage[] = ['awaiting_spec_approval', 'plan', 'build', 'verify', 'deliver', 'awaiting_final_review', 'done'];
    let s = base('spec');
    for (const to of path) {
      s = transition(s, to);
      expect(s.stage).toBe(to);
    }
  });

  it('allows verify→build (retry) and awaiting_final_review→build (reject), passing extra', () => {
    const s = transition(base('verify', { round: 1 }), 'build', { round: 2 });
    expect(s.stage).toBe('build');
    expect(s.round).toBe(2);
    expect(transition(base('awaiting_final_review'), 'build').stage).toBe('build');
  });

  it('rejects plan→deliver with InvalidTransition', () => {
    expect(() => transition(base('plan'), 'deliver')).toThrow(InvalidTransition);
  });

  it('pause then unpause returns to pausedFrom', () => {
    const p = pause(base('build'), 'round_cap');
    expect(p).toMatchObject({ stage: 'paused', pausedFrom: 'build', pauseReason: 'round_cap' });
    const u = unpause(p);
    expect(u.stage).toBe('build');
    expect(u.pausedFrom).toBeUndefined();
    expect(u.pauseReason).toBeUndefined();
  });

  it('paused (from verify) → deliver is allowed; paused (from plan) → deliver throws', () => {
    expect(transition(pause(base('verify'), 'budget_cap'), 'deliver').stage).toBe('deliver');
    expect(transition(pause(base('build'), 'error'), 'deliver').stage).toBe('deliver');
    expect(() => transition(pause(base('plan'), 'error'), 'deliver')).toThrow(InvalidTransition);
  });

  it('any non-terminal stage → abandoned is allowed; done → anything throws', () => {
    const nonTerminal: Stage[] = ['spec', 'awaiting_spec_approval', 'plan', 'build', 'verify', 'deliver', 'awaiting_final_review'];
    for (const st of nonTerminal) expect(transition(base(st), 'abandoned').stage).toBe('abandoned');
    expect(transition(pause(base('plan'), 'error'), 'abandoned').stage).toBe('abandoned');
    for (const to of ['spec', 'build', 'abandoned', 'done'] as Stage[]) {
      expect(() => transition(base('done'), to)).toThrow(InvalidTransition);
      expect(() => transition(base('abandoned'), to)).toThrow(InvalidTransition);
    }
  });

  it('pause rejects stages that cannot pause', () => {
    expect(() => pause(base('done'), 'error')).toThrow(InvalidTransition);
  });
});

describe('state persistence', () => {
  it('saveState is atomic: writes state.json.tmp, then renames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anton-state-'));
    calls.length = 0;
    await saveState(dir, base('plan'));
    expect(calls).toEqual(['write:state.json.tmp', 'rename:state.json.tmp->state.json']);
    expect(await readdir(dir)).toEqual(['state.json']);
    const loaded = await loadState(dir);
    expect(loaded.stage).toBe('plan');
    expect(loaded.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(Number.isNaN(Date.parse(loaded.updatedAt))).toBe(false);
  });

  it('reviewedSha optional round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anton-state-'));
    await saveState(dir, base('verify'));
    expect((await loadState(dir)).reviewedSha).toBeUndefined();
    await saveState(dir, { ...base('verify'), reviewedSha: 'abc123' });
    expect((await loadState(dir)).reviewedSha).toBe('abc123');
  });

  it('loadState rejects a file failing the schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anton-state-'));
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...base(), stage: 'bogus' }));
    await expect(loadState(dir)).rejects.toThrow();
    await writeFile(join(dir, 'state.json'), JSON.stringify({ jobId: 'x' }));
    await expect(loadState(dir)).rejects.toThrow();
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toContain('jobId');
  });
});
