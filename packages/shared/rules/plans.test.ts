/**
 * Inbox plans (item qwFAWxZM5xkcE7PPjAzi), slice 1: the plan-only types (a person-approval gate,
 * a booking without its reply) exist only as plan steps, so an agent cannot propose one alone.
 */
import { describe, expect, it } from 'vitest';
import { addInboxMessage, inboxPaths, proposeOutcome, type ThreadStateOf } from '../src/inbox';
import { AGENTS, as, denied, ok, snap, useEmulator, W } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);

async function started() {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: 'im1',
        ref: 'r1',
        memberUid: 'alice',
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Can we move the review to Thursday?',
        threadRef: 'thread-1',
        messageId: 'm-1',
        permalink: 'https://teams.example.com/m/1',
        replyRef: 'conv:1',
        receivedAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ),
  );
  return a;
}

describe('plan-only outcome types', () => {
  it('an agent cannot propose an approval gate or a bare booking alone', async () => {
    const a = await started();
    const th = (await snap(T('itr1'))) as unknown as ThreadStateOf;
    const p = proposeOutcome(a.ctx, {
      threadId: 'itr1',
      thread: th,
      type: 'reply',
      fields: { text: 'Thursday works.' },
    });
    const forge = (over: Record<string, unknown>) =>
      a.run(
        p.ops.map((op) =>
          op.path === O(p.outcomeId) ? { ...op, data: { ...op.data, ...over } } : op,
        ),
      );
    // approval: executor none, like the immediate types; still refused alone
    await denied(forge({ type: 'approval', fields: { what: 'New prices' }, executor: null }));
    await denied(
      forge({
        type: 'book',
        fields: { start: '2026-11-05T10:00:00.000Z', end: '2026-11-05T11:00:00.000Z', with: 'Sam' },
      }),
    );
    // a single outcome carries no planId
    await denied(forge({ planId: 'pl1' }));
    await ok(a.run(p));
    expect(await snap(O(p.outcomeId))).toMatchObject({ type: 'reply', state: 'proposed' });
  });
});
