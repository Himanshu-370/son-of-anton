import { sanitizeSlackText } from './inbound.js';

/*
 * Pure Block Kit rendering for review cards and their modals. Every button carries only an opaque card token;
 * action IDs are positional (`anton_<n>`), so neither says what the card does or which job it is for. Text that
 * came from a model or a person is shown as plain text, without mentions or links.
 */

export type SlackBlock = Record<string, unknown>;
export type SlackView = { text: string; blocks: SlackBlock[] };
export type ReviewTarget = { kind: 'spec' | 'delivery' | 'paused' | 'lessons' | 'questions' | 'reminder' | 'spend'; project?: string; jobId?: string };
export type ReviewButton = { label: string; token: string; style?: 'primary' | 'danger'; confirm?: string };
export type ReviewSection = { text: string; buttons?: ReviewButton[] };
export type ReviewData = {
  title: string;
  lines?: string[];
  buttons?: ReviewButton[];
  /** Further sections, each with its own buttons (one per lesson proposal). */
  sections?: ReviewSection[];
  /** A user ID to mention in a fixed, Anton-written line (the owner). */
  mention?: string;
};

const TEXT_LIMIT = 2900;

/** Display-safe text: no mentions, links or control characters, bounded. */
export function displayText(value: string, max = TEXT_LIMIT): string {
  return sanitizeSlackText(value, max * 2)
    .replace(/\b(?:https?|file|ftp):\/\/\S+/gi, '[link removed]')
    .replace(/\bwww\.\S+/gi, '[link removed]')
    .slice(0, max)
    .trim();
}

const plain = (text: string) => ({ type: 'plain_text', text: displayText(text) || ' ', emoji: false });

function actions(buttons: ReviewButton[], start: number): SlackBlock {
  return {
    type: 'actions',
    elements: buttons.slice(0, 25).map((b, i) => ({
      type: 'button',
      action_id: `anton_${start + i}`,
      text: plain(b.label.slice(0, 70)),
      value: b.token,
      ...(b.style ? { style: b.style } : {}),
      ...(b.confirm ? {
        confirm: { title: plain('Are you sure?'), text: plain(b.confirm), confirm: plain('Yes'), deny: plain('Cancel') },
      } : {}),
    })),
  };
}

const USER = /^[UW][A-Z0-9]{1,31}$/;

/** A card (or a plain thread message) as fallback text plus blocks. */
export function renderReview(target: ReviewTarget, data: ReviewData): SlackView {
  const blocks: SlackBlock[] = [];
  const mention = data.mention && USER.test(data.mention) ? `<@${data.mention}> ` : '';
  const title = displayText(data.title, 150);
  if (mention) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${mention}${displayText(title, 150).replace(/[*_~`&<>]/g, ' ')}` } });
  else blocks.push({ type: 'section', text: plain(title) });
  const body = (data.lines ?? []).map((l) => displayText(l, 500)).filter(Boolean).join('\n');
  if (body) blocks.push({ type: 'section', text: plain(body.slice(0, TEXT_LIMIT)) });
  let n = 0;
  if (data.buttons?.length) {
    blocks.push(actions(data.buttons, n));
    n += data.buttons.length;
  }
  for (const s of (data.sections ?? []).slice(0, 10)) {
    blocks.push({ type: 'divider' }, { type: 'section', text: plain(s.text) });
    if (s.buttons?.length) {
      blocks.push(actions(s.buttons, n));
      n += s.buttons.length;
    }
  }
  const label = target.kind === 'reminder' || target.kind === 'questions' ? '' : ` [${target.kind}]`;
  const text = `${mention}${title}${label}${body ? `\n${body}` : ''}`.slice(0, TEXT_LIMIT);
  return { text, blocks };
}

export type ModalKind = 'reject' | 'spec-revise' | 'accept-risk' | 'lesson-edit' | 'resume';
export type ModalMeta = { token: string; channelId: string; messageTs: string };
export type ModalView = {
  type: 'modal'; callback_id: string; private_metadata: string; title: unknown; submit: unknown; close: unknown; blocks: SlackBlock[];
};
export const MODAL_CALLBACK = 'anton_card';

type Field = { block: string; label: string; multiline: boolean; max: number; optional?: boolean; hint?: string };
const FIELDS: Record<ModalKind, { title: string; submit: string; field: Field }> = {
  reject: { title: 'Reject delivery', submit: 'Send back', field: { block: 'notes', label: 'What should change?', multiline: true, max: 4000 } },
  'spec-revise': { title: 'Request changes', submit: 'Revise spec', field: { block: 'notes', label: 'What should change in the spec?', multiline: true, max: 4000 } },
  'accept-risk': { title: 'Accept risk', submit: 'Accept', field: { block: 'reason', label: 'Why is this risk acceptable?', multiline: true, max: 500 } },
  'lesson-edit': { title: 'Edit lesson', submit: 'Save lesson', field: { block: 'text', label: 'Lesson text', multiline: true, max: 300 } },
  resume: { title: 'Resume job', submit: 'Resume', field: { block: 'budget', label: 'New total budget in USD (optional)', multiline: false, max: 20, optional: true, hint: 'Leave empty to resume with the current budget.' } },
};

export function cardModal(kind: ModalKind, meta: ModalMeta, initial?: string): ModalView {
  const { title, submit, field } = FIELDS[kind];
  const initialValue = initial ? displayText(initial, field.max) : '';
  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK,
    private_metadata: JSON.stringify({ token: meta.token, channelId: meta.channelId, messageTs: meta.messageTs }),
    title: plain(title),
    submit: plain(submit),
    close: plain('Cancel'),
    blocks: [{
      type: 'input',
      block_id: field.block,
      ...(field.optional ? { optional: true } : {}),
      label: plain(field.label),
      ...(field.hint ? { hint: plain(field.hint) } : {}),
      element: {
        type: 'plain_text_input', action_id: field.block, multiline: field.multiline, max_length: field.max,
        ...(initialValue ? { initial_value: initialValue } : {}),
      },
    }],
  };
}

type Values = Record<string, Record<string, { value?: string | null } | undefined> | undefined>;
export type ModalInput = { notes?: string; reason?: string; text?: string; budgetUsd?: number };

/** The submitted fields, raw. The router cleans and limits every text value before use. */
export function readModalInput(_kind: ModalKind | undefined, values: unknown): ModalInput {
  const v = (values && typeof values === 'object' ? values : {}) as Values;
  const read = (block: string) => {
    const raw = v[block]?.[block]?.value;
    return typeof raw === 'string' ? raw.slice(0, 5000) : undefined;
  };
  const out: ModalInput = {};
  for (const key of ['notes', 'reason', 'text'] as const) {
    const value = read(key);
    if (value !== undefined) out[key] = value;
  }
  const budget = read('budget')?.trim().replace(/^\$/, '');
  if (budget) out.budgetUsd = Number(budget);
  return out;
}
