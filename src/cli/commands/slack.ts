import { createInterface } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import { slackSetupApi } from '../../slack/setup-api.js';
import { slackSetup, type SlackSetupDeps } from '../../slack/setup.js';

export async function promptSlackSetup(
  label: string,
  field: Parameters<SlackSetupDeps['prompt']>[1],
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string | undefined> {
  if (!input.isTTY || !output.isTTY) {
    if (field === 'repair') return undefined;
    output.write('Run anton slack setup in an interactive terminal.\n');
    return undefined;
  }
  const secret = field === 'appToken' || field === 'botToken' || field === 'configToken';
  if (secret) output.write(`${label} (input hidden): `);
  // Keep terminal line editing and raw input for secrets, but give readline no output stream to echo to.
  const rl = createInterface({ input, output: secret ? undefined : output, terminal: true, historySize: 0 });
  try {
    return await new Promise((resolve) => {
      rl.once('close', () => resolve(undefined));
      rl.once('SIGINT', () => rl.close());
      rl.once('error', () => rl.close());
      const accept = (answer: string) => resolve(answer);
      if (secret) rl.once('line', accept);
      else rl.question(`${label}: `, accept);
    });
  } finally {
    rl.close();
    if (secret) output.write('\n');
  }
}

export function slackSetupCommand(deps: Partial<SlackSetupDeps> = {}): Promise<number> {
  return slackSetup({
    home: deps.home,
    api: deps.api ?? slackSetupApi,
    prompt: deps.prompt ?? promptSlackSetup,
    out: deps.out ?? ((message) => console.log(message)),
    err: deps.err ?? ((message) => console.error(message)),
  });
}
