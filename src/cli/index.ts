#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { CliDeps } from './deps.js';
import { abandonCommand } from './commands/abandon.js';
import { acceptRiskCommand } from './commands/accept-risk.js';
import { adoptCommand } from './commands/adopt.js';
import { approveCommand } from './commands/approve.js';
import { benchCommand, type BenchOpts } from './commands/bench.js';
import { changeCommand } from './commands/change.js';
import { lessonsListCommand, lessonsRemoveCommand, lessonsReviewCommand } from './commands/lessons.js';
import { logsCommand } from './commands/logs.js';
import { newCommand } from './commands/new.js';
import { rejectCommand } from './commands/reject.js';
import { resumeCommand } from './commands/resume.js';
import { pluginsAddCommand, pluginsListCommand, pluginsUpdateCommand } from './commands/plugins.js';
import { secretsEditCommand } from './commands/secrets.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { stopCommand } from './commands/stop.js';

export function buildProgram(deps: CliDeps = {}): Command {
  const program = new Command('anton').description('Son of Anton: describe it, approve it, get working software.');
  const exit = (code: number) => {
    process.exitCode = code;
  };

  const slack = program.command('slack').description('Set up and manage the Slack dev team');
  slack.command('setup').description('Set up the workspace and nine role bots')
    .action(async () => exit(await (await import('./commands/slack.js')).slackSetupCommand({ out: deps.out, err: deps.err })));
  slack.command('outbox').description('Show pending and blocked Slack updates')
    .action(async () => exit(await (await import('./commands/serve.js')).slackOutboxStatusCommand(deps)));
  slack.command('resolve').description('Resolve an update flagged by the Slack outbox')
    .argument('<action>', 'retry, recheck, discard, bind-channel or confirm-thread').argument('<id>')
    .option('--channel-id <id>', 'existing private project channel for bind-channel')
    .option('--timestamp <ts>', 'existing parent message timestamp for confirm-thread')
    .action(async (action: string, id: string, options: { channelId?: string; timestamp?: string }) => {
      exit(await (await import('./commands/serve.js')).slackOutboxResolveCommand(action, id, options, deps));
    });
  slack.command('share-screenshot').description('Share a reviewed QA screenshot in its Slack job thread')
    .argument('<project>').argument('<check-id>')
    .action(async (project: string, checkId: string) => {
      exit(await (await import('./commands/slack-screenshot.js')).shareScreenshotCommand(project, checkId, deps));
    });
  const service = slack.command('service').description('Manage Slack launch at login on macOS');
  for (const action of ['install', 'status', 'uninstall'] as const) {
    service.command(action).description(`${action} the Slack LaunchAgent`)
      .action(async () => exit(await (await import('../slack/launch-agent.js')).slackServiceCommand(action, { out: deps.out, err: deps.err, exec: deps.exec })));
  }
  program.command('serve').description('Run the Slack dev team in the foreground')
    .action(async () => exit(await (await import('./commands/serve.js')).serveCommand(deps)));

  program
    .command('new')
    .description('Create a new project and write its spec interactively')
    .argument('<description>', 'what to build')
    .option('--budget <usd>', 'spend cap for this job in USD')
    .action(async (desc: string, o: { budget?: string }) => exit(await newCommand(desc, o, deps)));
  program
    .command('adopt')
    .description('Register an existing git repository as a project')
    .argument('<path>', 'the repository root')
    .option('--name <name>', 'project name (default: the folder name)')
    .action(async (p: string, o: { name?: string }) => exit(await adoptCommand(p, o, deps)));
  program
    .command('change')
    .description('Start a change on an adopted project and write its spec interactively')
    .argument('<project>')
    .argument('<description>', 'what to change')
    .option('--budget <usd>', 'spend cap for this job in USD')
    .action(async (p: string, desc: string, o: { budget?: string }) => exit(await changeCommand(p, desc, o, deps)));
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
    .command('secrets')
    .description("Manage a project's secrets (passed to the job container as env vars only)")
    .command('edit')
    .description("Create and open a project's secrets file")
    .argument('<project>')
    .action(async (p: string) => exit(await secretsEditCommand(p, deps)));
  const plugins = program.command('plugins').description('Install and inspect pinned plugins (~/anton/plugins.lock)');
  plugins
    .command('add')
    .description('Install a plugin from a marketplace repo and pin it')
    .argument('<specifier>', '<plugin>@<owner>/<repo> or <plugin>@<https git url>')
    .action(async (s: string) => exit(await pluginsAddCommand(s, deps)));
  plugins
    .command('list')
    .description('Show installed plugins and what each stage, kit and role loads')
    .action(async () => exit(await pluginsListCommand(deps)));
  plugins
    .command('update')
    .description('Stage the newest version, have a read-only reviewer check what changed, and re-pin on your yes')
    .argument('[name]', 'plugin to update (default: every installed plugin)')
    .action(async (n: string | undefined) => exit(await pluginsUpdateCommand(n, deps)));
  const lessons = program.command('lessons').description('Review and manage lessons agents learn from (~/anton/lessons)');
  lessons
    .command('review')
    .description('Collect finished Retros, then accept, edit, reject or skip each proposal')
    .action(async () => exit(await lessonsReviewCommand(deps)));
  lessons
    .command('list')
    .description('Show each lessons file with its lessons')
    .option('--stats', 'show recent runs, the cache trend and per-lesson with/without numbers')
    .action(async (o: { stats?: boolean }) => exit(await lessonsListCommand(deps, { stats: o.stats })));
  lessons
    .command('remove')
    .description('Remove a lesson by id')
    .argument('<id>')
    .action(async (id: string) => exit(await lessonsRemoveCommand(id, deps)));
  program
    .command('bench')
    .description('Run practice projects and measure cost and quality')
    .option('--init', 'install the bundled practice samples')
    .option('--only <samples>', 'run these comma-separated sample names')
    .option('--label <text>', 'label the run')
    .option('--compare <runId>', 'compare against this earlier run')
    .option('--yes', 'run without asking for confirmation')
    .action(async (opts: BenchOpts) => exit(await benchCommand(opts, deps)));
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
