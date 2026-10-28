/**
 * Inbox (item 4PEHrOW5IfXBQWgOK9wo): subjects, threads, messages, outcomes and their events are
 * private to the member they are for, plus the organization's agents. Nothing is carried out
 * without the member's approval, and only the outcome's executor reports it done.
 */
import { Timestamp, collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { createItem, SERVER_TIME, type WriteOp } from '../src/actions';
import {
  addInboxMessage,
  addThreadNote,
  answerQuestion,
  approveOutcome,
  askMember,
  assignSubject,
  closeThread,
  finishOutcome,
  flagThread,
  ignoreThread,
  inboxPaths,
  makeItemFromThread,
  mergeSubjects,
  moveThread,
  proposeOutcome,
  rejectOutcome,
  renameSubject,
  restoreThread,
  retitleThread,
  splitSubject,
  wakeThread,
  type InboxAddInput,
  type OutcomeStateOf,
  type ThreadStateOf,
} from '../src/inbox';
import { paths } from '../src/schema';
import {
  AGENTS,
  as,
  denied,
  now,
  ok,
  projectDoc,
  put,
  snap,
  useEmulator,
  W,
  W2,
  type As,
} from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const M = (mid: string) => inboxPaths.message(W, mid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const S = (sid: string) => inboxPaths.subject(W, sid);
const col = (name: string) => `workspaces/${W}/${name}`;

const msg = (a: As, over: Partial<InboxAddInput> = {}) =>
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
    attachments: [{ name: 'agenda.pdf', url: 'https://files.example.com/agenda.pdf' }],
    ...over,
  });
const thread = async (tid = 'itr1') => (await snap(T(tid))) as unknown as ThreadStateOf;
const outcome = async (oid: string) => (await snap(O(oid))) as unknown as OutcomeStateOf;

/** agentA brings a message in for alice: thread itr1, investigating. */
async function started() {
  const a = as(AGENTS.a);
  await ok(a.run(msg(a)));
  return a;
}
/** ... and proposes an outcome. */
async function proposed(
  type: string,
  fields: Record<string, unknown>,
  proposer: string = AGENTS.a,
) {
  await started();
  const p = as(proposer);
  const pr = proposeOutcome(p.ctx, { threadId: 'itr1', thread: await thread(), type, fields });
  await ok(p.run(pr));
  return pr.outcomeId;
}
/** ... and alice approves it. */
async function approved(type: string, fields: Record<string, unknown>) {
  const oid = await proposed(type, fields);
  const alice = as('alice');
  await ok(
    alice.run(
      approveOutcome(alice.ctx, {
        outcomeId: oid,
        outcome: await outcome(oid),
        thread: await thread(),
      }),
    ),
  );
  return oid;
}

/** Raw update plus an inbox event, for attacks the actions refuse to build. */
function raw(
  who: As,
  path: string,
  data: Record<string, unknown>,
  type: string,
  evData: Record<string, unknown> = {},
  member = 'alice',
  threadId: string | null = 'itr1',
): WriteOp[] {
  return [
    { kind: 'update', path, data: { ...data, updatedAt: SERVER_TIME, lastEventId: 'ev-x' } },
    {
      kind: 'set',
      path: inboxPaths.event(W, 'ev-x'),
      data: {
        actor: { type: who.ctx.actor.type, id: who.uid, name: who.ctx.actor.name },
        memberUid: member,
        threadId,
        subjectId: null,
        type,
        data: evData,
        at: SERVER_TIME,
      },
    },
  ];
}

describe('an agent brings a message in', () => {
  it('a new thread for a member of its organization, tracked in inboxEvents only', async () => {
    const a = as(AGENTS.a);
    const p = msg(a);
    await ok(a.run(p));
    expect(await snap(T('itr1'))).toMatchObject({
      memberUid: 'alice',
      state: 'investigating',
      subjectId: null,
      fetchedBy: AGENTS.a,
      title: 'Can we move the review to Thursday?',
      refs: ['r1'],
    });
    expect(await snap(M('im1'))).toMatchObject({
      threadId: 'itr1',
      direction: 'in',
      fetchedBy: AGENTS.a,
    });
    expect(await snap(inboxPaths.event(W, p.eventId))).toMatchObject({
      type: 'inbox.added',
      memberUid: 'alice',
    });
    expect(await snap(paths.event(W, p.eventId))).toEqual({});
  });

  it('more messages join the thread; the same message twice is refused', async () => {
    const a = await started();
    const second = msg(a, {
      messageDocId: 'im2',
      messageId: 'm-2',
      thread: { threadId: 'itr1', state: await thread() },
    });
    await ok(a.run(second));
    // Another channel, same ask: the agent adds it to the thread, which gathers its ref.
    const s = as(AGENTS.star);
    await ok(
      s.run(
        msg(s, {
          messageDocId: 'im3',
          ref: 'r2',
          source: 'mail',
          threadRef: 'mail-9',
          thread: { threadId: 'itr1', state: await thread() },
        }),
      ),
    );
    expect((await thread()).refs).toEqual(['r1', 'r2']);
    await denied(a.run(msg(a, { thread: { threadId: 'itr1', state: await thread() } })));
    await denied(a.run(msg(a, { newThreadId: 'it-other' })));
  });

  it('a message from them reopens a done thread; the member’s own reply does not', async () => {
    const a = await started();
    await put({ [T('itr1')]: { ...(await snap(T('itr1'))), state: 'done' } });
    const out = msg(a, {
      messageDocId: 'im2',
      messageId: 'm-2',
      direction: 'out',
      thread: { threadId: 'itr1', state: await thread() },
    });
    await ok(a.run(out));
    expect((await thread()).state).toBe('done');
    await ok(
      a.run(
        msg(a, {
          messageDocId: 'im3',
          messageId: 'm-3',
          thread: { threadId: 'itr1', state: await thread() },
        }),
      ),
    );
    expect((await thread()).state).toBe('investigating');
    // Forging "no reopen" on an incoming message is refused.
    await put({
      [T('itr1')]: {
        ...(await snap(T('itr1'))),
        state: 'waiting',
        waiting: { on: 'them', until: null },
      },
    });
    const p = msg(a, {
      messageDocId: 'im4',
      messageId: 'm-4',
      thread: { threadId: 'itr1', state: await thread() },
    });
    const forged = p.ops.map((op) =>
      op.path === T('itr1')
        ? { ...op, data: { ...op.data, state: 'waiting', waiting: { on: 'them', until: null } } }
        : op,
    );
    await denied(a.run(forged));
  });

  it('refused: for an outsider, by a revoked agent, by a person, by another organization', async () => {
    const a = as(AGENTS.a);
    await denied(a.run(msg(a, { memberUid: 'eve' })));
    const r = as(AGENTS.revoked);
    await denied(r.run(msg(r)));
    const alice = as('alice');
    await denied(
      alice.run(
        msg({ ...alice, ctx: { ...alice.ctx, actor: { ...alice.ctx.actor, type: 'agent' } } }),
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
    await denied(other.run(msg({ ...other, ctx: { ...other.ctx, workspaceId: W } })));
    await ok(a.run(msg(a)));
    await denied(getDoc(doc(other.db, T('itr1'))));
    await denied(getDoc(doc(other.db, M('im1'))));
  });

  it('refused: bad fields on the thread or the message', async () => {
    const a = as(AGENTS.a);
    const p = msg(a);
    const bad = (path: string, over: Record<string, unknown>) =>
      a.run(p.ops.map((op) => (op.path === path ? { ...op, data: { ...op.data, ...over } } : op)));
    await denied(bad(T('itr1'), { state: 'yourCall' }));
    await denied(bad(T('itr1'), { fetchedBy: AGENTS.star }));
    await denied(bad(T('itr1'), { subjectId: 's1' }));
    await denied(bad(M('im1'), { source: 'Teams!' }));
    await denied(bad(M('im1'), { threadId: 'elsewhere' }));
    await denied(bad(M('im1'), { direction: 'sideways' }));
    await denied(bad(M('im1'), { fetchedBy: AGENTS.star }));
    await ok(a.run(p));
    await denied(a.run([{ kind: 'update', path: M('im1'), data: { text: 'rewritten' } }]));
  });
});

describe('who reads', () => {
  it('the member and the agents only; never another member, an admin or an outsider', async () => {
    const oid = await proposed('reply', { text: 'Thursday works.' });
    const alice = as('alice');
    for (const p of [T('itr1'), M('im1'), O(oid)]) await ok(getDoc(doc(alice.db, p)));
    for (const c of [
      'inboxThreads',
      'inboxMessages',
      'inboxOutcomes',
      'inboxEvents',
      'inboxSubjects',
    ])
      await ok(getDocs(query(collection(alice.db, col(c)), where('memberUid', '==', 'alice'))));
    await denied(getDocs(collection(alice.db, col('inboxThreads'))));
    for (const uid of ['bob', 'owner', 'eve']) {
      const p = as(uid);
      for (const d of [T('itr1'), M('im1'), O(oid)]) await denied(getDoc(doc(p.db, d)));
      for (const c of ['inboxThreads', 'inboxMessages', 'inboxOutcomes', 'inboxEvents'])
        await denied(getDocs(query(collection(p.db, col(c)), where('memberUid', '==', 'alice'))));
    }
    for (const uid of [AGENTS.a, AGENTS.star]) {
      const g = as(uid);
      for (const c of [
        'inboxThreads',
        'inboxMessages',
        'inboxOutcomes',
        'inboxEvents',
        'inboxSubjects',
      ])
        await ok(getDocs(collection(g.db, col(c))));
    }
    await denied(getDoc(doc(as(AGENTS.revoked).db, T('itr1'))));
  });
});

describe('agents investigate: file, note, ask, retitle', () => {
  it('files under a new then an existing subject; never under another member’s', async () => {
    const a = await started();
    const f = assignSubject(a.ctx, {
      threadId: 'itr1',
      thread: await thread(),
      newName: '  Review   date ',
    });
    await ok(a.run(f));
    expect(await snap(S(f.subjectId))).toMatchObject({ memberUid: 'alice', name: 'Review date' });
    await ok(a.run(msg(a, { messageDocId: 'imb', ref: 'rb', memberUid: 'bob', threadRef: 'b' })));
    const bobs = assignSubject(a.ctx, {
      threadId: 'itrb',
      thread: await thread('itrb'),
      newName: 'Bob things',
    });
    await ok(a.run(bobs));
    await denied(
      a.run(
        assignSubject(a.ctx, {
          threadId: 'itr1',
          thread: await thread(),
          subjectId: bobs.subjectId,
        }),
      ),
    );
    await ok(
      a.run(
        assignSubject(a.ctx, { threadId: 'itr1', thread: await thread(), subjectId: f.subjectId }),
      ),
    );
  });

  it('notes are timeline events; a question waits for the member, who answers', async () => {
    const a = await started();
    await ok(
      a.run(
        addThreadNote(a.ctx, {
          threadId: 'itr1',
          thread: await thread(),
          text: 'Checked the calendar.',
        }),
      ),
    );
    await ok(
      a.run(
        askMember(a.ctx, {
          threadId: 'itr1',
          thread: await thread(),
          question: 'Thursday or Friday?',
        }),
      ),
    );
    expect(await thread()).toMatchObject({
      state: 'needsYou',
      question: { text: 'Thursday or Friday?', answer: null },
    });
    const bob = as('bob');
    await denied(
      bob.run(
        answerQuestion(bob.ctx, {
          threadId: 'itr1',
          thread: { ...(await thread()), memberUid: 'bob' },
          answer: 'Friday',
        }),
      ),
    );
    const alice = as('alice');
    await ok(
      alice.run(
        answerQuestion(alice.ctx, { threadId: 'itr1', thread: await thread(), answer: 'Thursday' }),
      ),
    );
    expect(await thread()).toMatchObject({
      state: 'investigating',
      question: { answer: 'Thursday' },
    });
    await ok(
      a.run(
        retitleThread(a.ctx, {
          threadId: 'itr1',
          thread: await thread(),
          title: 'Review on Thursday',
        }),
      ),
    );
    await ok(
      alice.run(
        retitleThread(alice.ctx, {
          threadId: 'itr1',
          thread: await thread(),
          title: 'Review moved',
        }),
      ),
    );
    await denied(
      bob.run(
        retitleThread(bob.ctx, {
          threadId: 'itr1',
          thread: { ...(await thread()), memberUid: 'bob' },
          title: 'x',
        }),
      ),
    );
  });
});

describe('urgent threads (thread_flag)', () => {
  it('its agents and its member flag a thread; nobody else; only a boolean', async () => {
    const a = await started();
    await ok(
      a.run(
        flagThread(a.ctx, {
          threadId: 'itr1',
          thread: await thread(),
          urgent: true,
          reason: 'Prod down',
        }),
      ),
    );
    expect(await snap(T('itr1'))).toMatchObject({ urgent: true });
    const alice = as('alice');
    await ok(
      alice.run(flagThread(alice.ctx, { threadId: 'itr1', thread: await thread(), urgent: false })),
    );
    expect(await snap(T('itr1'))).toMatchObject({ urgent: false });
    const bob = as('bob');
    await denied(
      bob.run(raw(bob, T('itr1'), { urgent: true }, 'thread.flagged', { urgent: true }, 'bob')),
    );
    await denied(a.run(raw(a, T('itr1'), { urgent: 'yes' }, 'thread.flagged')));
    await denied(a.run(raw(a, T('itr1'), { urgent: true, state: 'done' }, 'thread.flagged')));
    await denied(
      as(AGENTS.revoked).run(
        flagThread(as(AGENTS.revoked).ctx, {
          threadId: 'itr1',
          thread: await thread(),
          urgent: true,
        }),
      ),
    );
  });
});

describe('outcomes: proposed by agents, decided by the member only', () => {
  it('the executor is the thread’s home agent, whoever proposes; forging it is refused', async () => {
    const oid = await proposed('reply', { text: 'Thursday works.' }, AGENTS.star);
    expect(await outcome(oid)).toMatchObject({
      state: 'proposed',
      executor: AGENTS.a,
      proposedBy: AGENTS.star,
    });
    expect((await thread()).state).toBe('yourCall');
    const s = as(AGENTS.star);
    const p = proposeOutcome(s.ctx, {
      threadId: 'itr1',
      thread: await thread(),
      type: 'reply',
      fields: { text: 'x' },
    });
    const forge = (over: Record<string, unknown>) =>
      s.run(
        p.ops.map((op) =>
          op.path === O(p.outcomeId) ? { ...op, data: { ...op.data, ...over } } : op,
        ),
      );
    await denied(forge({ executor: AGENTS.star }));
    await denied(forge({ state: 'approved' }));
    await denied(forge({ type: 'launch_rockets' }));
    await denied(forge({ fields: { text: 'x', bcc: 'everyone' } }));
    await denied(forge({ fields: {} }));
    await ok(s.run(p));
  });

  it('nothing is carried out before approval: agents cannot approve or report a proposal', async () => {
    const oid = await proposed('reply', { text: 'Thursday works.' });
    const a = as(AGENTS.a);
    const o = await outcome(oid);
    const t = await thread();
    expect(() =>
      finishOutcome(a.ctx, {
        outcomeId: oid,
        outcome: o,
        thread: t,
        status: 'done',
      }),
    ).toThrow(/approve/);
    await denied(
      a.run(
        raw(
          a,
          O(oid),
          {
            state: 'done',
            result: {
              text: null,
              permalink: null,
              itemId: null,
              error: null,
              by: AGENTS.a,
              at: SERVER_TIME,
            },
          },
          'outcome.done',
          { outcomeId: oid },
        ),
      ),
    );
    await denied(
      a.run(
        raw(
          a,
          O(oid),
          {
            state: 'approved',
            decision: { byUid: 'alice', at: SERVER_TIME, edited: false, reason: null },
          },
          'outcome.proposed',
          { outcomeId: oid },
        ),
      ),
    );
    await denied(
      a.run(
        raw(
          a,
          O(oid),
          {
            state: 'approved',
            fields: { text: 'Thursday works.' },
            decision: { byUid: AGENTS.a, at: SERVER_TIME, edited: false, reason: null },
          },
          'outcome.approved',
          { outcomeId: oid },
        ),
      ),
    );
    // A person who is not the member, even an admin, cannot approve.
    for (const uid of ['bob', 'owner']) {
      const p = as(uid);
      await denied(
        p.run(
          approveOutcome(p.ctx, {
            outcomeId: oid,
            outcome: { ...o, memberUid: uid },
            thread: await thread(),
          }),
        ),
      );
    }
    expect((await outcome(oid)).state).toBe('proposed');
  });

  it('the member approves with an edit; only the executor reports it; the thread then waits on them', async () => {
    const oid = await proposed('reply', { text: 'Thursday works.' });
    const alice = as('alice');
    await ok(
      alice.run(
        approveOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
          fields: { text: 'Thursday 10:00 works.' },
        }),
      ),
    );
    expect(await outcome(oid)).toMatchObject({
      state: 'approved',
      fields: { text: 'Thursday 10:00 works.' },
      decision: { byUid: 'alice', edited: true },
    });
    const s = as(AGENTS.star);
    await denied(
      s.run(
        finishOutcome(s.ctx, {
          outcomeId: oid,
          outcome: { ...(await outcome(oid)), executor: AGENTS.star },
          thread: await thread(),
          status: 'done',
        }),
      ),
    );
    const a = as(AGENTS.a);
    // A wrong after-state is refused.
    const p = finishOutcome(a.ctx, {
      outcomeId: oid,
      outcome: await outcome(oid),
      thread: await thread(),
      status: 'done',
      result: { permalink: 'https://teams.example.com/m/2' },
    });
    await denied(
      a.run(
        p.ops.map((op) =>
          op.path === T('itr1')
            ? { ...op, data: { ...op.data, state: 'done', waiting: null } }
            : op,
        ),
      ),
    );
    await ok(a.run(p));
    expect(await outcome(oid)).toMatchObject({
      state: 'done',
      result: { permalink: 'https://teams.example.com/m/2', by: AGENTS.a },
    });
    expect(await thread()).toMatchObject({
      state: 'waiting',
      waiting: { on: 'them', until: null },
    });
    await denied(
      a.run(
        finishOutcome(a.ctx, {
          outcomeId: oid,
          outcome: { ...(await outcome(oid)), state: 'approved' },
          thread: await thread(),
          status: 'done',
        }),
      ),
    );
  });

  it('a failed outcome sends the thread back to investigating', async () => {
    const oid = await approved('make_it_work', { title: 'Fix the export' });
    const a = as(AGENTS.a);
    await ok(
      a.run(
        finishOutcome(a.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
          status: 'failed',
          result: { error: 'The project does not let agents create items.' },
        }),
      ),
    );
    expect(await outcome(oid)).toMatchObject({ state: 'failed' });
    expect((await thread()).state).toBe('investigating');
  });

  it('rejecting the last proposal sends the thread back to investigating', async () => {
    const oid = await proposed('reply', { text: 'No.' });
    const alice = as('alice');
    await ok(
      alice.run(
        rejectOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
          reason: 'Too short',
          othersPending: false,
        }),
      ),
    );
    expect(await outcome(oid)).toMatchObject({
      state: 'rejected',
      decision: { reason: 'Too short' },
    });
    expect((await thread()).state).toBe('investigating');
  });

  it('immediate types take effect on approval: snooze waits for its date, then wakes', async () => {
    const oid = await proposed('snooze', {
      until: '2099-01-01T09:00:00Z',
      reason: 'After the freeze',
    });
    expect((await outcome(oid)).executor).toBeNull();
    const alice = as('alice');
    await ok(
      alice.run(
        approveOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
        }),
      ),
    );
    expect((await outcome(oid)).state).toBe('done');
    const t = await thread();
    expect(t).toMatchObject({ state: 'waiting', waiting: { on: 'date' } });
    const a = as(AGENTS.a);
    expect(() => wakeThread(a.ctx, { threadId: 'itr1', thread: t, nowMs: Date.now() })).toThrow(
      /Not yet/,
    );
    await denied(
      a.run(raw(a, T('itr1'), { state: 'investigating', waiting: null }, 'thread.woke')),
    );
    await put({
      [T('itr1')]: {
        ...(await snap(T('itr1'))),
        waiting: { on: 'date', until: Timestamp.fromMillis(Date.now() - 60_000) },
      },
    });
    await ok(
      a.run(wakeThread(a.ctx, { threadId: 'itr1', thread: await thread(), nowMs: Date.now() })),
    );
    expect((await thread()).state).toBe('investigating');
  });

  it('no_reply closes the thread, ignore ignores it', async () => {
    await approved('no_reply', { reason: 'FYI only' });
    expect((await thread()).state).toBe('done');
    const a = as(AGENTS.a);
    await ok(a.run(msg(a, { messageDocId: 'im9', ref: 'r9', threadRef: 't9' })));
    const p = proposeOutcome(a.ctx, {
      threadId: 'itr9',
      thread: await thread('itr9'),
      type: 'ignore',
      fields: {},
    });
    await ok(a.run(p));
    const alice = as('alice');
    await ok(
      alice.run(
        approveOutcome(alice.ctx, {
          outcomeId: p.outcomeId,
          outcome: await outcome(p.outcomeId),
          thread: await thread('itr9'),
        }),
      ),
    );
    expect((await thread('itr9')).state).toBe('ignored');
  });
});

describe('the member: ignore, close, bring back, move', () => {
  it('only the member', async () => {
    await started();
    const alice = as('alice');
    const bob = as('bob');
    await denied(
      bob.run(
        ignoreThread(bob.ctx, {
          threadId: 'itr1',
          thread: { ...(await thread()), memberUid: 'bob' },
        }),
      ),
    );
    await ok(alice.run(ignoreThread(alice.ctx, { threadId: 'itr1', thread: await thread() })));
    const a = as(AGENTS.a);
    await denied(
      a.run(raw(a, T('itr1'), { state: 'investigating', waiting: null }, 'thread.restored')),
    );
    const ignored = await thread();
    expect(() =>
      proposeOutcome(a.ctx, {
        threadId: 'itr1',
        thread: ignored,
        type: 'reply',
        fields: { text: 'x' },
      }),
    ).toThrow(/ignored/);
    await ok(alice.run(restoreThread(alice.ctx, { threadId: 'itr1', thread: await thread() })));
    await ok(alice.run(closeThread(alice.ctx, { threadId: 'itr1', thread: await thread() })));
    expect((await thread()).state).toBe('done');
  });
});

describe('subjects: rename, merge, split, move (the member)', () => {
  async function twoFiled() {
    const a = await started();
    await ok(a.run(msg(a, { messageDocId: 'im2', ref: 'r2', threadRef: 't2' })));
    const f1 = assignSubject(a.ctx, {
      threadId: 'itr1',
      thread: await thread(),
      newName: 'Review date',
    });
    await ok(a.run(f1));
    const f2 = assignSubject(a.ctx, {
      threadId: 'itr2',
      thread: await thread('itr2'),
      newName: 'Review slot',
    });
    await ok(a.run(f2));
    return { s1: f1.subjectId, s2: f2.subjectId };
  }
  const sub = (name: string, memberUid = 'alice') => ({ memberUid, name });

  it('rename by the member only', async () => {
    const { s1 } = await twoFiled();
    const alice = as('alice');
    await ok(
      alice.run(
        renameSubject(alice.ctx, {
          subjectId: s1,
          subject: sub('Review date'),
          name: 'Review dates (Payments)',
        }),
      ),
    );
    for (const uid of ['bob', 'owner'])
      await denied(
        as(uid).run(
          renameSubject(as(uid).ctx, { subjectId: s1, subject: sub('x', uid), name: 'Mine' }),
        ),
      );
    const a = as(AGENTS.a);
    await denied(
      a.run(raw(a, S(s1), { name: 'Agent name' }, 'subject.renamed', {}, 'alice', null)),
    );
  });

  it('merge moves the threads and deletes the emptied subject; split and move', async () => {
    const { s1, s2 } = await twoFiled();
    const alice = as('alice');
    await ok(
      alice.run(
        mergeSubjects(alice.ctx, {
          fromId: s2,
          from: sub('Review slot'),
          intoId: s1,
          into: sub('Review date'),
          threadIds: ['itr2'],
        }),
      ),
    );
    expect((await thread('itr2')).subjectId).toBe(s1);
    expect(await snap(S(s2))).toEqual({});
    const sp = splitSubject(alice.ctx, {
      fromId: s1,
      from: sub('Review date'),
      name: 'Thursday slot',
      threadIds: ['itr2'],
    });
    await ok(alice.run(sp));
    expect((await thread('itr2')).subjectId).toBe(sp.subjectId);
    await ok(
      alice.run(
        moveThread(alice.ctx, { threadId: 'itr2', thread: await thread('itr2'), subjectId: s1 }),
      ),
    );
    const bob = as('bob');
    await denied(
      bob.run(
        mergeSubjects(bob.ctx, {
          fromId: sp.subjectId,
          from: sub('x', 'bob'),
          intoId: s1,
          into: sub('x', 'bob'),
          threadIds: [],
        }),
      ),
    );
    await denied(
      bob.run(
        splitSubject(bob.ctx, {
          fromId: s1,
          from: sub('x', 'bob'),
          name: 'Stolen',
          threadIds: ['itr1'],
        }),
      ),
    );
  });
});

describe('inbox events', () => {
  it('create-only; people cannot write agent types or for someone else', async () => {
    const a = await started();
    const alice = as('alice');
    const ev = (who: As, over: Record<string, unknown>): WriteOp[] => [
      {
        kind: 'set',
        path: inboxPaths.event(W, 'ev-y'),
        data: {
          actor: { type: who.ctx.actor.type, id: who.uid, name: 'x' },
          memberUid: 'alice',
          threadId: null,
          subjectId: null,
          type: 'subject.created',
          data: {},
          at: SERVER_TIME,
          ...over,
        },
      },
    ];
    await denied(alice.run(ev(alice, { type: 'outcome.done' })));
    await denied(alice.run(ev(alice, { type: 'thread.note' })));
    await denied(as('bob').run(ev(as('bob'), {})));
    await denied(a.run(ev(a, { type: 'outcome.approved' })));
    await ok(alice.run(ev(alice, {})));
    await denied(
      alice.run([{ kind: 'update', path: inboxPaths.event(W, 'ev-y'), data: { type: 'x' } }]),
    );
    await denied(alice.run([{ kind: 'delete', path: inboxPaths.event(W, 'ev-y') }]));
  });
});

describe('make it work (the member)', () => {
  const make = async (who: As, itemId: string, threadOwner = 'alice') => {
    const project = projectDoc() as unknown as Parameters<typeof createItem>[1]['project'];
    const item = createItem(who.ctx, {
      project,
      projectId: 'p1',
      itemId,
      title: 'Fix the refund export',
      type: 'task',
    });
    return makeItemFromThread(who.ctx, {
      threadId: 'itr1',
      thread: { memberUid: threadOwner, subjectId: null },
      item,
      projectId: 'p1',
      title: 'Fix the refund export',
    });
  };
  it('creates the item, linked on the thread, by the member only', async () => {
    await started();
    const alice = as('alice');
    const p = await make(alice, 'mw1');
    await ok(alice.run(p));
    expect((await snap(paths.item(W, 'p1', 'mw1'))).title).toBe('Fix the refund export');
    const ev = await snap(inboxPaths.event(W, p.eventId));
    expect(ev.type).toBe('thread.itemMade');
    expect((ev.data as { itemId: string }).itemId).toBe('mw1');
    // Another member of the project cannot link an item to alice's thread.
    const bob = as('bob');
    expect(() =>
      makeItemFromThread(bob.ctx, {
        threadId: 'itr1',
        thread: { memberUid: 'alice', subjectId: null },
        item: { itemId: 'x', eventId: 'e', ops: [] },
        projectId: 'p1',
        title: 'x',
      }),
    ).toThrow();
    await denied(bob.run(await make(bob, 'mw2', 'bob')));
    // The item must be made in the same batch by the member: an event alone is refused.
    await denied(
      alice.run([
        {
          kind: 'set',
          path: inboxPaths.event(W, 'ev-z'),
          data: {
            actor: { type: 'human', id: 'alice', name: 'Alice' },
            memberUid: 'alice',
            threadId: 'itr1',
            subjectId: null,
            type: 'thread.itemMade',
            data: { projectId: 'p1', itemId: 'nope', title: 'x' },
            at: SERVER_TIME,
          },
        },
      ]),
    );
  });
});
