export interface TrimOptions {
  headLines?: number;
  tailLines?: number;
  fullPath?: string;
}

export function trimOutput(text: string, opts: TrimOptions = {}): string {
  const head = opts.headLines ?? 40;
  const tail = opts.tailLines ?? 80;
  const lines = text.split('\n');
  if (lines.length <= head + tail) return text;
  const trimmed = lines.length - head - tail;
  const where = opts.fullPath ? `; full output at ${opts.fullPath}` : '';
  const marker = `… [${trimmed} lines trimmed${where}] …`;
  return [...lines.slice(0, head), marker, ...(tail > 0 ? lines.slice(-tail) : [])].join('\n');
}
