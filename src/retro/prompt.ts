import { z } from 'zod';
import { KIT_LESSON_FILES, LESSON_FILES } from '../lessons/store.js';
import { loadPrompt } from '../stages/prompts.js';

export const RetroOutputSchema = z.object({
  lessons: z.array(z.object({ target: z.string().min(1), text: z.string().min(1), why: z.string().min(1) })),
  plugins: z.array(z.object({ plugin: z.string().min(1), stage: z.enum(['spec', 'plan', 'build', 'verify']), why: z.string().min(1) })),
});
export type RetroOutput = z.infer<typeof RetroOutputSchema>;
export const RETRO_JSON_SCHEMA = z.toJSONSchema(RetroOutputSchema) as Record<string, unknown>;

export const lessonTargets = (): string[] => [...Object.values(LESSON_FILES).filter((v): v is string => !!v), ...KIT_LESSON_FILES];

/** The coach's system prompt with the valid lesson targets rendered from code. */
export async function retroPrompt(): Promise<string> {
  return (await loadPrompt('retro.md')).replace('{{TARGETS}}', lessonTargets().map((t) => `  - \`${t}\``).join('\n'));
}
