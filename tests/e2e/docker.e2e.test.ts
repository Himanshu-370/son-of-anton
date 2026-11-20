import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execa } from 'execa';
import { startContainer, runIn, stopContainer, ensureImage } from '../../src/docker/container.js';
import { webKit } from '../../src/kits/web/index.js';
import { KILL_ALL, startApp } from '../../src/kits/web/browser.js';

const IMAGE = 'alpine:3.20';
const slug = `e2e-test-${randomBytes(4).toString('hex')}`;
const name = `anton-${slug}`;
let repo: string | undefined;

describe.skipIf(!process.env.ANTON_E2E)('docker e2e', () => {
  beforeAll(async () => {
    // startContainer mounts <home>/plugins; keep it off the real ~/anton.
    process.env.ANTON_HOME = await mkdtemp(join(tmpdir(), 'anton-e2e-home-'));
  });
  afterAll(async () => {
    await stopContainer(name);
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it('starts container, runIn echo returns "hi", stop removes it', async () => {
    repo = await mkdtemp(join(tmpdir(), 'anton-e2e-'));
    const have = await execa('docker', ['image', 'inspect', IMAGE], { reject: false });
    if (have.exitCode !== 0) await execa('docker', ['pull', IMAGE]);

    const started = await startContainer(slug, repo, IMAGE);
    expect(started).toBe(name);

    const r = await runIn(name, 'echo hi');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hi');

    await stopContainer(name);
    const ps = await execa('docker', ['ps', '-aq', '--filter', `name=^${name}$`]);
    expect(ps.stdout.trim()).toBe('');
  }, 120_000);

  it('kit image has pinned security scanners on PATH', async () => {
    const dockerfile = join(dirname(fileURLToPath(import.meta.url)), '../../src/kits/fallback/Dockerfile');
    const image = await ensureImage({ name: 'fallback', dockerfile });
    const kitSlug = `e2e-scan-${randomBytes(4).toString('hex')}`;
    const kitName = `anton-${kitSlug}`;
    const kitRepo = await mkdtemp(join(tmpdir(), 'anton-e2e-scan-'));
    try {
      await startContainer(kitSlug, kitRepo, image);
      for (const [cmd, re] of [
        ['gitleaks version', /8\.30\.1/],
        ['osv-scanner --version', /2\.7\.1/],
        ['semgrep --version', /1\.186\.0/],
      ] as const) {
        const r = await runIn(kitName, cmd);
        expect(r.exitCode, `${cmd}: ${r.stderr}`).toBe(0);
        expect(r.stdout + r.stderr).toMatch(re);
      }

      // safe.directory: git (and gitleaks) work on the bind-mounted repo despite the owner mismatch.
      expect((await runIn(kitName, 'git config --system --get-all safe.directory')).stdout).toContain('/workspace');
      await execa('git', ['init', '-q', kitRepo]);
      const st = await runIn(kitName, 'git -C /workspace status --porcelain');
      expect(st.exitCode, st.stderr).toBe(0);

      // The plugin store is mounted read-only, and the container carries the mounts label.
      await writeFile(join(process.env.ANTON_HOME!, 'plugins', 'marker'), 'x');
      expect((await runIn(kitName, 'cat /opt/anton/plugins/marker')).stdout).toBe('x');
      expect((await runIn(kitName, 'touch /opt/anton/plugins/new')).exitCode).not.toBe(0);
      const label = await execa('docker', ['inspect', '-f', '{{index .Config.Labels "anton.mounts"}}', kitName]);
      expect(label.stdout.trim()).toBe('2');

      // The image's entry speaks the current protocol (echoes protocolVersion 3), no API needed.
      await writeFile(join(kitRepo, 'bad-request.json'), '{"role": 1}');
      const ev = await runIn(kitName, 'node /opt/anton/entry.js /workspace/bad-request.json');
      expect(JSON.parse(ev.stdout.trim().split('\n').at(-1)!)).toMatchObject({ type: 'error', protocolVersion: 3 });
    } finally {
      await stopContainer(kitName);
      await rm(kitRepo, { recursive: true, force: true });
    }
  }, 300_000);

  it('web image can launch chromium', async () => {
    const image = await ensureImage(webKit);
    const webSlug = `e2e-web-${randomBytes(4).toString('hex')}`;
    const webName = `anton-${webSlug}`;
    const webRepo = await mkdtemp(join(tmpdir(), 'anton-e2e-web-'));
    try {
      await startContainer(webSlug, webRepo, image);
      const r = await runIn(webName, `node -e "require('playwright').chromium.launch().then(b=>b.close())"`);
      expect(r.exitCode, r.stderr).toBe(0);
    } finally {
      await stopContainer(webName);
      await rm(webRepo, { recursive: true, force: true });
    }
  }, 300_000);

  it('web image serves a page, screenshots it, and stops the app', async () => {
    const image = await ensureImage(webKit);
    const webSlug = `e2e-app-${randomBytes(4).toString('hex')}`;
    const webName = `anton-${webSlug}`;
    const webRepo = await mkdtemp(join(tmpdir(), 'anton-e2e-app-'));
    const url = 'http://localhost:8080/';
    try {
      await writeFile(join(webRepo, 'index.html'), '<!doctype html><title>t</title><h1>Hello</h1>');
      await startContainer(webSlug, webRepo, image);

      // Real lifecycle: setsid + background must survive docker exec, and curl must exist in the image.
      const ready = await startApp(runIn, webName, 'python3 -m http.server 8080', url, '/tmp/app.log', (ms) => new Promise((r) => setTimeout(r, ms)));
      expect(ready, (await runIn(webName, 'cat /tmp/app.log')).stdout).toBe(true);

      const script = `require('playwright').chromium.launch().then(async b=>{const p=await b.newPage();await p.goto('${url}');await p.screenshot({path:'/tmp/shot.png'});await b.close()})`;
      const shot = await runIn(webName, `node -e "${script}"`);
      expect(shot.exitCode, shot.stderr).toBe(0);
      expect((await runIn(webName, 'test -s /tmp/shot.png')).exitCode).toBe(0);

      // A stray background writer in its own session (outside the app's group) must die too.
      await runIn(webName, 'setsid sh -c "while :; do sleep 1; done" >/dev/null 2>&1 &');
      expect((await runIn(webName, 'command -v pgrep')).exitCode, 'pgrep missing: the assertions below would pass vacuously').toBe(0);
      expect((await runIn(webName, "pgrep -f '[w]hile :'")).exitCode).toBe(0);
      await runIn(webName, KILL_ALL);
      expect((await runIn(webName, `curl -fsS --max-time 2 -o /dev/null ${url}`)).exitCode).not.toBe(0);
      expect((await runIn(webName, "pgrep -f '[h]ttp.server'")).exitCode).not.toBe(0);
      expect((await runIn(webName, "pgrep -f '[w]hile :'")).exitCode).not.toBe(0);
      // Only PID 1 (sleep infinity) and this exec's own processes are left; zombies don't count.
      const ps = await runIn(webName, "ps -eo pid=,stat=,args= | awk '$1 != 1 && $2 !~ /^Z/'");
      expect(ps.stdout.trim().split('\n').filter((l) => !/ps -eo|awk|sh -lc/.test(l))).toEqual([]);

      // serve that exits at once fails fast, even though its exited process lingers as a zombie.
      const t0 = Date.now();
      expect(await startApp(runIn, webName, 'false', url, '/tmp/app2.log', (ms) => new Promise((r) => setTimeout(r, ms)))).toBe(false);
      expect(Date.now() - t0).toBeLessThan(15_000);
    } finally {
      await stopContainer(webName);
      await rm(webRepo, { recursive: true, force: true });
    }
  }, 300_000);
});
