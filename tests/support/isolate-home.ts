import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Deliver now appends to <anton home>/history.jsonl; keep tests off the real ~/anton.
process.env.ANTON_HOME ||= mkdtempSync(join(tmpdir(), 'anton-test-home-'));
