import * as fsp from 'node:fs/promises';

/** Loads a prompt file relative to the package root (works from src/ and dist/). */
export async function loadPrompt(name: string): Promise<string> {
  return fsp.readFile(new URL(`../../src/stages/prompts/${name}`, import.meta.url), 'utf8');
}
