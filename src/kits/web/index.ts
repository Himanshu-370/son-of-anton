import { fileURLToPath } from 'node:url';
import { fallbackKit } from '../fallback/index.js';
import type { Kit } from '../types.js';

const WEB_FILE = /(^|\/)(next\.config\.[^/]+|vite\.config\.[^/]+|svelte\.config\.[^/]+|nuxt\.config\.[^/]+|angular\.json|[^/]+\.(tsx|jsx|vue|svelte)|index\.html)$/;
const WEB_WORDS = /\b(web ?app|website|web page|frontend|front-end|react|next\.js|vue|svelte|dashboard|landing page|browser)\b/i;

function detect(description: string, files: string[]): number {
  if (files.some((f) => WEB_FILE.test(f))) return 0.9;
  return WEB_WORDS.test(description) ? 0.8 : 0;
}

export const webKit: Kit = {
  name: 'web',
  dockerfile: fileURLToPath(new URL('../../../src/kits/web/Dockerfile', import.meta.url)),
  base: fallbackKit,
  detect,
  verify: (ctx) => fallbackKit.verify(ctx),
  baseline: (ctx) => fallbackKit.baseline(ctx),
};
