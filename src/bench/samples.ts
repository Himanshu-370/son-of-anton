import * as fsp from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { antonHome } from '../core/paths.js';
import { SpecDocBaseSchema, type SpecDoc } from '../stages/spec.js';

export const BenchManifestSchema = z.object({
  samples: z.array(z.object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    kind: z.enum(['new', 'change']),
    kit: z.enum(['fallback', 'web']),
    budgetUsd: z.number().positive(),
    description: z.string(),
  })).min(1),
});

export type BenchSample = z.infer<typeof BenchManifestSchema>['samples'][number] & {
  spec: SpecDoc;
  /** Folder holding spec.json. */
  dir: string;
  /** Starting repo for change jobs. */
  repoDir?: string;
};

/** The bench folder shipped in the package (works from src/ and dist/). */
const SHIPPED = fileURLToPath(new URL('../../bench/', import.meta.url));

/** Copies files only: symlinks in the shipped tree are skipped, and an existing destination (even a symlink) is kept. */
async function copyTree(src: string, dst: string, rel: string, out: { copied: string[]; kept: string[] }): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await copyTree(join(src, e.name), join(dst, e.name), r, out);
    else if (e.isFile()) {
      try {
        await fsp.copyFile(join(src, e.name), join(dst, e.name), constants.COPYFILE_EXCL);
        out.copied.push(r);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        out.kept.push(r);
      }
    }
  }
}

export async function initBench(home: string = antonHome()): Promise<{ copied: string[]; kept: string[] }> {
  const out = { copied: [] as string[], kept: [] as string[] };
  await copyTree(SHIPPED, join(home, 'bench'), '', out);
  return out;
}

export async function loadSamples(home: string = antonHome(), only?: string[]): Promise<BenchSample[]> {
  const root = join(home, 'bench');
  const manifest = BenchManifestSchema.parse(JSON.parse(await fsp.readFile(join(root, 'manifest.json'), 'utf8')));
  const names = manifest.samples.map((s) => s.name);
  for (const n of only ?? []) {
    if (!names.includes(n)) throw new Error(`Unknown bench sample "${n}" (have: ${names.join(', ')})`);
  }
  const chosen = manifest.samples.filter((s) => !only?.length || only.includes(s.name));
  return Promise.all(chosen.map(async (s) => {
    const dir = join(root, s.name);
    let spec: SpecDoc;
    try {
      spec = SpecDocBaseSchema.parse(JSON.parse(await fsp.readFile(join(dir, 'spec.json'), 'utf8')));
    } catch (e) {
      throw new Error(`Bench sample "${s.name}" has an invalid spec.json: ${(e as Error).message}`);
    }
    return { ...s, spec, dir, ...(s.kind === 'change' ? { repoDir: join(dir, 'repo') } : {}) };
  }));
}
