import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
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

/** A job-folder file that is a symlink, FIFO or folder instead of a regular file. */
export class NotRegularFileError extends Error {}

/**
 * Read a file the container can write without following a symlink planted in its place (O_NOFOLLOW;
 * O_NONBLOCK so a FIFO cannot hang the open). Missing gives undefined; anything not a regular file throws.
 */
export async function readRegularFile(path: string): Promise<string | undefined> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') throw new NotRegularFileError(`Refusing to read ${path}: it is not a regular file`);
    throw e;
  }
  try {
    if (!(await fh.stat()).isFile()) throw new NotRegularFileError(`Refusing to read ${path}: it is not a regular file`);
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}
