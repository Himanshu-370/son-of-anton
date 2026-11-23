import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Role } from '../core/config.js';
import { antonHome } from '../core/paths.js';

export const SLACK_ROLES = [
  'pm', 'tech_lead', 'frontend', 'backend', 'infra', 'qa', 'code_reviewer', 'security_reviewer', 'coach',
] as const satisfies readonly Role[];

export type SlackRole = typeof SLACK_ROLES[number];

export const teamIdSchema = z.string().regex(/^T[A-Z0-9]+$/);
export const userIdSchema = z.string().regex(/^[UW][A-Z0-9]+$/);
export const appIdSchema = z.string().regex(/^A[A-Z0-9]+$/);
export const channelIdSchema = z.string().regex(/^[CG][A-Z0-9]+$/);
export const roleIdentitySchema = z.strictObject({ appId: appIdSchema, botUserId: userIdSchema });
export const roleCredentialsSchema = z.strictObject({
  appToken: z.string().regex(/^xapp-[^\s\p{Cc}]+$/u),
  botToken: z.string().regex(/^xoxb-[^\s\p{Cc}]+$/u),
});

const configSchema = z.strictObject({
  teamId: teamIdSchema,
  ownerId: userIdSchema,
  channelId: channelIdSchema,
  roles: z.record(z.enum(SLACK_ROLES), roleIdentitySchema),
}).refine(({ roles, ownerId }) => {
  const entries = Object.values(roles);
  return new Set(entries.map(({ appId }) => appId)).size === SLACK_ROLES.length
    && new Set(entries.map(({ botUserId }) => botUserId)).size === SLACK_ROLES.length
    && entries.every(({ botUserId }) => botUserId !== ownerId);
});

const credentialsSchema = z.record(z.enum(SLACK_ROLES), roleCredentialsSchema);

export type SlackConfig = z.infer<typeof configSchema>;
export type SlackCredentials = z.infer<typeof credentialsSchema>;
type SlackFile = 'config.json' | 'credentials.json' | 'setup.json' | 'setup-credentials.json';
const dir = (home: string) => join(home, 'slack');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export async function slackDirectory(home: string, create = false): Promise<string | undefined> {
  const path = dir(home);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return undefined;
  });
  if (!info) return undefined;
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700) {
    throw new Error('The Slack directory must be owned by you, have permissions 0700, and be a real directory.');
  }
  return path;
}

export async function readSlackFile<T>(home: string, name: SlackFile, schema: z.ZodType<T>): Promise<T | undefined> {
  const folder = await slackDirectory(home);
  if (!folder) return undefined;
  const handle = await open(join(folder, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw new Error(`Cannot safely open Slack ${name}.`);
    });
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600) {
      throw new Error(`Slack ${name} must be a regular file owned by you with permissions 0600.`);
    }
    try {
      return schema.parse(JSON.parse(await handle.readFile('utf8')));
    } catch {
      throw new Error(`Cannot read valid data from Slack ${name}.`);
    }
  } finally {
    await handle.close();
  }
}

/** The generic atomic writer uses the default file mode. These files must be private from creation. */
export async function writeSlackFile(home: string, name: SlackFile, data: unknown): Promise<void> {
  const folder = (await slackDirectory(home, true))!;
  const path = join(folder, name);
  const tmp = join(folder, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify(data, null, 2) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    const directory = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

export function loadSlackConfig(home = antonHome()): Promise<SlackConfig | undefined> {
  return readSlackFile(home, 'config.json', configSchema);
}

export function loadSlackCredentials(home = antonHome()): Promise<SlackCredentials | undefined> {
  return readSlackFile(home, 'credentials.json', credentialsSchema);
}
