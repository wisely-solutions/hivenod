import { describe, expect, it } from 'vitest';
import { bellEntrySchema, bellId, bellNeedsYou, bellPlain } from './bell';

const base = {
  workspaceId: 'w',
  projectId: 'p',
  itemId: 'i',
  projectName: 'Hive',
  itemTitle: 'Connect wizard',
  stepName: 'Accept',
  actorName: 'Hive',
  text: '',
  at: 1,
  readAt: null,
};

describe('bell entries (item 3ENs)', () => {
  it('reads each kind as a sentence', () => {
    expect(bellPlain({ ...base, kind: 'gate' })).toBe('Connect wizard waits for your Accept');
    expect(bellPlain({ ...base, kind: 'question', text: 'token ready?' })).toBe(
      'Hive asked about Connect wizard: “token ready?”',
    );
    expect(bellPlain({ ...base, kind: 'answer', actorName: 'João' })).toBe(
      'João answered the question on Connect wizard',
    );
    expect(
      bellPlain({ ...base, kind: 'sentBack', stepName: 'Build', text: '7 e2e failures' }),
    ).toBe('Hive sent Connect wizard back to Build: 7 e2e failures');
  });
  it('only gates and questions ask you to act', () => {
    expect(bellNeedsYou('gate')).toBe(true);
    expect(bellNeedsYou('question')).toBe(true);
    expect(bellNeedsYou('answer')).toBe(false);
    expect(bellNeedsYou('sentBack')).toBe(false);
  });
  it('makes stable, safe document ids', () => {
    expect(bellId.gate('abc', 'review:2')).toBe('g-abc-review_2');
    expect(bellId.question('m1')).toBe('q-m1');
    expect(bellId.sentBack('d/1')).toBe('s-d_1');
  });
  it('validates entries', () => {
    expect(bellEntrySchema.safeParse({ ...base, kind: 'gate' }).success).toBe(true);
    expect(bellEntrySchema.safeParse({ ...base, kind: 'other' }).success).toBe(false);
  });
});
