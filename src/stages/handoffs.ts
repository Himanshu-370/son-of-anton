import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { AREA_ORDER, type Area } from '../core/config.js';
import type { Plan } from './plan.js';

/** Stable sort by AREA_ORDER, keeping plan order within each area. */
export function orderTasks(plan: Plan): Plan['tasks'] {
  return AREA_ORDER.flatMap((area) => plan.tasks.filter((t) => t.area === area));
}

export function handoffPath(jobDir: string, area: Area): string {
  return join(jobDir, 'handoffs', `${area}.md`);
}

/** Existing handoff notes in AREA_ORDER; missing files are skipped. */
export async function readHandoffs(jobDir: string): Promise<{ area: Area; text: string }[]> {
  const out: { area: Area; text: string }[] = [];
  for (const area of AREA_ORDER) {
    try {
      out.push({ area, text: await fsp.readFile(handoffPath(jobDir, area), 'utf8') });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return out;
}
