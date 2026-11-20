import { fallbackKit } from './fallback/index.js';
import type { Kit } from './types.js';
import { webKit } from './web/index.js';

export type KitName = 'fallback' | 'web';

export const KITS: Kit[] = [webKit, fallbackKit];

/** Highest-scoring kit; fallback when nothing scores 0.5 or more. */
export function selectKit(description: string, files: string[]): Kit {
  let best: Kit = fallbackKit;
  let top = 0;
  for (const k of KITS) {
    const s = k.detect(description, files);
    if (s > top) [best, top] = [k, s];
  }
  return top >= 0.5 ? best : fallbackKit;
}

export function kitByName(name: KitName): Kit {
  return name === 'web' ? webKit : fallbackKit;
}
