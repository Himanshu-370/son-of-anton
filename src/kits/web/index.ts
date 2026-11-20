import { fileURLToPath } from 'node:url';
import { fallbackKit } from '../fallback/index.js';
import type { Kit } from '../types.js';

export const webKit: Kit = {
  name: 'web',
  dockerfile: fileURLToPath(new URL('../../../src/kits/web/Dockerfile', import.meta.url)),
  base: fallbackKit,
  detect: () => 0, // Task 4 replaces this stub
  verify: (ctx) => fallbackKit.verify(ctx),
  baseline: (ctx) => fallbackKit.baseline(ctx),
};
