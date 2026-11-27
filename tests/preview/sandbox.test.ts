import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupAll, expirePreviews, openFolder, PREVIEW_LIFETIME_MS, previewName, runPreview, stopPreview, type PreviewDeps,
} from '../../src/preview/sandbox.js';

let home: string;
let calls: string[][];
let clock: number;
const repo = '/Users/me/projects/hello';

function deps(over: Partial<PreviewDeps> & { fail?: (args: string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined } = {}): PreviewDeps {
  const { fail, ...rest } = over;
  return {
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      const r = fail?.([cmd, ...args]);
      return { exitCode: r?.exitCode ?? 0, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
    },
    image: async () => 'anton/kit-web:test',
    envFile: async () => '/tmp/secrets.env',
    secrets: async () => ({ TOKEN: 'fake-secret-value-0001' }),
    portFree: async () => true,
    freePort: async () => 49152,
    reachable: async () => true,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    home,
    ...rest,
  };
}
const web = { install: 'npm ci', serve: 'npm start', url: 'http://localhost:3000/' };
const cli = { install: 'npm ci', run: 'node bin/hello.js', test: 'npm test' };
const input = (commands: object) => ({ project: 'hello', jobId: '1-init', revision: 'delivered-1', repoPath: repo, kit: 'web' as const, commands: commands as never });
const runs = async () => JSON.parse(await readFile(join(home, 'previews.json'), 'utf8')).runs as unknown[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-preview-'));
  calls = [];
  clock = 1_000_000;
});

describe('sandbox runs', () => {
  it('web run starts a sandbox and opens the browser', async () => {
    const r = await runPreview(input(web), deps());
    const run = calls.find((c) => c[1] === 'run')!;
    expect(run).toEqual(expect.arrayContaining(['--name', 'anton-preview-hello', '-p', '127.0.0.1:3000:3000', '--env-file', '-v', `${repo}:/workspace`]));
    expect(run.join(' ')).not.toMatch(/ANTHROPIC_API_KEY|plugins/);
    expect(calls).toContainEqual(['docker', 'exec', 'anton-preview-hello', 'sh', '-lc', 'npm ci']);
    expect(calls).toContainEqual(['docker', 'exec', '-d', 'anton-preview-hello', 'sh', '-lc', 'npm start']);
    expect(calls.at(-1)).toEqual(['open', 'http://localhost:3000/']);
    expect(r).toEqual({ ok: true, lines: ['Running at http://localhost:3000/. It stops in 30 minutes, or press Stop.'] });
    expect(await runs()).toHaveLength(1);
  });

  it('prints the CLI hint inside the sandbox without putting it in the host script', async () => {
    const runCommand = 'echo "$(touch /tmp/marker)"' + String.fromCharCode(27) + '[2J';
    const r = await runPreview(input({ ...cli, run: runCommand }), deps());
    const osa = calls.find((c) => c[0] === 'osascript')!;
    expect(osa.join(' ')).toContain('docker exec -it anton-preview-hello sh -c');
    expect(osa.join(' ')).toContain('ANTON_PREVIEW_HINT');
    expect(osa.join(' ')).not.toContain('touch /tmp/marker');
    expect(osa.join(' ')).not.toContain('node bin/hello.js'); // untrusted text never reaches the host script
    const dockerRun = calls.find((c) => c[1] === 'run')!;
    expect(dockerRun).not.toContain('-p');
    expect(dockerRun).toContain('ANTON_PREVIEW_HINT=You are inside the sandbox in the project folder. Try: echo "$(touch /tmp/marker)" [2J');
    expect(r).toEqual({ ok: true, lines: ['A Terminal window opened inside the sandbox.'] });
  });

  it('run replaces an earlier run', async () => {
    await runPreview(input(cli), deps());
    calls = [];
    await runPreview(input(cli), deps());
    const rm = calls.findIndex((c) => c.join(' ') === 'docker rm -f anton-preview-hello');
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(calls.findIndex((c) => c[1] === 'run'));
    expect(await runs()).toHaveLength(1);
  });

  it('uses a free port when the app port is busy', async () => {
    const r = await runPreview(input(web), deps({ portFree: async () => false }));
    expect(calls.find((c) => c[1] === 'run')).toContain('127.0.0.1:49152:3000');
    expect(r.lines[0]).toContain('http://localhost:49152/');
  });

  it('install failure removes the container and shows redacted last lines', async () => {
    const out = Array.from({ length: 30 }, (_, i) => `line ${i} fake-secret-value-0001`).join('\n');
    const r = await runPreview(input(cli), deps({ fail: (a) => (a.includes('npm ci') ? { exitCode: 1, stdout: out } : undefined) }));
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toBe('Install failed. Last lines:');
    expect(r.lines).toHaveLength(21);
    expect(r.lines.join('\n')).not.toContain('fake-secret-value-0001');
    expect(calls.filter((c) => c.join(' ') === 'docker rm -f anton-preview-hello')).toHaveLength(2);
  });

  it('says so when the web app does not answer', async () => {
    const r = await runPreview(input(web), deps({ reachable: async () => false }));
    expect(r).toEqual({ ok: false, lines: [expect.stringMatching(/^The app did not answer within 60 seconds/)] });
    expect(calls.some((c) => c[0] === 'open')).toBe(false);
    expect(await runs()).toHaveLength(1); // Stop can still remove it
  });

  it.each([
    { commands: web, opener: 'open', message: 'Could not open the browser.' },
    { commands: cli, opener: 'osascript', message: 'Could not open Terminal.' },
  ])('reports a failed $opener and keeps the sandbox available to stop', async ({ commands, opener, message }) => {
    const d = deps({ fail: ([cmd]) => cmd === opener ? { exitCode: 1 } : undefined });
    const r = await runPreview(input(commands), d);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toContain(message);
    expect(await stopPreview('hello', d)).toBe(true);
  });

  it('keeps the preview recorded if Docker fails to stop it', async () => {
    await runPreview(input(cli), deps());
    const blocked = deps({ fail: ([, sub]) => sub === 'rm' ? { exitCode: 1, stderr: 'permission denied' } : undefined });
    await expect(stopPreview('hello', blocked)).rejects.toThrow('Could not remove');
    expect(await runs()).toHaveLength(1);
    expect(await stopPreview('hello', deps())).toBe(true);
  });

  it('refuses an invalid container name and a plan with nothing to run', async () => {
    expect(() => previewName('Bad Name!')).toThrow();
    expect(await runPreview(input({ install: 'npm ci' }), deps())).toEqual({ ok: false, lines: ['Nothing to run for this project.'] });
    expect(calls).toEqual([]);
  });
});

describe('stopping and cleanup', () => {
  it('stop removes the run, and says when nothing runs', async () => {
    await runPreview(input(cli), deps());
    expect(await stopPreview('hello', deps())).toBe(true);
    expect(await runs()).toEqual([]);
    expect(await stopPreview('hello', deps())).toBe(false);
  });

  it('expire removes old and out-of-date runs and keeps fresh current ones', async () => {
    await runPreview({ ...input(cli), project: 'old' }, deps());
    clock += PREVIEW_LIFETIME_MS;
    await runPreview({ ...input(cli), project: 'moved' }, deps());
    await runPreview({ ...input(cli), project: 'fresh' }, deps());
    const gone = await expirePreviews(async (r) => r.project !== 'moved', deps());
    expect(gone.map((r) => r.project).sort()).toEqual(['moved', 'old']);
    expect((await runs()).map((r) => (r as { project: string }).project)).toEqual(['fresh']);
  });

  it('cleanupAll removes recorded runs', async () => {
    await runPreview(input(cli), deps());
    calls = [];
    await cleanupAll(deps());
    expect(calls).toEqual([['docker', 'rm', '-f', 'anton-preview-hello']]);
    expect(await runs()).toEqual([]);
  });

  it('openFolder falls back to Finder', async () => {
    expect(await openFolder(repo, deps())).toBe('vscode');
    calls = [];
    expect(await openFolder(repo, deps({ fail: (a) => (a.includes('-a') ? { exitCode: 1 } : undefined) }))).toBe('finder');
    expect(calls).toEqual([['open', '-a', 'Visual Studio Code', repo], ['open', repo]]);
  });
});
