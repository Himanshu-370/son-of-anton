import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIn as dockerRunIn } from '../../docker/container.js';
import { trimOutput } from '../../core/trim.js';
import { isValidJUnit, mapJUnit, passingTests } from '../../verify/junit.js';
import type { BaselineContext, CheckResult, Kit, VerifyContext } from '../types.js';

type RunIn = (name: string, cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

type RunFailure = { exitCode: number; output: string };

function buildReport(
  results: CheckResult[],
  fullPath?: string,
  extra: { testNote?: string; runFailure?: RunFailure } = {},
): string {
  const failing = results.filter((r) => r.status === 'fail');
  const sections: string[] = [];
  if (extra.testNote && failing.length) sections.push(extra.testNote);
  sections.push(
    ...failing
    .map((r) => {
      const lines = [`### ${r.id} — ${r.reason ?? 'failing'}`];
      if (r.tests.length) lines.push('Tests:', ...r.tests.map((t) => `- ${t}`));
      if (r.error) lines.push('', 'First error:', '```', trimOutput(r.error, { fullPath }), '```');
      return lines.join('\n');
    }),
  );
  if (extra.runFailure) {
    sections.push(
      `### Run failed\nExit code: ${extra.runFailure.exitCode}\n\`\`\`\n${trimOutput(extra.runFailure.output)}\n\`\`\``,
    );
  }
  return sections.join('\n\n');
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

  await runIn(ctx.container, `rm -f ${shq(junit)}`);
  const test = await runIn(ctx.container, `export ANTON_JUNIT=${shq(junit)}; ${ctx.commands.test}`);
  const testOutput = `${test.stdout}\n${test.stderr}`;
  await writeFile(outPath, testOutput);
  const xml = await runIn(ctx.container, `cat ${shq(junit)}`);
  const xmlText = xml.exitCode === 0 ? xml.stdout : '';
  let results = mapJUnit(xmlText, ctx.checks);
  let testNote: string | undefined;
  if (!xmlText.trim() || !isValidJUnit(xmlText)) {
    const error = trimOutput(testOutput.trim(), { fullPath: outPath });
    results = results.map((r) => ({ ...r, error }));
    testNote = `Test command exited ${test.exitCode} and produced no valid JUnit XML.`;
  }

  let runOk = true;
  let runFailure: RunFailure | undefined;
  if (ctx.commands.run) {
    const r = await runIn(ctx.container, `timeout 10 sh -c ${shq(ctx.commands.run)}`);
    runOk = r.exitCode === 0 || r.exitCode === 124;
    if (!runOk) runFailure = { exitCode: r.exitCode, output: `${r.stdout}\n${r.stderr}`.trim() };
  }
  return { results, runOk, failureReport: buildReport(results, outPath, { testNote, runFailure }) };
}

async function baseline(ctx: BaselineContext, deps: { runIn?: RunIn } = {}) {
  const runIn: RunIn = deps.runIn ?? ((n, c) => dockerRunIn(n, c));
  // Separate file so the baseline never collides with verify's junit.xml.
  const junit = `/workspace/.anton/jobs/${basename(ctx.jobDir)}/evidence/baseline-junit.xml`;
  await mkdir(join(ctx.jobDir, 'evidence'), { recursive: true });
  if ((await runIn(ctx.container, ctx.commands.install)).exitCode !== 0) return { passingTests: [], ran: false };
  await runIn(ctx.container, `rm -f ${shq(junit)}`);
  await runIn(ctx.container, `export ANTON_JUNIT=${shq(junit)}; ${ctx.commands.test}`);
  const xml = await runIn(ctx.container, `cat ${shq(junit)}`);
  if (xml.exitCode !== 0 || !isValidJUnit(xml.stdout)) return { passingTests: [], ran: false };
  return { passingTests: passingTests(xml.stdout), ran: true };
}

export const fallbackKit: Kit & { verify: typeof verify; baseline: typeof baseline } = {
  name: 'fallback',
  dockerfile: fileURLToPath(new URL('../../../src/kits/fallback/Dockerfile', import.meta.url)),
  detect: () => 0.1,
  verify,
  baseline,
};
