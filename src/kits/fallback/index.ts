import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIn as dockerRunIn } from '../../docker/container.js';
import { trimOutput } from '../../core/trim.js';
import { mapJUnit } from '../../verify/junit.js';
import type { CheckResult, Kit, VerifyContext } from '../types.js';

type RunIn = (name: string, cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function buildReport(results: CheckResult[], fullPath?: string): string {
  const failing = results.filter((r) => r.status === 'fail');
  if (failing.length === 0) return '';
  return failing
    .map((r) => {
      const lines = [`### ${r.id} — ${r.reason ?? 'failing'}`];
      if (r.tests.length) lines.push('Tests:', ...r.tests.map((t) => `- ${t}`));
      if (r.error) lines.push('', 'First error:', '```', trimOutput(r.error, { fullPath }), '```');
      return lines.join('\n');
    })
    .join('\n\n');
}

async function verify(ctx: VerifyContext, deps: { runIn?: RunIn } = {}) {
  const runIn: RunIn = deps.runIn ?? ((n, c) => dockerRunIn(n, c));
  const evidenceDir = join(ctx.jobDir, 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const outPath = join(evidenceDir, 'test-output.txt');
  const junit = `/workspace/.anton/jobs/${basename(ctx.jobDir)}/evidence/junit.xml`;

  const install = await runIn(ctx.container, ctx.commands.install);
  if (install.exitCode !== 0) {
    const output = `${install.stdout}\n${install.stderr}`.trim();
    await writeFile(outPath, output);
    const error = trimOutput(output, { fullPath: outPath });
    const results: CheckResult[] = ctx.checks.map((c) => ({
      id: c.id, status: 'fail', reason: 'run_failed', tests: [], error,
    }));
    return { results, runOk: false, failureReport: buildReport(results, outPath) };
  }

  const test = await runIn(ctx.container, `ANTON_JUNIT=${junit} ${ctx.commands.test}`);
  await writeFile(outPath, `${test.stdout}\n${test.stderr}`);
  const xml = await runIn(ctx.container, `cat ${junit}`);
  const results = mapJUnit(xml.exitCode === 0 ? xml.stdout : '', ctx.checks);

  let runOk = true;
  if (ctx.commands.run) {
    const r = await runIn(ctx.container, `timeout 10 sh -c ${shq(ctx.commands.run)}`);
    runOk = r.exitCode === 0 || r.exitCode === 124;
  }
  return { results, runOk, failureReport: buildReport(results, outPath) };
}

export const fallbackKit: Kit & { verify: typeof verify } = {
  name: 'fallback',
  dockerfile: fileURLToPath(new URL('./Dockerfile', import.meta.url)),
  detect: () => 0.1,
  verify,
};
