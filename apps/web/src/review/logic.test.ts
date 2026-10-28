import { describe, expect, it } from 'vitest';
import type { Item, Step } from '@hive/shared';
import { approvalRows, clampZoom, findingsOf, hostOf, textPage } from './logic';

const f = (id: string, over: Partial<Item> = {}) => ({
  id,
  data: {
    type: 'finding',
    status: 'suggested',
    triage: null,
    parentItemId: 'p',
    order: 1,
    ...over,
  } as Item,
});

describe('findingsOf', () => {
  it('keeps untriaged findings of this item only, oldest first', () => {
    const rows = [
      f('b', { order: 2 }),
      f('a', { order: 1 }),
      f('other', { parentItemId: 'x' }),
      f('done', { triage: { outcome: 'dismissed', reason: '', byUid: 'u', at: {} as never } }),
      f('task', { type: 'task' }),
      f('old', { status: 'queued' }),
    ];
    expect(findingsOf(rows, 'p').map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('approvalRows', () => {
  const step = {
    id: 's',
    name: 'Review',
    kind: 'human',
    description: '',
    gate: {
      deciderUids: ['ann', 'bob', 'cy'],
      groupIds: [],
      rule: 'atLeast',
      n: 2,
      mustInclude: ['ann'],
      rejectPolicy: 'one',
      remindAfterHours: 24,
    },
  } as unknown as Step;
  it('lists approvers first with their words and marks who is required', () => {
    const rows = approvalRows(step, {
      gate: {
        stepId: 's',
        approvals: { bob: { at: {}, rationale: 'Looks right' } },
        rejections: {},
      },
    } as unknown as Item);
    expect(rows.map((r) => [r.uid, r.state, r.required])).toEqual([
      ['bob', 'approved', false],
      ['ann', 'waiting', true],
      ['cy', 'waiting', false],
    ]);
    expect(rows[0]!.quote).toBe('Looks right');
  });
  it('is empty for an agent step', () => {
    expect(approvalRows({ ...step, gate: undefined, kind: 'agent' }, { gate: null })).toEqual([]);
  });
});

describe('small helpers', () => {
  it('clamps zoom', () => {
    expect(clampZoom(99)).toBe(5);
    expect(clampZoom(0.1)).toBe(0.5);
  });
  it('shows a link host', () => {
    expect(hostOf('https://example.com/a?b')).toBe('example.com');
  });
});

describe('textPage', () => {
  it('escapes markup so the text cannot inject HTML', () => {
    const html = textPage('# Hi <script>x()</script> & more');
    expect(html).toContain('# Hi &lt;script&gt;x()&lt;/script&gt; &amp; more');
    expect(html).not.toContain('<script>');
  });
});
