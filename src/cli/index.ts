#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { CliDeps } from './deps.js';
import { abandonCommand } from './commands/abandon.js';
import { acceptRiskCommand } from './commands/accept-risk.js';
import { approveCommand } from './commands/approve.js';
import { logsCommand } from './commands/logs.js';
import { newCommand } from './commands/new.js';
import { rejectCommand } from './commands/reject.js';
import { resumeCommand } from './commands/resume.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';

export function buildProgram(deps: CliDeps = {}): Command {
  const program = new Command('anton').description('Son of Anton: describe it, approve it, get working software.');
  const exit = (code: number) => {
    process.exitCode = code;
  };

  program
    .command('new')
    .description('Create a new project and write its spec interactively')
    .argument('<description>', 'what to build')
    .option('--budget <usd>', 'spend cap for this job in USD')
    .action(async (desc: string, o: { budget?: string }) => exit(await newCommand(desc, o, deps)));
  program
    .command('approve')
    .description('Approve the spec (starts the build) or the final delivery')
    .argument('<project>')
    .action(async (p: string) => exit(await approveCommand(p, deps)));
  program
    .command('reject')
    .description('Reject the delivery and send it back to build with notes')
    .argument('<project>')
    .requiredOption('--notes <text>', 'what to change')
    .action(async (p: string, o: { notes: string }) => exit(await rejectCommand(p, o, deps)));
  program
    .command('resume')
    .description('Continue a paused or interrupted job')
    .argument('<project>')
    .option('--budget <usd>', 'new total spend cap in USD (required after a budget cap)')
    .option('--accept-as-is', 'deliver what was built even though checks fail')
    .action(async (p: string, o: { budget?: string; acceptAsIs?: boolean }) => exit(await resumeCommand(p, o, deps)));
  program
    .command('accept-risk')
    .description('Accept a security finding so it no longer blocks delivery')
    .argument('<project>')
    .argument('<findingId>')
    .requiredOption('--reason <text>', 'why the risk is acceptable')
    .action(async (p: string, id: string, o: { reason: string }) => exit(await acceptRiskCommand(p, id, o, deps)));
  program
    .command('abandon')
    .description('Abandon the current job and stop its container')
    .argument('<project>')
    .action(async (p: string) => exit(await abandonCommand(p, deps)));
  program
    .command('stop')
    .description('Stop a running job (graceful, then forced after 10s)')
    .argument('<project>')
    .action(async (p: string) => exit(await stopCommand(p, deps)));
  program
    .command('status')
    .description('Show stage, round, spend and pause reason for projects')
    .argument('[project]')
    .action(async (p: string | undefined) => exit(await statusCommand(p, deps)));
  program
    .command('logs')
    .description("Show the current stage's log")
    .argument('<project>')
    .option('-f, --follow', 'keep following the log')
    .action(async (p: string, o: { follow?: boolean }) => exit(await logsCommand(p, o, deps)));
  program
    .command('_run', { hidden: true })
    .argument('<project>')
    .action(async (p: string) => exit(await runCommand(p, deps)));
  return program;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) await buildProgram().parseAsync(process.argv);
