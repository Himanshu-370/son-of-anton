import { execa } from 'execa';

export type ExecFn = (
  cmd: string,
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Default ExecFn: never throws on non-zero exit (rejects only if the process cannot spawn). */
export const defaultExec: ExecFn = async (cmd, args) => {
  const r = await execa(cmd, args, { reject: false });
  return {
    exitCode: r.exitCode ?? 1,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
  };
};
