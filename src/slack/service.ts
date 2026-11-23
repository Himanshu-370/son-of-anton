import { join } from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import { acquireLock } from '../core/lock.js';
import { slackDirectory } from './config.js';

export interface RoleConnection {
  connected(): boolean;
  closed?(): boolean;
  stop(): Promise<void>;
}

type ServiceDeps<Role extends string> = {
  home: string;
  roles: readonly Role[];
  open(role: Role, signal: AbortSignal): Promise<RoleConnection>;
  drain(connected: ReadonlySet<Role>, signal: AbortSignal, canDeliver: (role: Role) => boolean): Promise<void>;
  log?: (message: string) => void;
  pollMs?: number;
  retryMs?: number;
};

type RoleState = {
  connection?: RoleConnection;
  opening?: Promise<void>;
  retryAt: number;
  health?: 'connected' | 'offline';
};

/** The service owns only its Slack connections and worker. Pipeline jobs run independently. */
export async function startSlackService<Role extends string>(
  deps: ServiceDeps<Role>,
): Promise<{ stop(): Promise<void> }> {
  const root = (await slackDirectory(deps.home, true))!;
  const release = await acquireLock(root, 'service.lock');
  const controller = new AbortController();
  const { signal } = controller;
  const roles = new Map<Role, RoleState>(deps.roles.map((role) => [role, { retryAt: 0 }]));
  const log = deps.log ?? (() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  const canDeliver = (role: Role): boolean =>
    !signal.aborted && (roles.get(role)?.connection?.connected() ?? false);
  let stopped: Promise<void> | undefined;

  async function open(role: Role, entry: RoleState, previous?: RoleConnection): Promise<void> {
    try {
      if (previous) await previous.stop();
      signal.throwIfAborted();
      entry.connection = await deps.open(role, signal);
    } catch {
      entry.retryAt = Date.now() + (deps.retryMs ?? 30_000);
      if (!signal.aborted) log(`Slack ${role}: connection failed, will retry.`);
    } finally {
      delete entry.opening;
    }
  }

  async function tick(): Promise<void> {
    const connected = new Set<Role>();
    let changed = false;
    for (const [role, entry] of roles) {
      if (!entry.opening && entry.retryAt <= Date.now() && (!entry.connection || entry.connection.closed?.())) {
        const previous = entry.connection;
        delete entry.connection;
        entry.opening = Promise.resolve().then(() => open(role, entry, previous));
      }
      const online = canDeliver(role);
      if (online) connected.add(role);
      const health = online ? 'connected' : 'offline';
      if (entry.health !== health) {
        entry.health = health;
        changed = true;
        log(`Slack ${role}: ${health}.`);
      }
    }
    if (changed) await writeFileAtomic(join(root, 'service-health.json'), JSON.stringify({
      pid: process.pid, roles: Object.fromEntries(Array.from(roles, ([role, entry]) => [role, entry.health])),
    }) + '\n').catch(() => undefined);
    if (!signal.aborted && !draining) {
      draining = Promise.resolve().then(() => deps.drain(connected, signal, canDeliver))
        .catch(() => { if (!signal.aborted) log('Slack delivery pass failed. Pending updates will be retried.'); })
        .finally(() => { draining = undefined; });
    }
  }

  function schedule(): void {
    if (signal.aborted) return;
    active = tick().finally(() => {
      if (!signal.aborted) timer = setTimeout(schedule, deps.pollMs ?? 1_000);
    });
  }

  schedule();

  return {
    stop() {
      stopped ??= (async () => {
        controller.abort();
        clearTimeout(timer);
        try {
          await Promise.allSettled([active]);
          await Promise.allSettled([draining, ...Array.from(roles.values(), (entry) => entry.opening)]);
          await Promise.allSettled(Array.from(roles.values(), (entry) => entry.connection?.stop()));
        } finally {
          await release();
        }
      })();
      return stopped;
    },
  };
}
