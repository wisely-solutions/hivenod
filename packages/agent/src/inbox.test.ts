import { describe, expect, it } from 'vitest';
import { inboxRequestId, NEXT } from './inbox';

describe('inbox', () => {
  it('request ids: the same vector as the Go CLI (cli/internal/actions/inbox_test.go)', () => {
    expect(inboxRequestId('teams', 'thread-1', 'm-1')).toBe('rq298f1b1c3ec51e286529c8d0');
    expect(inboxRequestId('teams', 'thread-1', 'm-2')).not.toBe('rq298f1b1c3ec51e286529c8d0');
  });

  it('only a request its person sent tells the agent to post', () => {
    expect(NEXT.sending!(true)).toMatch(/post approved.reply/);
    for (const s of ['new', 'drafting', 'yourCall', 'done', 'ignored'])
      expect(NEXT[s]!(true)).not.toMatch(/post/);
    expect(NEXT.sending!(false)).not.toMatch(/post approved/);
  });
});
