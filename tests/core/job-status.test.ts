import { describe, expect, it } from 'vitest';
import { formatStatusTable } from '../../src/core/job-status.js';

describe('formatStatusTable', () => {
  it('pads all but the last column and adds the header', () => {
    const lines = formatStatusTable([['p', 'plan', '0', '$0.00 / $10.00', '-', 'cache 5%']]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('PROJECT  STAGE')).toBe(true);
    expect(lines[1]).toBe('p        plan   0      $0.00 / $10.00  -             cache 5%');
    expect(lines.every((l) => !l.endsWith(' '))).toBe(true);
  });
});
