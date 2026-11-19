import { defaultExec, type ExecFn } from './exec.js';

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** macOS notification via osascript; no-op elsewhere; never throws. */
export async function notify(
  title: string,
  message: string,
  exec: ExecFn = defaultExec,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin') return;
  try {
    await exec('osascript', [
      '-e',
      `display notification "${esc(message)}" with title "${esc(title)}"`,
    ]);
  } catch {
    // notifications are best-effort
  }
}
