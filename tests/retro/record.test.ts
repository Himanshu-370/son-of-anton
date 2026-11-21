import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunRecord } from '../../src/retro/record.js';
import { RETRO_JSON_SCHEMA, retroPrompt } from '../../src/retro/prompt.js';
import { KIT_LESSON_FILES, LESSON_FILES } from '../../src/lessons/store.js';

let repo: string;
let jobDir: string;
const w = (p: string, s: string) => mkdir(join(jobDir, p, '..'), { recursive: true }).then(() => writeFile(join(jobDir, p), s));
const state = (over: object = {}) => ({
  jobId: 'j1', kind: 'new', project: 'p', stage: 'done', round: 2, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
  stageSpentUsd: {}, warned80: false, completedTasks: [], updatedAt: 'x', ...over,
});
const spec = (over: object = {}) => ({ title: 'T', summary: 's', kit: 'web', ...over });
const build = (secrets?: Record<string, string>) => buildRunRecord({ repo, jobDir, secrets });

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'anton-retro-'));
  jobDir = join(repo, '.anton', 'jobs', 'j1');
  await mkdir(jobDir, { recursive: true });
  await w('state.json', JSON.stringify(state()));
  await w('spec.json', JSON.stringify(spec()));
  await w('spec.approved.json', JSON.stringify(spec()));
});

describe('buildRunRecord', () => {
  it('record has every section in order', async () => {
    const r = await build();
    const heads = [...r.matchAll(/^## .+$/gm)].map((m) => m[0]);
    expect(heads).toEqual([
      '## Job', '## Spec edits at checkpoint 1', '## Failed checks by round', '## Reject notes', '## Reviewer findings',
      '## Questions and assumptions', '## Cost and allowance by stage', '## Tool use by stage',
    ]);
    expect(r).toContain('- Kit: web');
    expect(r).toContain('- Outcome: approved');
    expect(r).toContain('- Rounds: 2');
  });

  it('spec edits list changed fields', async () => {
    await w('spec.approved.json', JSON.stringify(spec({ title: 'Edited' })));
    const r = await build();
    expect(r).toContain('- title');
    expect(r).toContain('"Edited"');
    expect(r).not.toContain('- summary');
  });

  it('reject notes and reviewer findings are included', async () => {
    await w('notes-round-1.md', 'Button is off-centre\n');
    await w('evidence/results-verify-1.json', JSON.stringify({
      results: [{ id: 'AC-1', status: 'fail', reason: 'failing', tests: [], error: 'boom' }], runOk: true,
      review: { findings: [{ severity: 'blocking', file: 'a.ts', summary: 'null deref' }] },
      security: { findings: [{ severity: 'high', file: 'b.ts', title: 'sql injection' }] },
    }));
    const r = await build();
    expect(r).toContain('Button is off-centre');
    expect(r).toContain('AC-1 (failing): boom');
    expect(r).toContain('null deref');
    expect(r).toContain('sql injection');
  });

  it('over-allowance stage is marked', async () => {
    await w('state.json', JSON.stringify(state({ stageSpentUsd: { spec: 3, build: 1 } })));
    const r = await build();
    expect(r).toMatch(/- spec: \$3\.00 spent; cumulative \$3\.00 of \$1\.00 share \(over\)/);
    expect(r).toMatch(/- build: \$1\.00 spent;.*share\n/);
  });

  it('repeated tool use is flagged at 25', async () => {
    await w('logs/build.log', [...Array(25).fill('tool: Read'), ...Array(24).fill('tool: Grep'), 'noise'].join('\n'));
    const r = await build();
    expect(r).toContain('- Read: 25 (repeated)');
    expect(r).toContain('- Grep: 24\n');
  });

  it('secrets are redacted', async () => {
    await w('questions.md', 'key is FAKE_RETRO_SECRET_42\n');
    const r = await build({ API_KEY: 'FAKE_RETRO_SECRET_42' });
    expect(r).not.toContain('FAKE_RETRO_SECRET_42');
    expect(r).toContain('[REDACTED:API_KEY]');
  });

  it('symlinked job files are refused, not read', async () => {
    const outside = join(repo, 'outside.txt');
    await writeFile(outside, 'TOP SECRET');
    await symlink(outside, join(jobDir, 'questions.md'));
    const r = await build();
    expect(r).not.toContain('TOP SECRET');
    expect(r).toMatch(/## Questions and assumptions\n\n\(unreadable\)/);
  });

  it('record is capped at 60k characters with truncation marks', async () => {
    await w('questions.md', 'q'.repeat(70_000));
    await w('logs/build.log', 'tool: Read\n');
    const r = await build();
    expect(r.length).toBeLessThanOrEqual(60_000);
    expect(r).toMatch(/## Questions and assumptions\n\n\(truncated\)/);
    expect(r).toMatch(/## Tool use by stage\n\n\(truncated\)/);
    expect(r).toContain('## Job');
  });
});

describe('hostile job files', () => {
  it('symlinked logs/ is refused', async () => {
    const other = await mkdtemp(join(tmpdir(), 'anton-other-'));
    await writeFile(join(other, 'build.log'), 'tool: Read\n'.repeat(30));
    await symlink(other, join(jobDir, 'logs'));
    const r = await build();
    expect(r).not.toContain('Read');
    expect(r).toMatch(/## Tool use by stage\n\n\(unreadable\)/);
  });
  it('symlinked evidence/ is refused', async () => {
    const other = await mkdtemp(join(tmpdir(), 'anton-other-'));
    await writeFile(join(other, 'results-verify-1.json'), JSON.stringify({ review: { findings: [{ severity: 'blocking', file: 'x', summary: 'LEAKED' }] } }));
    await symlink(other, join(jobDir, 'evidence'));
    const r = await build();
    expect(r).not.toContain('LEAKED');
    expect(r).toMatch(/## Reviewer findings\n\n\(unreadable\)/);
    expect(r).toContain('## Tool use by stage');
  });
  it.each(['[1,2]', '{"build":"x"}', 'not json'])('bad cost.json %s does not throw', async (raw) => {
    await w('cost.json', raw);
    await w('state.json', JSON.stringify(state({ stageSpentUsd: undefined })));
    const r = await build();
    expect(r).toContain('## Cost and allowance by stage');
  });
  it('a 100k spec field keeps all 8 headings within the cap', async () => {
    await w('spec.json', JSON.stringify(spec({ summary: 'x'.repeat(100_000) })));
    await w('questions.md', 'q'.repeat(70_000));
    const r = await build();
    expect(r.length).toBeLessThanOrEqual(60_000);
    expect([...r.matchAll(/^## .+$/gm)]).toHaveLength(8);
  });
});

describe('retro prompt and schema', () => {
  it('lists every lesson target from code', async () => {
    const p = await retroPrompt();
    for (const t of [...Object.values(LESSON_FILES), ...KIT_LESSON_FILES]) expect(p).toContain(`\`${t}\``);
    expect(p).not.toContain('{{TARGETS}}');
  });
  it('json schema has an object root', () => {
    expect(RETRO_JSON_SCHEMA.type).toBe('object');
  });
});
