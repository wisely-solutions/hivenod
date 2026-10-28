import { describe, expect, it } from 'vitest';
import { inboxMessageKey, inboxThreadKey } from '@hive/shared';
import { CARRY_OUT, digestOf, NEXT } from './inbox';

describe('inbox', () => {
  it('ids: the same vectors as the Go CLI (cli/internal/actions/inbox_test.go)', () => {
    expect(digestOf(inboxMessageKey('joao', 'teams', 'thread-1', 'm-1'))).toBe(
      '4132746f6e2a378b2b6b740b',
    );
    expect(digestOf(inboxThreadKey('joao', 'teams', 'thread-1'))).toBe('44c86252e46c927f020ca6f3');
  });

  it('only an approved outcome tells the agent to carry something out', () => {
    expect(CARRY_OUT).toMatch(/approved/);
    for (const s of Object.values(NEXT)) expect(s).not.toMatch(/carry out|send/i);
  });
});
