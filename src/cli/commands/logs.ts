import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { isRunning } from '../../core/lock.js';
import { loadState, type JobState } from '../../core/state.js';
import { guard, resolveDeps, resolveJob, type CliDeps } from '../deps.js';

const POLL_MS = 500;
/** Stop following once no run has held the lock for this many polls. */
const IDLE_POLLS = 4;

const exists = (p: string) => fsp.stat(p).then(() => true, () => false);

/** The current stage's agent log; stages without one (verify, deliver) fall back to runner.log. */
async function logFile(jobDir: string, s: JobState): Promise<string> {
  const stage = s.stage === 'paused' && s.pausedFrom ? s.pausedFrom : s.stage;
  const stageLog = join(jobDir, 'logs', `${stage}.log`);
  return (await exists(stageLog)) ? stageLog : join(jobDir, 'logs', 'runner.log');
}

async function readFrom(path: string, offset: number): Promise<{ text: string; offset: number }> {
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(path, 'r');
  } catch {
    return { text: '', offset };
  }
  try {
    const { size } = await fh.stat();
    if (size <= offset) return { text: '', offset: size < offset ? 0 : offset };
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    return { text: buf.toString('utf8'), offset: size };
  } finally {
    await fh.close();
  }
}

/** `anton logs [-f] <project>`: print (and with -f, follow) the current stage's log. */
export async function logsCommand(project: string, opts: { follow?: boolean }, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const job = await resolveJob(project);
    let file = await logFile(job.jobDir, job.state);
    let offset = 0;
    let pending = '';
    let idle = 0;
    d.out(`==> ${file} <==`);
    for (;;) {
      const r = await readFrom(file, offset);
      offset = r.offset;
      const lines = (pending + r.text).split('\n');
      pending = lines.pop() ?? '';
      for (const l of lines) d.out(l);
      if (!opts.follow) break;
      idle = (await isRunning(job.repo)).running ? 0 : idle + 1;
      if (idle >= IDLE_POLLS) break;
      const next = await logFile(job.jobDir, await loadState(job.jobDir));
      if (next !== file) {
        if (pending) d.out(pending);
        pending = '';
        file = next;
        // Stage logs accumulate across rounds: follow only what the new stage appends.
        offset = await fsp.stat(file).then((st) => st.size, () => 0);
        d.out(`==> ${file} <==`);
      }
      await d.sleep(POLL_MS);
    }
    if (pending) d.out(pending);
    return 0;
  });
}
