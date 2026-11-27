import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { readRegularFile, writeFileAtomic } from '../core/atomic.js';
import { waitForLockFile } from '../core/lock.js';
import { antonHome } from '../core/paths.js';
import { redact } from '../core/secrets.js';
import { slackDirectory, teamIdSchema, userIdSchema } from './config.js';
import { projectId } from './events.js';

const RETRY_MS = 10 * 60_000;
const CONTEXT_MS = 24 * 60 * 60_000;
const MAX_TEXT_BYTES = 6000;
const bindingSchema = z.object({
  teamId: teamIdSchema,
  channelId: z.string().regex(/^[CDG][A-Z0-9]{1,31}$/),
  threadTs: z.string().regex(/^\d{1,16}\.\d{1,6}$/),
  ownerId: userIdSchema,
});
const contextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('context'), project: projectId.optional() }),
  z.object({ kind: z.literal('clarification'), project: projectId.optional(), originalText: z.string(), question: z.string().optional() }),
]);
const entrySchema = bindingSchema.extend({
  createdAt: z.number(),
  clarificationAt: z.number().optional(),
  retryClaim: z.string().uuid().optional(),
  kind: z.enum(['context', 'clarification']),
  project: projectId.optional(),
  originalText: z.string().optional(),
  question: z.string().optional(),
});
const storeSchema = z.object({ version: z.literal(1), threads: z.array(entrySchema) });
type Entry = z.infer<typeof entrySchema>;

export type IntentThreadBinding = z.infer<typeof bindingSchema>;
export type IntentThreadContext = z.infer<typeof contextSchema>;
export type IntentThreadOptions = { home?: string; now?: () => number };
export type IntentThreadReply =
  | { kind: 'missing' }
  | { kind: 'help' }
  | { kind: 'context'; project?: string }
  | { kind: 'retry'; project?: string; originalText: string; question?: string; retryClaim: string };

function scrub(text: string, secrets: Record<string, string>): string {
  let clean = redact(text, secrets).replace(/\[REDACTED:[^\]\r\n]+\]/g, '[REDACTED]');
  for (const value of Object.values(secrets)) {
    if (value && value.length < 8) clean = clean.split(value).join('[REDACTED]');
  }
  clean = clean.normalize('NFKC').replace(/\p{Cf}/gu, '')
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(?:xox[a-z]-[\w-]+|xapp-[\w-]+|sk-[\w-]+|gh[pousr]_[\w-]+|github_pat_[\w-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/\bBearer[ \t]+[\w.~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b([\w-]*(?:password|secret|token|api[_-]?key)[\w-]*)[ \t]*[:=][ \t]*(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi, '$1=[REDACTED]');
  return Buffer.from(clean).subarray(0, MAX_TEXT_BYTES).toString('utf8').replace(/�$/, '');
}

async function withThreads<T>(
  binding: IntentThreadBinding,
  options: IntentThreadOptions,
  update: (threads: Entry[], entry: Entry | undefined, now: number) => { value: T; changed: boolean },
): Promise<T> {
  const root = (await slackDirectory(options.home ?? antonHome(), true))!;
  const release = await waitForLockFile(join(root, 'intent-threads.lock'));
  try {
    const now = (options.now ?? Date.now)();
    const path = join(root, 'intent-threads.json');
    const raw = await readRegularFile(path);
    let threads: Entry[] = [];
    if (raw !== undefined) {
      try {
        threads = storeSchema.parse(JSON.parse(raw)).threads;
      } catch {
        throw new Error('Cannot read valid Slack intent thread storage.');
      }
    }
    const active = threads.filter((thread) => now - thread.createdAt < CONTEXT_MS);
    let pruned = active.length !== threads.length;
    for (const thread of active) {
      if (thread.originalText !== undefined && now - (thread.clarificationAt ?? thread.createdAt) >= RETRY_MS) {
        delete thread.originalText;
        delete thread.question;
        pruned = true;
      }
    }
    const matching = active.find((thread) =>
      thread.teamId === binding.teamId && thread.channelId === binding.channelId && thread.threadTs === binding.threadTs);
    const result = update(active, matching, now);
    if (pruned || result.changed) await writeFileAtomic(path, JSON.stringify({ version: 1, threads: active }));
    return result.value;
  } finally {
    await release();
  }
}

/** Register once per workspace/channel/thread. A live entry keeps its original owner, context and deadlines. */
export async function registerIntentThread(
  binding: IntentThreadBinding,
  context: IntentThreadContext,
  options: IntentThreadOptions & { secrets?: Record<string, string>; clarifyExisting?: boolean } = {},
): Promise<boolean> {
  const identity = bindingSchema.parse(binding);
  const safe = contextSchema.parse(context);
  if (safe.kind === 'clarification') {
    safe.originalText = scrub(safe.originalText, options.secrets ?? {});
  }
  return withThreads(identity, options, (threads, entry, now) => {
    if (entry) {
      if (!options.clarifyExisting || entry.kind !== 'context' || safe.kind !== 'clarification'
        || entry.ownerId !== identity.ownerId) return { value: false, changed: false };
      Object.assign(entry, safe, { clarificationAt: now });
    } else {
      threads.push({ ...identity, ...safe, createdAt: now });
    }
    return { value: true, changed: true };
  });
}

/** Resolve an owner reply, consuming a clarification retry on disk before returning its original message. */
export async function claimIntentThreadReply(
  binding: IntentThreadBinding, options: IntentThreadOptions = {},
): Promise<IntentThreadReply> {
  const identity = bindingSchema.safeParse(binding);
  if (!identity.success) return { kind: 'missing' };
  return withThreads<IntentThreadReply>(identity.data, options, (_threads, entry) => {
    if (!entry || entry.ownerId !== identity.data.ownerId) return { value: { kind: 'missing' }, changed: false };
    const project = entry.project === undefined ? {} : { project: entry.project };
    if (entry.kind === 'context') return { value: { kind: 'context', ...project }, changed: false };
    const { originalText, question } = entry;
    if (originalText === undefined) return { value: { kind: 'help' }, changed: false };
    delete entry.originalText;
    delete entry.question;
    const retryClaim = randomUUID();
    entry.retryClaim = retryClaim;
    return { value: { kind: 'retry', ...project, originalText, ...(question === undefined ? {} : { question }), retryClaim }, changed: true };
  });
}


/** A resolved retry can promote only the clarification it consumed, preserving the original thread lifetime. */
export async function completeIntentThreadClarification(
  binding: IntentThreadBinding, retryClaim: string, project: string | undefined, options: IntentThreadOptions = {},
): Promise<boolean> {
  const identity = bindingSchema.parse(binding);
  const chosen = projectId.optional().parse(project);
  return withThreads(identity, options, (_threads, entry) => {
    if (entry?.ownerId !== identity.ownerId || entry.kind !== 'clarification' || entry.retryClaim !== retryClaim) {
      return { value: false, changed: false };
    }
    entry.kind = 'context';
    entry.project = chosen ?? entry.project;
    delete entry.retryClaim;
    delete entry.clarificationAt;
    return { value: true, changed: true };
  });
}

/** Remember the project of a posted confirmation in an active Owner thread. */
export async function updateIntentThreadProject(
  binding: IntentThreadBinding, project: string, options: IntentThreadOptions = {},
): Promise<void> {
  const identity = bindingSchema.parse(binding);
  const chosen = projectId.parse(project);
  await withThreads(identity, options, (_threads, entry) => {
    if (entry?.ownerId !== identity.ownerId || entry.kind !== 'context' || entry.project === chosen) {
      return { value: undefined, changed: false };
    }
    entry.project = chosen;
    return { value: undefined, changed: true };
  });
}
