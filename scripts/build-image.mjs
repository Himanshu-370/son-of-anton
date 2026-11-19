// Stages the compiled agent entry into the fallback kit's build context, then builds the image.
// Run via `npm run build:image` (which runs `npm run build` first).
// ensureImage skips the build when the tag already exists, so `docker rmi` it to force a rebuild.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureImage } from '../dist/docker/container.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kitDir = join(root, 'src', 'kits', 'fallback');
const stage = join(kitDir, '.stage');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ['entry.js', 'protocol.js']) cpSync(join(root, 'dist', 'agent', f), join(stage, f));
const deps = {};
for (const name of ['@anthropic-ai/claude-agent-sdk', 'zod']) deps[name] = pkg.dependencies[name];
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify({ name: 'anton-agent-entry', private: true, type: 'module', dependencies: deps }, null, 2) + '\n',
);

const tag = await ensureImage({ name: 'fallback', dockerfile: join(kitDir, 'Dockerfile') });
console.log(tag);
