// Runs one CLI decision in its own process for tests/cli/action-concurrency.test.ts.
// argv: <approve|reject|resume> <project> <spawn-log>
import { appendFileSync } from 'node:fs';
import { approveCommand } from '../../../src/cli/commands/approve.js';
import { rejectCommand } from '../../../src/cli/commands/reject.js';
import { resumeCommand } from '../../../src/cli/commands/resume.js';
import type { CliDeps } from '../../../src/cli/deps.js';

const [action, project, log] = process.argv.slice(2) as [string, string, string];
const deps: CliDeps = {
  out: (l) => console.log(l),
  err: (l) => console.log(l),
  preflight: async () => undefined,
  spawnRun: (name) => appendFileSync(log, `${name}\n`),
  stopContainer: async () => undefined,
  retro: { env: {} },
};
const code = action === 'approve' ? await approveCommand(project, deps)
  : action === 'reject' ? await rejectCommand(project, { notes: 'from child' }, deps)
  : await resumeCommand(project, {}, deps);
console.log(`EXIT ${code}`);
