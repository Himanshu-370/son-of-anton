import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, inflateSync } from 'node:zlib';
import { redact } from '../core/secrets.js';
import { SpecDocBaseSchema } from '../stages/spec.js';

const SPEC_LIMIT = 64 * 1024;
const PNG_LIMIT = 2 * 1024 * 1024;
const PIXEL_LIMIT = 4_000_000;
const SHA256 = /^[a-f0-9]{64}$/;
const CHECK_ID = /^AC-[1-9]\d{0,5}$/;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export type ArtifactSelection =
  | { kind: 'spec'; revision: string }
  | { kind: 'screenshot'; checkId: string; sha256: string };

export interface SlackArtifact {
  name: string;
  contentType: 'text/plain' | 'image/png';
  bytes: Buffer;
}

function sameFile(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export class ArtifactPreparationError extends Error {
  constructor(public readonly reason: 'artifact-invalid' | 'artifact-unavailable') {
    super(reason);
  }
}

const invalid = () => new ArtifactPreparationError('artifact-invalid');
const unavailable = () => new ArtifactPreparationError('artifact-unavailable');

/** Read only a bounded regular file inside the expected tree. Refuse links and directory replacement. */
export async function requireCheckedFile(root: string, parts: readonly string[], limit: number): Promise<Buffer> {
  try {
    if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || /[/\\\0]/.test(part))) throw invalid();
    const base = await realpath(root);
    if (!(await lstat(root)).isDirectory()) throw invalid();
    const parents = [];
    for (let i = 0; i < parts.length; i++) {
      const path = join(base, ...parts.slice(0, i));
      const info = await lstat(path);
      if (!info.isDirectory()) throw invalid();
      parents.push({ path, info });
    }
    const path = join(base, ...parts);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw invalid();
      const bytes = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw unavailable();
      if (await realpath(path) !== path || !sameFile(after, await lstat(path)) || await realpath(root) !== base) throw invalid();
      for (const parent of parents) {
        const current = await lstat(parent.path);
        if (!current.isDirectory() || !sameFile(current, parent.info)) throw invalid();
      }
      return bytes.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ArtifactPreparationError) throw error;
    if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw invalid();
    throw unavailable();
  }
}

export async function readCheckedFile(root: string, parts: readonly string[], limit: number): Promise<Buffer | undefined> {
  return requireCheckedFile(root, parts, limit).catch(() => undefined);
}

export async function specRevision(jobDir: string): Promise<string | undefined> {
  const bytes = await readCheckedFile(jobDir, ['spec.json'], SPEC_LIMIT);
  return bytes?.length ? hash(bytes) : undefined;
}

function redactOutput(value: string, secrets: Record<string, string>): string {
  const short = Object.values(secrets).filter((secret) => secret && secret.length < 8);
  let text = redact(value, secrets).replace(/\[REDACTED:[^\]\r\n]+\]/g, '[REDACTED]');
  for (const secret of short) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(?:xox[a-z]-[\w-]+|sk-[\w-]{8,}|gh[pousr]_[\w-]{8,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/\b([\w-]*(?:password|secret|token|api[_-]?key)[\w-]*)[ \t]*[:=][ \t]*(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi, '$1=[REDACTED]');
}

function stripMentionsAndLinks(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/<[@!#][^>]*>|@(?:everyone|here|channel)\b/gi, '[mention removed]')
    .replace(/@/g, '')
    .replace(/\b(?:https?|file|ftp):\/\/[^\s<>]+/gi, '[link removed]')
    .replace(/(?:^|[\s("'=])(?:~\/|\/|[A-Z]:\\)[^\s<>]+/gi, ' [path removed]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

async function prepareSpec(jobDir: string, revision: string, secrets: Record<string, string>): Promise<SlackArtifact> {
  const json = await requireCheckedFile(jobDir, ['spec.json'], SPEC_LIMIT);
  if (hash(json) !== revision) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    throw invalid();
  }
  const spec = SpecDocBaseSchema.safeParse(parsed);
  if (!spec.success) throw invalid();
  const { title, summary, outOfScope, tech, acceptanceChecks } = spec.data;
  const clean = (value: string) => stripMentionsAndLinks(redactOutput(value, secrets));
  const text = [
    clean(title), '', clean(summary), '', 'Acceptance checks',
    ...acceptanceChecks.map(({ id, text }) => `${id}: ${clean(text)}`),
    '', 'Out of scope', ...outOfScope.map(clean),
    '', 'Technology', ...tech.map(clean), '',
  ].join('\n');
  const normalizedSecrets = Object.fromEntries(Object.entries(secrets)
    .map(([key, value]) => [key, value.normalize('NFKC').replace(/\p{Cf}/gu, '')]));
  const bytes = Buffer.from(redactOutput(redactOutput(text, secrets), normalizedSecrets));
  if (bytes.length > SPEC_LIMIT) throw invalid();
  return { name: 'spec.txt', contentType: 'text/plain', bytes };
}

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Browser evidence must be a bounded, non-interlaced 8-bit PNG. Drop ancillary metadata. */
function checkedPng(source: Buffer): Buffer | undefined {
  if (!source.subarray(0, 8).equals(pngSignature)) return undefined;
  const output: Buffer[] = [pngSignature];
  const data: Buffer[] = [];
  let stride = 0;
  let height = 0;
  let offset = 8;
  let sawEnd = false;
  let finishedData = false;
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > source.length) return undefined;
    const chunk = source.subarray(offset, end);
    const type = chunk.subarray(4, 8).toString('latin1');
    const body = chunk.subarray(8, 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(chunk.subarray(4, -4)) !== chunk.readUInt32BE(length + 8)) return undefined;
    if (offset === 8 && type !== 'IHDR') return undefined;
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) return undefined;
      const width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[body[9]!];
      if (!width || !height || width * height > PIXEL_LIMIT || body[8] !== 8 || !channels || body.subarray(10).some(Boolean)) return undefined;
      stride = width * channels + 1;
      output.push(chunk);
    } else if (type === 'IDAT') {
      if (finishedData) return undefined;
      data.push(body);
      output.push(chunk);
    } else if (type === 'IEND') {
      if (length || end !== source.length || !data.length) return undefined;
      sawEnd = true;
      output.push(chunk);
      break;
    } else {
      if (/^[A-Z]/.test(type) || ['acTL', 'fcTL', 'fdAT', 'tRNS'].includes(type)) return undefined;
      if (data.length) finishedData = true;
    }
    offset = end;
  }
  if (!sawEnd) return undefined;
  try {
    const compressed = Buffer.concat(data);
    const { buffer: pixels, engine } = inflateSync(compressed, { maxOutputLength: stride * height, info: true }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    if (engine.bytesWritten !== compressed.length || pixels.length !== stride * height) return undefined;
    for (let row = 0; row < height; row++) {
      if (pixels[row * stride]! > 4) return undefined;
    }
    return Buffer.concat(output);
  } catch {
    return undefined;
  }
}

export async function requireSlackArtifact(
  jobDir: string,
  selection: ArtifactSelection,
  secrets?: Record<string, string>,
): Promise<SlackArtifact> {
  if (selection.kind === 'spec') {
    if (!SHA256.test(selection.revision)) throw invalid();
    if (!secrets) throw unavailable();
    return prepareSpec(jobDir, selection.revision, secrets);
  }
  if (selection.kind !== 'screenshot' || !CHECK_ID.test(selection.checkId) || !SHA256.test(selection.sha256)) throw invalid();
  const name = `${selection.checkId}.png`;
  const source = await requireCheckedFile(jobDir, ['evidence', 'screens', name], PNG_LIMIT);
  if (hash(source) !== selection.sha256) throw invalid();
  const bytes = checkedPng(source);
  if (!bytes) throw invalid();
  return { name, contentType: 'image/png', bytes };
}

export async function prepareSlackArtifact(
  jobDir: string,
  selection: ArtifactSelection,
  secrets?: Record<string, string>,
): Promise<SlackArtifact | undefined> {
  return requireSlackArtifact(jobDir, selection, secrets).catch(() => undefined);
}
