import { z } from 'zod';
import type { SlackRole } from './config.js';
import type { ActionResult, SlackAction } from './actions.js';

/*
 * Socket Mode input, normalized from the fields Slack supplies. Identity comes only from Slack IDs.
 * Bots, edits, forwarded messages and subtype events never become orders.
 */

/**
 * Clean text from Slack so it is only ever data: decode Slack's entity escapes, remove mention and
 * broadcast syntax, control and format characters, and limit the length.
 */
export function sanitizeSlackText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\p{Cf}/gu, '')
    .replace(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/<[@!#][^>]*>/g, '[mention]')
    .replace(/@(?:everyone|here|channel)\b/gi, '[mention]')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
    .slice(0, max)
    .trim();
}

export type Normalized = { kind: 'action'; action: SlackAction } | { kind: 'ignored'; reason: string };
const ignored = (reason: string): Normalized => ({ kind: 'ignored', reason });

const team = z.string().regex(/^T[A-Z0-9]{1,31}$/);
const user = z.string().regex(/^[UW][A-Z0-9]{1,31}$/);
const app = z.string().regex(/^A[A-Z0-9]{1,31}$/);
const channel = z.string().regex(/^[CDG][A-Z0-9]{1,31}$/);
const ts = z.string().regex(/^\d{1,16}\.\d{1,6}$/);

const commandBody = z.object({
  team_id: team, user_id: user, channel_id: channel, api_app_id: app,
  trigger_id: z.string().regex(/^[A-Za-z0-9.]{1,100}$/), command: z.literal('/anton'), text: z.string().max(4000).default(''),
  enterprise_id: z.undefined().optional(),
});

/** `/anton …`. Keyed by trigger ID, which Slack keeps on a retried delivery. */
export function normalizeCommand(body: unknown, role: SlackRole): Normalized {
  const b = commandBody.safeParse(body);
  if (!b.success) return ignored('unreadable command');
  const d = b.data;
  return {
    kind: 'action',
    action: {
      via: 'command', key: `cmd:${d.team_id}:${d.trigger_id}`,
      actor: { teamId: d.team_id, userId: d.user_id, isBot: false },
      source: { appId: d.api_app_id, role, channelId: d.channel_id },
      text: sanitizeSlackText(d.text, 200),
    },
  };
}

const blockActionBody = z.object({
  type: z.literal('block_actions'),
  team: z.object({ id: team }),
  user: z.object({ id: user, team_id: team.optional() }),
  api_app_id: app,
  channel: z.object({ id: channel }),
  container: z.object({ message_ts: ts }),
  actions: z.array(z.object({ action_id: z.string().max(255), value: z.string().regex(/^[a-f0-9]{32}$/), action_ts: ts })).length(1),
  enterprise: z.null().optional(),
});

/** A button click. The value is only the card token; what it does comes from the stored card. */
export function normalizeBlockAction(body: unknown, role: SlackRole): Normalized {
  const b = blockActionBody.safeParse(body);
  if (!b.success) return ignored('unreadable interaction');
  const d = b.data;
  const act = d.actions[0]!;
  if (d.user.team_id !== undefined && d.user.team_id !== d.team.id) return ignored('foreign user');
  return {
    kind: 'action',
    action: {
      via: 'card', key: `card:${d.team.id}:${d.channel.id}:${d.container.message_ts}:${act.action_ts}`,
      actor: { teamId: d.team.id, userId: d.user.id, isBot: false },
      source: { appId: d.api_app_id, role, channelId: d.channel.id, messageTs: d.container.message_ts },
      token: act.value,
    },
  };
}

const eventBody = z.object({
  team_id: team, api_app_id: app, event_id: z.string().regex(/^Ev[A-Za-z0-9]{1,40}$/),
  event: z.object({
    type: z.enum(['message', 'app_mention']),
    user: user.optional(), channel: channel, ts, thread_ts: ts.optional(), text: z.string().max(40_000).optional(),
    bot_id: z.unknown().optional(), subtype: z.unknown().optional(), edited: z.unknown().optional(),
    message: z.unknown().optional(), previous_message: z.unknown().optional(),
    attachments: z.array(z.record(z.string(), z.unknown())).optional(), user_team: z.string().optional(),
  }),
});

/** A message or mention. Normalized for the later conversation features; never an order. */
export function normalizeEvent(body: unknown, role: SlackRole): Normalized {
  const b = eventBody.safeParse(body);
  if (!b.success) return ignored('unreadable event');
  const { event: e, ...d } = b.data;
  if (e.bot_id !== undefined) return ignored('bot');
  if (e.subtype !== undefined || e.message !== undefined || e.previous_message !== undefined) return ignored('subtype');
  if (e.edited !== undefined) return ignored('edit');
  if (e.attachments?.some((a) => a.is_share === true || a.is_msg_unfurl === true || a.original_url !== undefined)) return ignored('forward');
  if (!e.user) return ignored('no user');
  if (e.user_team !== undefined && e.user_team !== d.team_id) return ignored('foreign user');
  return {
    kind: 'action',
    action: {
      via: 'message', key: `event:${d.team_id}:${d.event_id}`,
      actor: { teamId: d.team_id, userId: e.user, isBot: false },
      source: { appId: d.api_app_id, role, channelId: e.channel, messageTs: e.ts, ...(e.thread_ts ? { threadTs: e.thread_ts } : {}) },
      text: sanitizeSlackText(e.text, 4000),
    },
  };
}

export type Reply = { response_type: 'ephemeral'; text: string; replace_original?: false };
type Ack = (reply?: Reply) => Promise<void>;
type Respond = (reply: Reply) => Promise<unknown>;

export interface InboundHandler {
  command(body: unknown, role: SlackRole, ack: Ack, respond: Respond): Promise<void>;
  action(body: unknown, role: SlackRole, ack: Ack, respond: Respond): Promise<void>;
  event(body: unknown, role: SlackRole): Promise<void>;
  /** Resolves when all accepted work has finished (service stop and tests). */
  idle(): Promise<void>;
}

/** Plain, mention-free reply text. A denial says nothing about projects. */
export function renderResult(r: ActionResult): string {
  const lines = r.lines.map((l) => sanitizeSlackText(l, 500)).filter(Boolean).slice(0, 20);
  const fallback: Record<ActionResult['status'], string> = {
    done: 'Done.', duplicate: 'That was already handled.', 'in-progress': 'Already working on that.',
    denied: 'Only the Anton owner can do that here.', ignored: 'Nothing to do.', stale: 'That is out of date. Nothing was changed.',
    refused: 'Nothing was changed.', unsupported: 'Anton cannot do that from Slack yet.', failed: 'That did not work. Check the CLI.',
  };
  const text = r.status === 'denied' ? fallback.denied : (lines.length ? lines.join('\n') : fallback[r.status]);
  return text.slice(0, 3000);
}

/**
 * Acknowledge within Slack's three seconds, then run the action in the background. Idempotency lives in
 * the action store, so a redelivery during or after the work is answered without acting twice.
 */
export function createInboundHandler(deps: {
  dispatch(action: SlackAction): Promise<ActionResult>;
  log?: (message: string) => void;
  maxPending?: number;
}): InboundHandler {
  const active = new Set<Promise<void>>();
  const max = deps.maxPending ?? 8;
  const log = deps.log ?? (() => {});

  function start(work: () => Promise<void>): void {
    const p: Promise<void> = Promise.resolve()
      .then(work)
      .catch(() => log('Slack action failed to complete.'))
      .finally(() => { active.delete(p); });
    active.add(p);
  }

  async function reply(respond: Respond, r: ActionResult): Promise<void> {
    if (r.status === 'ignored') return;
    await respond({ response_type: 'ephemeral', text: renderResult(r), replace_original: false }).catch(() => log('Slack reply failed.'));
  }

  async function interactive(n: Normalized, ack: Ack, respond: Respond, ackText: boolean): Promise<void> {
    if (n.kind === 'ignored') {
      await ack(ackText ? { response_type: 'ephemeral', text: 'Anton could not read that.' } : undefined);
      return;
    }
    const busy = active.size >= max;
    if (ackText) await ack({ response_type: 'ephemeral', text: busy ? 'Anton is busy. Try again in a moment.' : 'Working on it.' });
    else await ack();
    if (busy) {
      if (!ackText) await reply(respond, { status: 'refused', lines: ['Anton is busy. Try again in a moment.'] });
      return;
    }
    const action = n.action;
    start(async () => reply(respond, await deps.dispatch(action)));
  }

  return {
    command: (body, role, ack, respond) => interactive(normalizeCommand(body, role), ack, respond, true),
    action: (body, role, ack, respond) => interactive(normalizeBlockAction(body, role), ack, respond, false),
    async event(body, role) {
      const n = normalizeEvent(body, role);
      if (n.kind === 'ignored' || active.size >= max) return;
      const action = n.action;
      start(async () => { await deps.dispatch(action); });
    },
    async idle() {
      while (active.size) await Promise.allSettled([...active]);
    },
  };
}
