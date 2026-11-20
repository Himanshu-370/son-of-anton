import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CliDeps } from '../../src/cli/deps.js';
import { pluginsAddCommand, pluginsListCommand } from '../../src/cli/commands/plugins.js';
import { fakeClone, marketplace } from '../plugins/fixture.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-cli-plugins-'));
  process.env.ANTON_HOME = home;
});

function harness(extra: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = { out: (s) => out.push(s), err: (s) => err.push(s), ...extra };
  return { deps, text: () => out.join('\n'), errText: () => err.join('\n') };
}

describe('anton plugins', () => {
  it('add prints the locked entry and a config snippet', async () => {
    const h = harness({ cloneShallow: fakeClone({ 'https://github.com/acme/mkt.git': await marketplace('cave') }) });
    expect(await pluginsAddCommand('cave@acme/mkt', h.deps)).toBe(0);
    expect(h.text()).toMatch(/Installed cave 1\.0\.0 from acme\/mkt at [0-9a-f]{12}/);
    expect(h.text()).toContain('config.yaml');
    expect(h.text()).toContain('build: [cave]');
  });

  it('add with a bad specifier exits 1', async () => {
    const h = harness();
    expect(await pluginsAddCommand('nope', h.deps)).toBe(1);
    expect(h.errText()).toContain('Use <plugin>@<owner>/<repo> or <plugin>@<git url>');
  });

  it('list marks read-only roles and missing plugins', async () => {
    const h = harness({ cloneShallow: fakeClone({ 'https://github.com/acme/mkt.git': await marketplace('cave') }) });
    expect(await pluginsAddCommand('cave@acme/mkt', h.deps)).toBe(0);
    await writeFile(join(home, 'config.yaml'), [
      'stages:', '  build: [cave, ghost:skill]',
      'kits:', '  web: [cave:hello]',
      'roles:', '  frontend: [cave]', '  security_reviewer: [cave]', '',
    ].join('\n'));
    const l = harness();
    expect(await pluginsListCommand(l.deps)).toBe(0);
    const t = l.text();
    expect(t).toMatch(/cave\s+1\.0\.0\s+acme\/mkt\s+[0-9a-f]{12}/);
    expect(t).toContain('stage build: cave, ghost:skill (NOT INSTALLED)');
    expect(t).toContain('kit web: cave:hello');
    expect(t).toContain('role frontend: cave');
    expect(t).toContain('role security_reviewer: cave (ignored: read-only role)');
  });

  it('list with nothing installed or configured', async () => {
    const l = harness();
    expect(await pluginsListCommand(l.deps)).toBe(0);
    expect(l.text()).toContain('No plugins installed');
  });
});
