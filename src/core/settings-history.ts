import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isMap, isScalar, parseDocument, Scalar } from 'yaml';
import { z } from 'zod';
import { AntonConfigSchema, type AntonConfig } from './anton-config.js';
import { readRegularFile, writeFileAtomic } from './atomic.js';
import { waitForLockFile } from './lock.js';
import { antonHome } from './paths.js';

type Json = z.infer<ReturnType<typeof z.json>>;
type Edit<T, Prefix extends string[] = []> = {
  [K in keyof T & string]-?: { path: [...Prefix, K]; value?: Exclude<T[K], undefined> }
    | (NonNullable<T[K]> extends readonly unknown[] ? never
      : NonNullable<T[K]> extends object ? Edit<NonNullable<T[K]>, [...Prefix, K]> : never);
}[keyof T & string];

export type SettingEdit = Edit<AntonConfig>;

const changeSchema = z.object({
  path: z.array(z.string()).min(1),
  before: z.json().optional(),
  after: z.json().optional(),
});
const recordSchema = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  intent: z.string(),
  source: z.enum(['slack', 'file']),
  beforeHash: z.string(),
  hash: z.string(),
  changes: z.array(changeSchema),
  undoOf: z.string().optional(),
});
export type SettingsHistoryEntry = z.infer<typeof recordSchema>;
type Change = SettingsHistoryEntry['changes'][number];

const observationSchema = z.object({
  hash: z.string(),
  config: AntonConfigSchema,
  entry: recordSchema.optional(),
});
const pendingSchema = observationSchema.extend({ entry: recordSchema });
type Observation = z.infer<typeof observationSchema>;

export class SettingsConflict extends Error {}

function contentHash(text: string | undefined): string {
  return createHash('sha256').update(text === undefined ? 'missing' : 'present\0' + text).digest('hex');
}

function configDocument(text: string | undefined) {
  const doc = parseDocument(text ?? '', { prettyErrors: true });
  if (doc.errors.length) throw doc.errors[0];
  return doc;
}

function configValue(doc: ReturnType<typeof configDocument>): AntonConfig {
  return AntonConfigSchema.parse(doc.toJS() ?? {});
}

function differences(before: Json | undefined, after: Json | undefined, path: string[] = []): Change[] {
  if (Object.is(before, after)) return [];
  if (isObject(before) && isObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      differences(ownValue(before, key), ownValue(after, key), [...path, key]));
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length
    && before.every((value, index) => differences(value, after[index]).length === 0)) return [];
  return [{ path, before, after }];
}

function isObject(value: Json | undefined): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ownValue(value: Json | undefined, key: string): Json | undefined {
  return isObject(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function valueAt(config: AntonConfig, path: string[]): Json | undefined {
  return path.reduce<Json | undefined>(ownValue, z.json().parse(config));
}

function overlaps(a: string[], b: string[]): boolean {
  return a.slice(0, Math.min(a.length, b.length)).every((key, index) => key === b[index]);
}

function setValue(doc: ReturnType<typeof configDocument>, path: string[], value: Json | undefined): void {
  if (value === undefined) {
    doc.deleteIn(path);
    return;
  }
  const current = doc.getIn(path, true);
  if (isScalar(current) && (value === null || typeof value !== 'object')) {
    current.value = value;
  } else if (isMap(current) && isObject(value)) {
    for (const { path: relative, after } of differences(current.toJSON(), value)) {
      setValue(doc, [...path, ...relative], after);
    }
  } else {
    doc.setIn(path, doc.createNode(value));
  }
}

// Splice scalar edits into the source to retain the Owner's spacing and line endings.
function renderConfig(text: string | undefined, doc: ReturnType<typeof configDocument>, changes: Change[]): string {
  let rendered = doc.toString({ lineWidth: 0 });
  if (text !== undefined) {
    const original = configDocument(text);
    const updated = configDocument(rendered);
    const replacements = changes.map(({ path }) => {
      const before = original.getIn(path, true);
      const after = updated.getIn(path, true);
      if (!isScalar(before) || !isScalar(after) || !before.range || !after.range
        || before.type === Scalar.BLOCK_FOLDED || before.type === Scalar.BLOCK_LITERAL) return undefined;
      return { start: before.range[0], end: before.range[1], value: rendered.slice(after.range[0], after.range[1]) };
    });
    if (replacements.every((replacement): replacement is NonNullable<typeof replacement> =>
      replacement !== undefined && !replacement.value.includes('\n'))) {
      let output = text;
      for (const { start, end, value } of replacements.sort((a, b) => b.start - a.start)) {
        output = output.slice(0, start) + value + output.slice(end);
      }
      return output;
    }

    // For structural edits, retain the source of unrelated top-level sections.
    if (isMap(original.contents) && isMap(updated.contents)) {
      const sections = [];
      for (const { key, value } of updated.contents.items) {
        if (!isScalar(key) || typeof key.value !== 'string' || !key.range
          || changes.some(({ path }) => path[0] === key.value)) continue;
        const prior = original.contents.items.find((pair) => isScalar(pair.key) && pair.key.value === key.value);
        if (!isScalar(prior?.key) || !prior.key.range) continue;
        const start = key.range[0];
        const end = sourceEnd(value, key.range[2]);
        const source = text.slice(prior.key.range[0], sourceEnd(prior.value, prior.key.range[2]));
        // Collection ranges can include the final newline, while flow ranges can exclude it.
        const suffix = rendered.slice(start, end).match(/\n*$/)?.[0] ?? '';
        sections.push({ start, end, source: source.replaceAll('\r\n', '\n').replace(/\n*$/, suffix) });
      }
      for (const { start, end, source } of sections.reverse()) {
        rendered = rendered.slice(0, start) + source + rendered.slice(end);
      }
    }
  }
  return text?.includes('\r\n') ? rendered.replaceAll('\n', '\r\n') : rendered;
}

function sourceEnd(value: unknown, keyEnd: number): number {
  return typeof value === 'object' && value !== null && 'range' in value && Array.isArray(value.range)
    ? value.range[2] as number
    : keyEnd;
}

function entry(intent: string, source: SettingsHistoryEntry['source'], beforeHash: string, hash: string, changes: Change[]): SettingsHistoryEntry {
  return { id: randomUUID(), at: new Date().toISOString(), intent, source, beforeHash, hash, changes };
}

async function withSettings<T>(home: string, action: (state: {
  text: string | undefined;
  hash: string;
  config: AntonConfig;
  history: SettingsHistoryEntry[];
  write: (text: string, config: AntonConfig, entry: SettingsHistoryEntry) => Promise<void>;
}) => Promise<T>): Promise<T> {
  await mkdir(home, { recursive: true });
  const release = await waitForLockFile(join(home, 'settings-history.lock'));
  const configPath = join(home, 'config.yaml');
  const historyPath = join(home, 'settings-history.jsonl');
  const observationPath = join(home, 'settings-history-state.json');
  const pendingPath = join(home, 'settings-history-pending.json');
  try {
    let historyText = (await readRegularFile(historyPath)) ?? '';
    const history = historyText.split('\n').filter((line) => line.trim())
      .map((line) => recordSchema.parse(JSON.parse(line)));
    const text = await readRegularFile(configPath);
    const hash = contentHash(text);

    async function record(observation: Observation): Promise<void> {
      const { entry } = observation;
      if (entry && !history.some(({ id }) => id === entry.id)) {
        historyText = historyText.trimEnd() + (historyText.trim() ? '\n' : '') + JSON.stringify(entry) + '\n';
        await writeFileAtomic(historyPath, historyText);
        history.push(entry);
      }
      await writeFileAtomic(observationPath, JSON.stringify(observation));
    }

    // Replay an interrupted commit only when the config contains its exact output.
    const pendingText = await readRegularFile(pendingPath);
    if (pendingText !== undefined) {
      const pending = pendingSchema.parse(JSON.parse(pendingText));
      if (pending.entry.source === 'file' || hash === pending.hash || history.some(({ id }) => id === pending.entry.id)) {
        await record(pending);
      } else if (hash !== pending.entry.beforeHash) {
        throw new SettingsConflict('Config changed during an interrupted settings write');
      }
      await rm(pendingPath);
    }

    const previousText = await readRegularFile(observationPath);
    const previous = previousText === undefined ? undefined : observationSchema.parse(JSON.parse(previousText));
    const config = configValue(configDocument(text));
    if (!previous) {
      await record({ hash, config });
    } else if (previous.hash !== hash) {
      const change = entry('file_edit', 'file', previous.hash, hash, differences(z.json().parse(previous.config), z.json().parse(config)));
      const observation = { hash, config, entry: change };
      await writeFileAtomic(pendingPath, JSON.stringify(observation));
      await record(observation);
      await rm(pendingPath);
    }

    return await action({
      text, hash, config, history,
      async write(nextText, nextConfig, change) {
        const observation = { hash: change.hash, config: nextConfig, entry: change };
        await writeFileAtomic(pendingPath, JSON.stringify(observation));
        if (contentHash(await readRegularFile(configPath)) !== hash) {
          await rm(pendingPath);
          throw new SettingsConflict('Config changed while preparing the settings write');
        }
        await writeFileAtomic(configPath, nextText);
        await record(observation);
        await rm(pendingPath);
      },
    });
  } finally {
    await release();
  }
}

/** Observe hand edits and return the hash a caller can put on a confirmation. */
export function readSettingsHistory(home = antonHome()) {
  return withSettings(home, async ({ hash, config, history }) => ({ hash, config, history }));
}

export type SettingsRequest = { expectedHash: string } & (
  { intent: string; edits: readonly SettingEdit[] } | { undoId: string }
);

/** Apply a confirmed batch or undo the latest applied entry as a single config write. */
export function applySettingsChange(request: SettingsRequest, home = antonHome()): Promise<SettingsHistoryEntry | undefined> {
  return withSettings(home, async ({ text, hash, config, history, write }) => {
    if (hash !== request.expectedHash) throw new SettingsConflict('Config changed since confirmation was prepared');

    const undo = 'undoId' in request;
    const target = undo ? history.findLast(({ source }) => source === 'slack') : undefined;
    if (undo && (!target || target.id !== request.undoId)) {
      throw new SettingsConflict('The selected change is no longer the latest applied setting change');
    }
    const edits = 'edits' in request ? request.edits : target!.changes.map(({ path, before }) => ({ path, value: before }));
    if (target) {
      const later = history.slice(history.indexOf(target) + 1);
      for (const { path, after } of target.changes) {
        if (differences(valueAt(config, path), after).length
          || later.some(({ changes }) => changes.some((change) => overlaps(path, change.path)))) {
          throw new SettingsConflict(`The setting ${path.join('.')} has changed since it was applied`);
        }
      }
    }

    const doc = configDocument(text);
    const changes: Change[] = [];
    for (const { path, value } of edits) {
      if (!path.length || path.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))
        || changes.some((change) => overlaps(change.path, path))) {
        throw new Error(`Invalid or overlapping setting path: ${path.join('.')}`);
      }
      const before = valueAt(config, path);
      const after = value === undefined ? undefined : z.json().parse(value);
      if (!differences(before, after).length) continue;
      setValue(doc, path, after);
      changes.push({ path, before, after });
    }
    if (!changes.length) return undefined;

    const output = renderConfig(text, doc, changes);
    const nextConfig = configValue(configDocument(output));
    const actualChanges = differences(z.json().parse(config), z.json().parse(nextConfig));
    if (!actualChanges.length) return undefined;
    if (changes.some(({ path, after }) => differences(valueAt(nextConfig, path), after).length)
      || actualChanges.some(({ path }) => !changes.some((requested) => overlaps(requested.path, path)))) {
      throw new Error('The YAML edit would change other settings, possibly through an alias');
    }
    if (!undo) {
      for (const { path, min, max } of [
        { path: ['budget', 'defaultUsd'], min: 0.5, max: 500 },
        { path: ['budget', 'monthlyUsd'], min: 0, max: 5000 },
        { path: ['chat', 'monthlyUsd'], min: 0, max: 5000 },
        { path: ['call', 'monthlyUsd'], min: 0, max: 5000 },
      ]) {
        const amount = valueAt(nextConfig, path);
        if (typeof amount === 'number' && amount !== valueAt(config, path) && (amount < min || amount > max)) {
          throw new Error(`${path.join('.')} must be between $${min} and $${max}`);
        }
      }
    }
    const change = entry('intent' in request ? request.intent : 'undo_setting', 'slack', hash, contentHash(output), actualChanges);
    if (target) change.undoOf = target.id;
    await write(output, nextConfig, change);
    return change;
  });
}
