import { beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecFn } from '../../src/core/exec.js';
import {
  preflight,
  PreflightError,
  ensureImage,
  startContainer,
  stopContainer,
  runIn,
} from '../../src/docker/container.js';

type Call = { cmd: string; args: string[] };
const ok = { exitCode: 0, stdout: '', stderr: '' };
function fake(handler?: (c: Call) => Partial<typeof ok>) {
  const calls: Call[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return { ...ok, ...(handler?.({ cmd, args }) ?? {}) };
  };
  return { exec, calls };
}

describe('preflight', () => {
  it('preflight throws Docker message when docker info exits 1', async () => {
    const { exec } = fake(() => ({ exitCode: 1 }));
    const p = preflight(exec, { ANTHROPIC_API_KEY: 'k' });
    await expect(p).rejects.toBeInstanceOf(PreflightError);
    await expect(p).rejects.toThrow("Docker isn't running. Start Docker Desktop and try again.");
  });

  it('preflight throws API key message when env missing', async () => {
    const { exec } = fake();
    await expect(preflight(exec, {})).rejects.toThrow('ANTHROPIC_API_KEY is not set.');
  });

  it('preflight passes when docker and key are present', async () => {
    const { exec, calls } = fake();
    await preflight(exec, { ANTHROPIC_API_KEY: 'k' });
    expect(calls[0]).toEqual({ cmd: 'docker', args: ['info'] });
  });
});

const AGENT = { 'entry.js': 'e', 'pricing.js': 'p', 'protocol.js': 'v' };

async function makeKit(stageFiles: Record<string, string> | null = { ...AGENT, 'sub/x.json': '{}' }) {
  const dir = await mkdtemp(join(tmpdir(), 'anton-kit-'));
  await writeFile(join(dir, 'Dockerfile'), 'FROM scratch\n');
  if (stageFiles) {
    for (const [rel, body] of Object.entries(stageFiles)) {
      await mkdir(dirname(join(dir, '.stage', rel)), { recursive: true });
      await writeFile(join(dir, '.stage', rel), body);
    }
  }
  // The compiled agent files the staged copies must match (stands in for dist/agent).
  const agentDir = join(dir, 'dist-agent');
  await mkdir(agentDir);
  for (const [f, body] of Object.entries(AGENT)) await writeFile(join(agentDir, f), body);
  return { dir, dockerfile: join(dir, 'Dockerfile'), agentDir };
}

describe('ensureImage', () => {
  it('skips build when image exists and returns a versioned, content-hashed tag', async () => {
    const kit = await makeKit();
    const { exec, calls } = fake();
    const tag = await ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir });
    expect(tag).toMatch(/^anton\/kit-node:\d+\.\d+\.\d+-[0-9a-f]{12}$/);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['image', 'inspect', tag]);
  });

  it('tag hash changes when a staged file or the Dockerfile changes, and is stable otherwise', async () => {
    const kit = await makeKit();
    const { exec } = fake();
    const t1 = await ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir });
    expect(await ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir })).toBe(t1);
    await writeFile(join(kit.dir, '.stage', 'sub', 'x.json'), '{"a":1}');
    const t2 = await ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir });
    expect(t2).not.toBe(t1);
    await writeFile(kit.dockerfile, 'FROM scratch\nRUN true\n');
    const t3 = await ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir });
    expect(t3).not.toBe(t2);
  });

  it('throws a clear error when .stage/ is missing', async () => {
    const kit = await makeKit(null);
    const { exec, calls } = fake();
    await expect(ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir })).rejects.toThrow(
      'Kit image files not staged — run: npm run build:image',
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses when a staged agent file differs from the compiled one (stale .stage)', async () => {
    const kit = await makeKit({ ...AGENT, 'entry.js': 'old phase-1 entry' });
    const { exec, calls } = fake();
    await expect(ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir })).rejects.toThrow(
      'Kit image files are out of date — run: npm run build:image',
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses when a staged agent file is missing', async () => {
    const { 'protocol.js': _omit, ...rest } = AGENT;
    const kit = await makeKit(rest);
    const { exec } = fake();
    await expect(ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir })).rejects.toThrow(
      'Kit image files are out of date — run: npm run build:image',
    );
  });

  it('refuses when the compiled agent file is missing', async () => {
    const kit = await makeKit();
    const { exec } = fake();
    await expect(
      ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: join(kit.dir, 'nope') }),
    ).rejects.toThrow('Kit image files are out of date — run: npm run build:image');
  });

  it('builds with -t, -f and the dockerfile dir when missing', async () => {
    const kit = await makeKit();
    const { exec, calls } = fake((c) => (c.args[0] === 'image' ? { exitCode: 1 } : {}));
    const tag = await ensureImage({ name: 'node', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir });
    expect(calls[1].args).toEqual(['build', '-t', tag, '-f', kit.dockerfile, kit.dir]);
  });

  it('throws with trimmed stderr when build fails', async () => {
    const kit = await makeKit();
    const { exec } = fake((c) =>
      c.args[0] === 'image' ? { exitCode: 1 } : { exitCode: 1, stderr: '  boom\n' },
    );
    await expect(ensureImage({ name: 'n', dockerfile: kit.dockerfile }, exec, { agentDir: kit.agentDir })).rejects.toThrow(/boom$/);
  });
});

describe('ensureImage with a base kit', () => {
  async function makeWeb(baseKit: { name: string; dockerfile: string }) {
    const dir = await mkdtemp(join(tmpdir(), 'anton-web-'));
    await writeFile(join(dir, 'Dockerfile'), 'ARG BASE\nFROM ${BASE}\n');
    return { name: 'web', dockerfile: join(dir, 'Dockerfile'), dir, base: baseKit };
  }

  it('ensureImage builds the base first and passes BASE build-arg', async () => {
    const base = await makeKit();
    const web = await makeWeb({ name: 'node', dockerfile: base.dockerfile });
    const { exec, calls } = fake((c) => (c.args[0] === 'image' ? { exitCode: 1 } : {}));
    const tag = await ensureImage(web, exec, { agentDir: base.agentDir });
    const builds = calls.filter((c) => c.args[0] === 'build');
    expect(builds).toHaveLength(2);
    const baseTag = builds[0].args[builds[0].args.indexOf('-t') + 1];
    expect(baseTag).toMatch(/^anton\/kit-node:/);
    expect(builds[1].args).toEqual(['build', '-t', tag, '-f', web.dockerfile, '--build-arg', `BASE=${baseTag}`, web.dir]);
    expect(tag).toMatch(/^anton\/kit-web:\d+\.\d+\.\d+-[0-9a-f]{12}$/);
  });

  it('web tag changes when the base tag changes', async () => {
    const base = await makeKit();
    const web = await makeWeb({ name: 'node', dockerfile: base.dockerfile });
    const { exec } = fake();
    const t1 = await ensureImage(web, exec, { agentDir: base.agentDir });
    await writeFile(join(base.dir, '.stage', 'sub', 'x.json'), '{"a":1}');
    const t2 = await ensureImage(web, exec, { agentDir: base.agentDir });
    expect(t2).not.toBe(t1);
  });
});

describe('startContainer', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'anton-home-'));
    process.env.ANTON_HOME = home;
  });

  it('startContainer mounts the repo read-write and the plugin store read-only, with the mounts label', async () => {
    const { exec, calls } = fake();
    const name = await startContainer('s1', '/repo', 'img:1', exec);
    expect(name).toBe('anton-s1');
    const run = calls.find((c) => c.args[0] === 'run')!;
    expect(run.args).toEqual([
      'run', '-d', '--name', 'anton-s1', '--label', 'anton.mounts=2',
      '-v', '/repo:/workspace', '-v', `${home}/plugins:/opt/anton/plugins:ro`, '-w', '/workspace',
      '-e', 'ANTHROPIC_API_KEY', 'img:1', 'sleep', 'infinity',
    ]);
    // The store folder exists before docker run, so Docker does not create it root-owned.
    expect((await stat(join(home, 'plugins'))).isDirectory()).toBe(true);
  });

  it('startContainer adds --env-file only when given; values never appear in argv', async () => {
    const { exec, calls } = fake();
    await startContainer('s1', '/repo', 'img:1', exec);
    expect(calls.flatMap((c) => c.args)).not.toContain('--env-file');
    const f = fake();
    await startContainer('s1', '/repo', 'img:1', f.exec, { envFile: '/h/secrets/p.env' });
    const run = f.calls.find((c) => c.args[0] === 'run')!;
    expect(run.args[run.args.indexOf('--env-file') + 1]).toBe('/h/secrets/p.env');
    expect(run.args.indexOf('--env-file')).toBeLessThan(run.args.indexOf('img:1'));
  });

  it('removes a pre-existing container before run', async () => {
    const { exec, calls } = fake();
    await startContainer('s1', '/repo', 'img:1', exec);
    expect(calls[0].args).toEqual(['rm', '-f', 'anton-s1']);
    expect(calls[1].args[0]).toBe('run');
  });

  it('startContainer passes the API key by name only', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-secret-value';
    try {
      const { exec, calls } = fake();
      await startContainer('s1', '/repo', 'img:1', exec);
      const args = calls.flatMap((c) => c.args);
      expect(args).toContain('ANTHROPIC_API_KEY');
      expect(args[args.indexOf('ANTHROPIC_API_KEY') - 1]).toBe('-e');
      expect(args.join(' ')).not.toContain('sk-secret-value');
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('throws when docker run fails', async () => {
    const { exec } = fake((c) => (c.args[0] === 'run' ? { exitCode: 125, stderr: 'nope' } : {}));
    await expect(startContainer('s1', '/repo', 'img', exec)).rejects.toThrow('nope');
  });
});

describe('stopContainer / runIn', () => {
  it('stopContainer swallows errors', async () => {
    const exec: ExecFn = async () => {
      throw new Error('spawn failed');
    };
    await expect(stopContainer('anton-s1', exec)).resolves.toBeUndefined();
  });

  it('stopContainer runs docker rm -f', async () => {
    const { exec, calls } = fake();
    await stopContainer('anton-s1', exec);
    expect(calls[0]).toEqual({ cmd: 'docker', args: ['rm', '-f', 'anton-s1'] });
  });

  it('runIn uses sh -lc', async () => {
    const { exec, calls } = fake(() => ({ stdout: 'hi' }));
    const r = await runIn('anton-s1', 'echo hi', exec);
    expect(r.stdout).toBe('hi');
    expect(calls[0].args).toEqual(['exec', 'anton-s1', 'sh', '-lc', 'echo hi']);
  });
});
