import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { dirname } from 'node:path';

/** Write via a uniquely named temp file in the same dir, then rename over the target. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, path);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}
