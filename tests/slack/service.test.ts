import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSlackService } from '../../src/slack/service.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-slack-service-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Slack service lifecycle', () => {
  it('refuses a second instance and releases the lock on shutdown', async () => {
    const make = () => startSlackService({
      home, roles: ['pm'],
      open: async () => ({ connected: () => true, stop: async () => {} }),
      drain: async () => {},
    });
    const service = await make();
    try {
      await expect(make()).rejects.toThrow(/already running/);
    } finally {
      await service.stop();
    }
    await (await make()).stop();
  });

  it('drains for healthy roles independently and retries the role that failed to start', async () => {
    const pmStop = vi.fn(async () => {});
    const qaStop = vi.fn(async () => {});
    const failThenConnect = vi.fn<() => Promise<{ connected(): boolean; stop(): Promise<void> }>>()
      .mockRejectedValueOnce(new Error('private transport detail'))
      .mockResolvedValue({ connected: () => true, stop: qaStop });
    const drain = vi.fn();
    const log = vi.fn();
    const service = await startSlackService({
      home, roles: ['pm', 'qa'], pollMs: 10, retryMs: 20,
      open: async (role) => role === 'pm'
        ? { connected: () => true, stop: pmStop }
        : failThenConnect(),
      drain, log,
    });
    try {
      await vi.waitFor(() => expect(drain.mock.calls.some(([roles]) => roles.has('pm') && !roles.has('qa'))).toBe(true));
      await vi.waitFor(() => expect(drain.mock.calls.some(([roles]) => roles.has('qa'))).toBe(true));
      expect(JSON.stringify(log.mock.calls)).not.toContain('private transport detail');
    } finally {
      await service.stop();
    }
    expect(pmStop).toHaveBeenCalledOnce();
    expect(qaStop).toHaveBeenCalledOnce();
    await service.stop();
  });

  it('reopens a dropped socket even when the first reopen fails', async () => {
    let dropped = false;
    const stopFirst = vi.fn(async () => {});
    const stopSecond = vi.fn(async () => {});
    const open = vi.fn()
      .mockResolvedValueOnce({ connected: () => !dropped, closed: () => dropped, stop: stopFirst })
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue({ connected: () => true, stop: stopSecond });
    const drain = vi.fn();
    const service = await startSlackService({ home, roles: ['pm'], open, drain, pollMs: 5, retryMs: 5 });
    try {
      await vi.waitFor(() => expect(drain).toHaveBeenCalledWith(new Set(['pm']), expect.any(AbortSignal), expect.any(Function)));
      drain.mockClear();
      dropped = true;
      await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => expect(drain).toHaveBeenCalledWith(new Set(['pm']), expect.any(AbortSignal), expect.any(Function)));
      expect(stopFirst).toHaveBeenCalledOnce();
    } finally {
      await service.stop();
    }
    expect(stopSecond).toHaveBeenCalledOnce();
  });

  it('tracks a socket drop while an earlier delivery pass is blocked', async () => {
    let connected = true;
    let unblock!: () => void;
    const hold = new Promise<void>((resolve) => { unblock = resolve; });
    let canDeliver: ((role: 'pm') => boolean) | undefined;
    const log = vi.fn();
    const service = await startSlackService<'pm'>({
      home, roles: ['pm'], pollMs: 5, log,
      open: async () => ({ connected: () => connected, stop: async () => {} }),
      async drain(roles, _signal, checkRole) {
        if (!roles.has('pm')) return;
        canDeliver = checkRole;
        await hold;
      },
    });
    try {
      await vi.waitFor(() => expect(canDeliver?.('pm')).toBe(true));
      log.mockClear();
      connected = false;
      expect(canDeliver?.('pm')).toBe(false);
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith('Slack pm: offline.'));
    } finally {
      unblock();
      await service.stop();
    }
  });

  it('leaves disconnected roles out of delivery until the socket reconnects', async () => {
    let connected = false;
    const drain = vi.fn();
    const service = await startSlackService({
      home, roles: ['pm'], pollMs: 10,
      open: async () => ({ connected: () => connected, stop: async () => {} }),
      drain,
    });
    try {
      await vi.waitFor(() => expect(drain).toHaveBeenCalledWith(new Set(), expect.any(AbortSignal), expect.any(Function)));
      connected = true;
      await vi.waitFor(() => expect(drain).toHaveBeenCalledWith(new Set(['pm']), expect.any(AbortSignal), expect.any(Function)));
    } finally {
      await service.stop();
    }
  });
});
