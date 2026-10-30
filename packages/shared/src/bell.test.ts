import { describe, expect, it } from 'vitest';
import { bellEntrySchema, bellId, bellNeedsYou, bellPlain, INBOX_BELL_PROJECT } from './bell';

const base = {
  workspaceId: 'w',
  projectId: INBOX_BELL_PROJECT,
  itemId: 't1',
  projectName: 'Inbox · Payments',
  itemTitle: 'Move the review',
  stepName: '',
  actorName: 'Hive',
  text: '',
  at: 1,
  readAt: null,
};

describe('bell entries (item 3ENs)', () => {
  it('reads each kind as a sentence', () => {
    expect(bellPlain({ ...base, kind: 'inboxAsk', text: 'Thursday?' })).toBe(
      'Hive asks you about Move the review: “Thursday?”',
    );
    expect(bellPlain({ ...base, kind: 'inboxCall', text: 'Reply' })).toBe(
      'Your call on Move the review: Reply',
    );
  });
  it('both inbox kinds ask you to act', () => {
    expect(bellNeedsYou('inboxAsk')).toBe(true);
    expect(bellNeedsYou('inboxCall')).toBe(true);
  });
  it('makes stable, safe document ids', () => {
    expect(bellId.inbox('t1', 's:p1:o2')).toBe('i-t1-s_p1_o2');
  });
  it('validates entries; the old project kinds no longer parse', () => {
    expect(bellEntrySchema.safeParse({ ...base, kind: 'inboxAsk' }).success).toBe(true);
    expect(bellEntrySchema.safeParse({ ...base, kind: 'gate' }).success).toBe(false);
    expect(bellEntrySchema.safeParse({ ...base, kind: 'other' }).success).toBe(false);
  });
});
