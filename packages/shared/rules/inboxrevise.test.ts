/**
 * Ask for changes (item L7OzWKMYZ1O2dX33Xkrj): only the member asks the proposing agent for a new
 * version; only that agent writes it, append-only, at most 10; the member approves the version
 * shown, also while the agent revises, which refuses the late revision.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_TIME, type WriteOp } from '../src/actions';
import {
  addInboxMessage,
  approveOutcome,
  cancelRevision,
  inboxPaths,
  proposeOutcome,
  rejectOutcome,
  requestRevision,
  reviseOutcome,
  type OutcomeStateOf,
  type OutcomeVersion,
  type ThreadStateOf,
} from '../src/inbox';
import { paths } from '../src/schema';
import { AGENTS, as, denied, now, ok, put, snap, useEmulator, W, W2, type As } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const thread = async () => (await snap(T('itr1'))) as unknown as ThreadStateOf;
const outcome = async (oid: string) => (await snap(O(oid))) as unknown as OutcomeStateOf;

/** agentA brings a message in for alice; `proposer` proposes a reply. */
async function proposed(proposer: string = AGENTS.a, type = 'reply') {
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
        receivedAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ),
  );
  const p = as(proposer);
  const fields =
    type === 'snooze' ? { until: '2099-01-01T09:00:00Z' } : { text: 'Thursday works for me.' };
  const pr = proposeOutcome(p.ctx, {
    threadId: 'itr1',
    thread: await thread(),
    type,
    fields,
    note: 'They asked.',
    confidence: 'high',
  });
  await ok(p.run(pr));
  return pr.outcomeId;
}

async function ask(oid: string, chips: string[] = ['shorter'], instruction = 'Mention 14:00') {
  const alice = as('alice');
  await ok(
    alice.run(
      requestRevision(alice.ctx, {
        outcomeId: oid,
        outcome: await outcome(oid),
        thread: await thread(),
        chips,
        instruction,
      }),
    ),
  );
}

async function revise(oid: string, text: string, who: As = as(AGENTS.a)) {
  return who.run(
    reviseOutcome(who.ctx, {
      outcomeId: oid,
      outcome: await outcome(oid),
      thread: await thread(),
      fields: { text },
      note: 'Shorter.',
    }),
  );
}

/** The plan's outcome update with `over` merged into its data (for forged writes). */
function forge(ops: WriteOp[], oid: string, over: Record<string, unknown>): WriteOp[] {
  return ops.map((op) => (op.path === O(oid) ? { ...op, data: { ...op.data, ...over } } : op));
}

describe('ask for changes: the member only', () => {
  it('the member asks: revising in place, the thread stays in Your call, nothing rejected', async () => {
    const oid = await proposed();
    await ask(oid, ['shorter', 'availability']);
    expect(await outcome(oid)).toMatchObject({
      state: 'revising',
      decision: null,
      revise: { instruction: 'Mention 14:00', chips: ['shorter', 'availability'], byUid: 'alice' },
    });
    expect((await thread()).state).toBe('yourCall');
    // Cancel: proposed again.
    const alice = as('alice');
    await ok(
      alice.run(
        cancelRevision(alice.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
        }),
      ),
    );
    expect(await outcome(oid)).toMatchObject({ state: 'proposed', revise: null });
  });

  it('refused: another member, an agent, a bad ask, an immediate type', async () => {
    const oid = await proposed();
    const o = await outcome(oid);
    const t = await thread();
    const bob = as('bob');
    await denied(
      bob.run(
        requestRevision(bob.ctx, {
          outcomeId: oid,
          outcome: { ...o, memberUid: 'bob' },
          thread: t,
          chips: ['shorter'],
        }),
      ),
    );
    const alice = as('alice');
    const good = requestRevision(alice.ctx, {
      outcomeId: oid,
      outcome: o,
      thread: t,
      chips: ['shorter'],
    }).ops;
    // An agent cannot write the member's request (as itself or with the member's event).
    const a = as(AGENTS.a);
    await denied(
      a.run(
        requestRevision(
          { ...a.ctx, actor: { type: 'human', id: AGENTS.a, name: 'A' } },
          { outcomeId: oid, outcome: { ...o, memberUid: AGENTS.a }, thread: t, chips: ['shorter'] },
        ),
      ),
    );
    const rev = (over: Record<string, unknown>) =>
      forge(good, oid, {
        revise: { instruction: null, chips: ['shorter'], byUid: 'alice', at: SERVER_TIME, ...over },
      });
    await denied(alice.run(rev({ instruction: 'x'.repeat(501) })));
    await denied(alice.run(rev({ chips: ['louder'] })));
    await denied(alice.run(rev({ chips: ['shorter', 'shorter'] })));
    await denied(alice.run(rev({ chips: [] })));
    await denied(alice.run(rev({ byUid: 'bob' })));
    await denied(alice.run(forge(good, oid, { fields: { text: 'sneaky' } })));
    await denied(alice.run(forge(good, oid, { state: 'approved' })));
    await ok(alice.run(rev({ instruction: 'x'.repeat(500) })));
  });

  it('an immediate type has nothing to revise', async () => {
    const oid = await proposed(AGENTS.a, 'snooze');
    const alice = as('alice');
    const o = await outcome(oid);
    const t = await thread();
    const fake = requestRevision(alice.ctx, {
      outcomeId: oid,
      outcome: { ...o, type: 'reply' },
      thread: t,
      chips: ['shorter'],
    });
    await denied(alice.run(fake));
  });
});

describe('the proposing agent revises, append-only', () => {
  it('v1 is kept, v2 appended; then v3; fields stay the latest', async () => {
    const oid = await proposed();
    await ask(oid);
    await ok(revise(oid, 'Thursday 10:00, or 14:00.'));
    let o = await outcome(oid);
    expect(o).toMatchObject({
      state: 'proposed',
      revise: null,
      fields: { text: 'Thursday 10:00, or 14:00.' },
    });
    expect(o.versions!.map((v) => [v.n, v.fields.text])).toEqual([
      [1, 'Thursday works for me.'],
      [2, 'Thursday 10:00, or 14:00.'],
    ]);
    expect(o.versions![1]!.asked).toEqual({ instruction: 'Mention 14:00', chips: ['shorter'] });
    expect((await thread()).state).toBe('yourCall');
    await ask(oid, ['warmer'], '');
    await ok(revise(oid, 'Thursday 10:00 works, thanks!'));
    o = await outcome(oid);
    expect(o.versions!.map((v) => v.n)).toEqual([1, 2, 3]);
  });

  it('refused: nobody asked, another agent of the org, another org’s agent, a person', async () => {
    const oid = await proposed();
    const a = as(AGENTS.a);
    // Not revising: forged plan from a revising snapshot.
    const forged = reviseOutcome(a.ctx, {
      outcomeId: oid,
      outcome: {
        ...(await outcome(oid)),
        state: 'revising',
        revise: { instruction: 'x', chips: [], byUid: 'alice', at: null as never },
      },
      thread: await thread(),
      fields: { text: 'x' },
    });
    await denied(a.run(forged));
    await ask(oid);
    // agentStar did not propose it.
    const s = as(AGENTS.star);
    await denied(
      s.run(
        reviseOutcome(s.ctx, {
          outcomeId: oid,
          outcome: { ...(await outcome(oid)), proposedBy: AGENTS.star },
          thread: await thread(),
          fields: { text: 'x' },
        }),
      ),
    );
    await put({
      [paths.agent(W2, 'agentOther')]: {
        name: 'Other',
        color: '#000',
        projectIds: '*',
        createdBy: 'eve',
        createdAt: now(),
        revokedAt: null,
        lastSeenAt: null,
        tokenHint: 'zzzz',
        previousAgentUid: null,
        lastEventId: 'seed',
      },
    });
    const other = as('agentOther', { workspaceId: W2 });
    await denied(
      other.run(
        reviseOutcome(
          { ...other.ctx, workspaceId: W },
          {
            outcomeId: oid,
            outcome: { ...(await outcome(oid)), proposedBy: 'agentOther' },
            thread: await thread(),
            fields: { text: 'x' },
          },
        ),
      ),
    );
    const r = as(AGENTS.revoked);
    await denied(
      r.run(
        reviseOutcome(r.ctx, {
          outcomeId: oid,
          outcome: { ...(await outcome(oid)), proposedBy: AGENTS.revoked },
          thread: await thread(),
          fields: { text: 'x' },
        }),
      ),
    );
    expect((await outcome(oid)).state).toBe('revising');
    await ok(revise(oid, 'ok'));
  });

  it('refused: rewriting v1, skipping a number, fields not the latest, another type, bad fields', async () => {
    const oid = await proposed();
    await ask(oid);
    const a = as(AGENTS.a);
    const p = reviseOutcome(a.ctx, {
      outcomeId: oid,
      outcome: await outcome(oid),
      thread: await thread(),
      fields: { text: 'v2' },
    });
    const vs = (p.ops.find((o) => o.path === O(oid))!.data as { versions: OutcomeVersion[] })
      .versions;
    await denied(
      a.run(forge(p.ops, oid, { versions: [{ ...vs[0]!, fields: { text: 'rewritten' } }, vs[1]] })),
    );
    await denied(a.run(forge(p.ops, oid, { versions: [vs[0], { ...vs[1]!, n: 3 }] })));
    await denied(a.run(forge(p.ops, oid, { versions: [vs[1]] })));
    await denied(a.run(forge(p.ops, oid, { fields: { text: 'not v2' } })));
    await denied(a.run(forge(p.ops, oid, { type: 'nudge' })));
    await denied(
      a.run(
        forge(p.ops, oid, {
          fields: { text: 'v2', bcc: 'all' },
          versions: [vs[0], { ...vs[1]!, fields: { text: 'v2', bcc: 'all' } }],
        }),
      ),
    );
    await denied(a.run(forge(p.ops, oid, { versions: [vs[0], { ...vs[1]!, asked: null }] })));
    await denied(
      a.run(
        forge(p.ops, oid, {
          revise: { instruction: 'x', chips: [], byUid: 'alice', at: SERVER_TIME },
        }),
      ),
    );
    await ok(a.run(p));
    // v3 rewriting v2 is refused too.
    await ask(oid);
    const p3 = reviseOutcome(a.ctx, {
      outcomeId: oid,
      outcome: await outcome(oid),
      thread: await thread(),
      fields: { text: 'v3' },
    });
    const v3 = (p3.ops.find((o) => o.path === O(oid))!.data as { versions: OutcomeVersion[] })
      .versions;
    await denied(
      a.run(forge(p3.ops, oid, { versions: [v3[0], { ...v3[1]!, note: 'changed' }, v3[2]] })),
    );
    await ok(a.run(p3));
  });

  it('no 11th version: the member cannot ask past 10, the agent cannot write one', async () => {
    const oid = await proposed();
    const versions = Array.from({ length: 10 }, (_, i) => ({
      n: i + 1,
      fields: { text: `v${i + 1}` },
      note: '',
      confidence: null,
      checks: [],
      by: AGENTS.a,
      eventId: i === 0 ? null : `e${i}`,
      asked: i === 0 ? null : { instruction: 'x', chips: [] },
    }));
    // Nine versions: one more request is allowed, the agent writes the 10th.
    await put({
      [O(oid)]: { ...(await snap(O(oid))), versions: versions.slice(0, 9), fields: { text: 'v9' } },
    });
    await ask(oid);
    await ok(revise(oid, 'v10'));
    expect((await outcome(oid)).versions).toHaveLength(10);
    const alice = as('alice');
    const o = await outcome(oid);
    const t = await thread();
    // The action refuses; a forged request is refused by the rules.
    expect(() =>
      requestRevision(alice.ctx, { outcomeId: oid, outcome: o, thread: t, chips: ['shorter'] }),
    ).toThrow(/10 versions/);
    await denied(
      alice.run(
        requestRevision(alice.ctx, {
          outcomeId: oid,
          outcome: { ...o, versions: o.versions!.slice(0, 2) },
          thread: await thread(),
          chips: ['shorter'],
        }),
      ),
    );
    // An 11th written by the agent on a forged revising state is refused.
    await put({
      [O(oid)]: {
        ...(await snap(O(oid))),
        state: 'revising',
        revise: { instruction: 'x', chips: [], byUid: 'alice', at: now() },
      },
    });
    const a = as(AGENTS.a);
    const cur = await outcome(oid);
    const eleventh = reviseOutcome(a.ctx, {
      outcomeId: oid,
      outcome: { ...cur, versions: cur.versions!.slice(0, 9) },
      thread: await thread(),
      fields: { text: 'v11' },
    });
    await denied(
      a.run(
        forge(eleventh.ops, oid, {
          versions: [
            ...cur.versions!,
            {
              ...versions[9]!,
              n: 11,
              fields: { text: 'v11' },
              note: '',
              eventId: eleventh.eventId,
              asked: { instruction: 'x', chips: [] },
            },
          ],
        }),
      ),
    );
  });
});

describe('approve the version shown', () => {
  it('approves v1 of 2 with decision.version; carry-out data unchanged', async () => {
    const oid = await proposed();
    await ask(oid);
    await ok(revise(oid, 'v2 text'));
    const alice = as('alice');
    await denied(
      alice.run(
        forge(
          approveOutcome(alice.ctx, {
            outcomeId: oid,
            outcome: await outcome(oid),
            thread: await thread(),
            version: 1,
          }).ops,
          oid,
          {
            decision: { byUid: 'alice', at: SERVER_TIME, edited: false, reason: null, version: 3 },
          },
        ),
      ),
    );
    await ok(
      alice.run(
        approveOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
          version: 1,
        }),
      ),
    );
    expect(await outcome(oid)).toMatchObject({
      state: 'approved',
      fields: { text: 'Thursday works for me.' },
      decision: { version: 1, edited: false },
    });
  });

  it('sending while revising approves it and refuses the late revision; reject waits', async () => {
    const oid = await proposed();
    await ask(oid);
    const alice = as('alice');
    // Reject is for a proposed outcome only (Cancel first).
    await denied(
      alice.run(
        rejectOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: { ...(await outcome(oid)), state: 'proposed' },
          thread: await thread(),
          othersPending: false,
        }),
      ),
    );
    // Approving must clear the request.
    const ap = approveOutcome(alice.ctx, {
      outcomeId: oid,
      outcome: await outcome(oid),
      thread: await thread(),
    });
    const keep = (await outcome(oid)).revise;
    await denied(alice.run(forge(ap.ops, oid, { revise: keep })));
    await ok(alice.run(ap));
    expect(await outcome(oid)).toMatchObject({ state: 'approved', revise: null });
    const a = as(AGENTS.a);
    const late = reviseOutcome(a.ctx, {
      outcomeId: oid,
      outcome: { ...(await outcome(oid)), state: 'revising', revise: keep },
      thread: await thread(),
      fields: { text: 'late' },
    });
    await denied(a.run(late));
    expect((await outcome(oid)).fields).toEqual({ text: 'Thursday works for me.' });
  });
});
