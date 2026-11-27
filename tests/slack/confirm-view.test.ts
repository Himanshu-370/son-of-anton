import { describe, expect, it } from 'vitest';
import { renderConfirmReview } from '../../src/slack/views.js';

const data = {
  description: 'Approve the spec for todo-app (job 3) and start the plan.',
  effects: 'It will spend from the $10 budget.',
  confirmToken: '0'.repeat(32),
  cancelToken: '1'.repeat(32),
};

describe('renderConfirmReview', () => {
  it('shows the operation, money effect and expiry with token-only controls', () => {
    const view = renderConfirmReview(data);

    expect(view.text).toContain(data.description);
    expect(view.text).toContain(data.effects);
    expect(view.text).toContain('This card expires in 30 minutes.');
    expect(view.blocks.at(-1)).toEqual({
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'anton_0', text: { type: 'plain_text', text: 'Confirm', emoji: false }, value: data.confirmToken, style: 'primary' },
        { type: 'button', action_id: 'anton_1', text: { type: 'plain_text', text: 'Cancel', emoji: false }, value: data.cancelToken },
      ],
    });
  });

  it('marks abandon as irreversible and styles only Confirm as dangerous', () => {
    const view = renderConfirmReview({ ...data, description: 'Abandon todo-app (job 3).', dangerous: true });

    expect(view.text).toContain("This can't be undone.");
    expect(view.blocks.at(-1)).toMatchObject({ elements: [{ style: 'danger' }, { action_id: 'anton_1' }] });
  });

  it('reconstructs the full redacted notes from bounded, inert plain-text sections', () => {
    const editToken = '2'.repeat(32);
    const firstLine = '  <tag> <!channel> *literal* &amp; [redacted]  \n\n';
    const notes = firstLine.padEnd(2892, 'x') + '😀\n  e\u0301 Ａ  ' + 'y'.repeat(1080) + '\n';
    const view = renderConfirmReview({ ...data, notes, edit: { token: editToken } });

    const sections = view.blocks.slice(2, -2).map((block) => block.text as { type: string; text: string });
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section.type).toBe('plain_text');
      expect(section.text.length).toBeLessThanOrEqual(2900);
      expect(section.text.isWellFormed()).toBe(true);
    }
    expect(sections.map(({ text }) => text).join('')).toBe(`Notes: ${notes}`);
    expect(view.text).toContain('Full details are in the card.');
    expect(view.text).not.toContain(firstLine);
    expect(view.blocks.at(-1)).toMatchObject({
      elements: [
        { action_id: 'anton_0' },
        { action_id: 'anton_1' },
        { action_id: 'anton_2', text: { text: 'Edit' }, value: editToken },
      ],
    });
  });

  it('keeps both summary lines, warnings and the details notice in a Unicode-safe fallback', () => {
    const description = 'Abandon todo-app '.padEnd(1898, 'x') + '😀' + 'x'.repeat(1000);
    const effects = 'Release the remaining budget. ' + 'y'.repeat(2900);
    const view = renderConfirmReview({ ...data, description, effects, dangerous: true });

    expect(view.text.length).toBeLessThanOrEqual(4000);
    expect(view.text.isWellFormed()).toBe(true);
    expect(view.text).toContain('Abandon todo-app');
    expect(view.text).toContain('Release the remaining budget.');
    expect(view.text).toContain("This can't be undone.");
    expect(view.text).toContain('This card expires in 30 minutes.');
    expect(view.text).toContain('Full details are in the card.');
  });

  it('allows the existing budget edit modality to use a specific label', () => {
    const view = renderConfirmReview({ ...data, edit: { token: '3'.repeat(32), label: 'Change budget' } });
    expect(view.blocks.at(-1)).toMatchObject({
      elements: [{ action_id: 'anton_0' }, { action_id: 'anton_1' }, { text: { text: 'Change budget' } }],
    });
  });
});
