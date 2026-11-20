import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffPath, orderTasks, readHandoffs } from '../../src/stages/handoffs.js';
import type { Plan } from '../../src/stages/plan.js';

const t = (id: string, area: Plan['tasks'][number]['area']) => ({ id, title: id, acceptanceChecks: [], instructions: 'x', area });

describe('handoffs', () => {
  it('orderTasks puts infra, then backend, then frontend, keeping plan order within an area', () => {
    const plan: Plan = {
      commands: { install: 'i', test: 't' },
      tasks: [t('T1', 'frontend'), t('T2', 'backend'), t('T3', 'infra'), t('T4', 'backend'), t('T5', 'frontend')],
    };
    expect(orderTasks(plan).map((x) => x.id)).toEqual(['T3', 'T2', 'T4', 'T1', 'T5']);
  });

  it('handoffPath is <jobDir>/handoffs/<area>.md', () => {
    expect(handoffPath('/j', 'backend')).toBe('/j/handoffs/backend.md');
  });

  it('readHandoffs returns handoffs in area order and skips missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anton-ho-'));
    expect(await readHandoffs(dir)).toEqual([]);
    await mkdir(join(dir, 'handoffs'));
    await writeFile(handoffPath(dir, 'frontend'), 'F');
    await writeFile(handoffPath(dir, 'infra'), 'I');
    expect(await readHandoffs(dir)).toEqual([{ area: 'infra', text: 'I' }, { area: 'frontend', text: 'F' }]);
  });
});
