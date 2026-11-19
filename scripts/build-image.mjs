// Stages the compiled agent entry into the fallback kit's build context, then builds the image.
// Run via `npm run build:image` (which runs `npm run build` first).
// Dependencies are pinned: the repo's own package.json + package-lock.json are staged, so the image's
// `npm ci --omit=dev` installs exactly the locked versions (including the linux SDK binary).
// The image tag includes a hash of the Dockerfile + .stage/, so any change produces a new tag.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureImage } from '../dist/docker/container.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kitDir = join(root, 'src', 'kits', 'fallback');
const stage = join(kitDir, '.stage');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ['entry.js', 'pricing.js', 'protocol.js']) cpSync(join(root, 'dist', 'agent', f), join(stage, f));
for (const f of ['package.json', 'package-lock.json']) cpSync(join(root, f), join(stage, f));

const tag = await ensureImage({ name: 'fallback', dockerfile: join(kitDir, 'Dockerfile') });
console.log(tag);
