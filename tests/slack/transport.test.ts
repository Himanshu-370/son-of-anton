import { webApi } from '@slack/bolt';
import { describe, expect, it, vi } from 'vitest';
import type { SlackConfig } from '../../src/slack/config.js';
import { createSlackTransport } from '../../src/slack/transport.js';
import type { OutboxMessageRequest } from '../../src/slack/outbox.js';

const config = {
  teamId: 'TTEST', ownerId: 'UOWNER', channelId: 'CGENERAL',
  roles: { pm: { appId: 'APM', botUserId: 'UPM' }, qa: { appId: 'AQA', botUserId: 'UQA' } },
} as SlackConfig;
const marker = 'anton-' + 'a'.repeat(64);
const request: OutboxMessageRequest = {
  teamId: 'TTEST', channelId: 'CPROJECT', botUserId: 'UQA', role: 'qa', text: 'Verified',
  marker, threadTs: '1.000001', unfurlLinks: false, unfurlMedia: false,
};

function fake() {
  const postMessage = vi.fn(async () => ({ ok: true, channel: 'CPROJECT', ts: '2.000001' }));
  const replies = vi.fn(async () => ({
    ok: true, messages: [{ user: 'UQA', ts: '2.000001', metadata: { event_type: 'anton_delivery', event_payload: { marker } } }],
  }));
  const history = vi.fn(async () => ({
    ok: true, messages: [{ user: 'UPM', ts: '1.000001', metadata: { event_type: 'anton_delivery', event_payload: { marker } } }],
  }));
  const client = { chat: { postMessage }, conversations: { replies, history } };
  const verifyChannel = vi.fn(async () => true);
  const transport = createSlackTransport(config, {
    client: () => client as never, verifyChannel,
  });
  return { transport, postMessage, replies, history, verifyChannel };
}

describe('Slack Web API delivery', () => {
  it('posts to the verified thread and correlates the result using the sender and marker', async () => {
    const { transport, postMessage } = fake();
    await expect(transport.postMessage(request)).resolves.toEqual({ ts: '2.000001' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'CPROJECT', thread_ts: '1.000001', unfurl_links: false, unfurl_media: false, mrkdwn: false,
      metadata: { event_type: 'anton_delivery', event_payload: { marker } },
    }));
    await expect(transport.lookupMarker({ kind: 'message', request })).resolves.toEqual({ status: 'found', ts: '2.000001' });
  });

  it('refuses a destination that lost its private membership or role binding', async () => {
    const { transport, verifyChannel, postMessage } = fake();
    verifyChannel.mockResolvedValue(false);
    await expect(transport.postMessage(request)).rejects.toMatchObject({ outcome: 'retry' });
    await expect(transport.postMessage({ ...request, botUserId: 'UOTHER' })).rejects.toMatchObject({ outcome: 'permanent' });
    expect(postMessage).not.toHaveBeenCalled();
  });
  it('confirms an uncertain parent only at the exact timestamp with its sender and marker', async () => {
    const { transport, history } = fake();
    const parent = { ...request, threadTs: undefined, role: 'pm', botUserId: 'UPM' } as const;
    await expect(transport.confirmParent(parent, '1.000001')).resolves.toBe(true);
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ oldest: '1.000001', latest: '1.000001', inclusive: true }));
    await expect(transport.confirmParent({ ...parent, marker: 'different' }, '1.000001')).resolves.toBe(false);
    await expect(transport.confirmParent(parent, '1.000002')).resolves.toBe(false);
  });

  it('keeps a rate-limited lookup retryable and distinguishes an explicit send rejection', async () => {
    const { transport, postMessage, replies } = fake();
    replies.mockRejectedValueOnce(new webApi.WebAPIRateLimitedError(15));
    await expect(transport.lookupMarker({ kind: 'message', request }))
      .rejects.toMatchObject({ outcome: 'retry', retryAfterMs: 15_000 });
    postMessage.mockRejectedValueOnce(new webApi.WebAPIPlatformError({ ok: false, error: 'missing_scope' }));
    await expect(transport.postMessage(request)).rejects.toMatchObject({ outcome: 'permanent' });
  });
});
