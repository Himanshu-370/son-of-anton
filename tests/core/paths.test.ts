import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { antonHome, jobDir, projectDir } from '../../src/core/paths.js';

describe('paths', () => {
  const original = process.env.ANTON_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.ANTON_HOME;
    else process.env.ANTON_HOME = original;
  });

  it('uses ANTON_HOME when set', () => {
    process.env.ANTON_HOME = '/tmp/x';
    expect(antonHome()).toBe('/tmp/x');
  });

  it('defaults to ~/anton', () => {
    delete process.env.ANTON_HOME;
    expect(antonHome()).toBe(join(homedir(), 'anton'));
  });

  it('projectDir uses projectsDir from config when set, expanding ~/', () => {
    expect(projectDir('a', '/srv/anton-projects')).toBe('/srv/anton-projects/a');
    expect(projectDir('a', '~/Documents/projects')).toBe(join(homedir(), 'Documents', 'projects', 'a'));
  });

  it('projectDir ends with /projects/<slug>', () => {
    process.env.ANTON_HOME = '/tmp/x';
    expect(projectDir('a')).toBe('/tmp/x/projects/a');
    expect(projectDir('a').endsWith('/projects/a')).toBe(true);
  });

  it('jobDir is <repo>/.anton/jobs/<jobId>', () => {
    expect(jobDir('/r', '1-init')).toBe('/r/.anton/jobs/1-init');
  });
});
