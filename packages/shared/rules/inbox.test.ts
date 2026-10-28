/**
 * Inbox (item 4PEHrOW5IfXBQWgOK9wo): requests, subjects and their events are private to the
 * member they are for, plus the organization's agents. Nothing reaches `sending` without the
 * member's Send, and only the fetching agent marks a request sent.
 */
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { SERVER_TIME, type WriteOp } from '../src/actions';
import {
  addInboxRequest,
  assignSubject,
  draftReply,
  editDraft,
  ignoreRequest,
  inboxPaths,
  markSent,
  mergeSubjects,
  renameSubject,
  restoreRequest,
  sendReply,
  splitSubject,
  type InboxRequestState,
} from '../src/inbox';
import { paths } from '../src/schema';
import { AGENTS, as, denied, now, ok, put, snap, useEmulator, W, W2, type As } from './harness';

useEmulator();

const R = (rid: string) => inboxPaths.request(W, rid);
const S = (sid: string) => inboxPaths.subject(W, sid);

const add = (a: As, over: Partial<Parameters<typeof addInboxRequest>[1]> = {}) =>
  addInboxRequest(a.ctx, {
    requestId: 'rq1',
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

async function state(rid = 'rq1'): Promise<InboxRequestState> {
  return (await snap(R(rid))) as unknown as InboxRequestState;
}

/** A request for alice brought in by agentA, filed under a new subject and drafted. */
async function drafted(rid = 'rq1') {
  const a = as(AGENTS.a);
  await ok(a.run(add(a, { requestId: rid, messageId: `m-${rid}` })));
  const f = assignSubject(a.ctx, {
    requestId: rid,
    request: await state(rid),
    newName: 'Review date',
  });
  await ok(a.run(f));
  await ok(
    a.run(
      draftReply(a.ctx, { requestId: rid, request: await state(rid), reply: 'Thursday works.' }),
    ),
  );
  return { a, subjectId: f.subjectId };
}

/** Raw request update with an inbox event, for attacks the actions refuse to build. */
function raw(
  who: As,
  rid: string,
  data: Record<string, unknown>,
  type: string,
  member = 'alice',
): WriteOp[] {
  return [
    {
      kind: 'update',
      path: R(rid),
      data: { ...data, updatedAt: SERVER_TIME, lastEventId: 'ev-x' },
    },
    {
      kind: 'set',
      path: inboxPaths.event(W, 'ev-x'),
      data: {
        actor: { type: who.ctx.actor.type, id: who.uid, name: who.ctx.actor.name },
        memberUid: member,
        requestId: rid,
        subjectId: null,
        type,
        data: {},
        at: SERVER_TIME,
      },
    },
  ];
}

describe('an agent brings a request in', () => {
  it('for a member of its organization: new, unfiled, tracked in inboxEvents only', async () => {
    const a = as(AGENTS.a);
    const p = add(a);
    await ok(a.run(p));
    expect(await snap(R('rq1'))).toMatchObject({
      memberUid: 'alice',
      status: 'new',
      subjectId: null,
      fetchedBy: AGENTS.a,
      sender: { name: 'Sam Example', handle: 'sam@example.com' },
      draft: null,
      approved: null,
    });
    expect(await snap(inboxPaths.event(W, p.eventId))).toMatchObject({
      type: 'inbox.added',
      memberUid: 'alice',
      requestId: 'rq1',
    });
    // Never in the organization-wide events every member reads.
    expect(await snap(paths.event(W, p.eventId))).toEqual({});
  });

  it('an agent allowed on any project may add (inbox is not per project)', async () => {
    const a = as(AGENTS.star);
    await ok(a.run(add(a)));
  });

  it('refused: for someone outside the organization, by a revoked agent, by a person, twice', async () => {
    const a = as(AGENTS.a);
    await denied(a.run(add(a, { memberUid: 'eve' })));
    const r = as(AGENTS.revoked);
    await denied(r.run(add(r)));
    const alice = as('alice');
    await denied(
      alice.run(
        add({ ...alice, ctx: { ...alice.ctx, actor: { ...alice.ctx.actor, type: 'agent' } } }),
      ),
    );
    await ok(a.run(add(a)));
    // Same source + thread + message = same id: the second create is an update, refused.
    await denied(a.run(add(a)));
    await denied(as(AGENTS.star).run(add(as(AGENTS.star))));
  });

  it("refused: another organization's agent, also for reading", async () => {
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
    const a = as(AGENTS.a);
    await ok(a.run(add(a)));
    const other = as('agentOther', { workspaceId: W2 });
    await denied(
      other.run(
        addInboxRequest(
          { ...other.ctx, workspaceId: W },
          {
            requestId: 'rq2',
            memberUid: 'alice',
            source: 'mail',
            sender: { name: 'X' },
            text: 'Hi',
            threadRef: 't',
            messageId: 'm',
            receivedAt: new Date(),
          },
        ),
      ),
    );
    await denied(getDoc(doc(other.db, R('rq1'))));
  });

  it('refused: bad fields (status, fetchedBy, a subject, source)', async () => {
    const a = as(AGENTS.a);
    const p = add(a);
    const set = p.ops[0]!;
    const bad = (over: Record<string, unknown>) =>
      a.run([{ ...set, data: { ...set.data, ...over } }, p.ops[1]!]);
    await denied(bad({ status: 'yourCall' }));
    await denied(bad({ fetchedBy: AGENTS.star }));
    await denied(bad({ subjectId: 's1' }));
    await denied(bad({ source: 'Teams!' }));
    await denied(bad({ approved: { reply: 'x', actions: [], byUid: 'alice', at: SERVER_TIME } }));
    await ok(a.run(p));
  });
});

describe('who reads', () => {
  it('the member and the agents only; never another member, an admin or an outsider', async () => {
    const { subjectId } = await drafted();
    const alice = as('alice');
    await ok(getDoc(doc(alice.db, R('rq1'))));
    await ok(getDoc(doc(alice.db, S(subjectId))));
    const mine = await ok(
      getDocs(
        query(collection(alice.db, inboxPaths.requests(W)), where('memberUid', '==', 'alice')),
      ),
    );
    expect(mine.size).toBe(1);
    await ok(
      getDocs(query(collection(alice.db, inboxPaths.events(W)), where('memberUid', '==', 'alice'))),
    );
    await ok(
      getDocs(
        query(collection(alice.db, inboxPaths.subjects(W)), where('memberUid', '==', 'alice')),
      ),
    );
    // Unfiltered lists could include other people's requests: refused even for alice.
    await denied(getDocs(collection(alice.db, inboxPaths.requests(W))));

    for (const uid of ['bob', 'owner', 'eve']) {
      const p = as(uid);
      await denied(getDoc(doc(p.db, R('rq1'))));
      await denied(getDoc(doc(p.db, S(subjectId))));
      await denied(
        getDocs(query(collection(p.db, inboxPaths.requests(W)), where('memberUid', '==', 'alice'))),
      );
      await denied(
        getDocs(query(collection(p.db, inboxPaths.events(W)), where('memberUid', '==', 'alice'))),
      );
    }
    for (const uid of [AGENTS.a, AGENTS.star]) {
      const g = as(uid);
      await ok(getDoc(doc(g.db, R('rq1'))));
      await ok(getDocs(collection(g.db, inboxPaths.requests(W))));
      await ok(getDocs(collection(g.db, inboxPaths.subjects(W))));
      await ok(getDocs(collection(g.db, inboxPaths.events(W))));
    }
    await denied(getDoc(doc(as(AGENTS.revoked).db, R('rq1'))));
  });
});

describe('filing and drafting (agents)', () => {
  it('files under a new subject, then an existing one; drafts; re-drafts at Your call', async () => {
    const a = as(AGENTS.a);
    await ok(a.run(add(a)));
    const f = assignSubject(a.ctx, {
      requestId: 'rq1',
      request: await state(),
      newName: '  Review   date ',
    });
    await ok(a.run(f));
    expect(await snap(S(f.subjectId))).toMatchObject({ memberUid: 'alice', name: 'Review date' });
    expect(await state()).toMatchObject({ status: 'drafting', subjectId: f.subjectId });

    await ok(a.run(add(a, { requestId: 'rq2', messageId: 'm-2' })));
    const g = assignSubject(a.ctx, {
      requestId: 'rq2',
      request: await state('rq2'),
      subjectId: f.subjectId,
    });
    await ok(a.run(g));
    expect(g.created).toBe(false);

    await ok(
      a.run(
        draftReply(a.ctx, {
          requestId: 'rq1',
          request: await state(),
          reply: 'Thursday works.',
          actions: ['book Thu 10:00 with Sam'],
        }),
      ),
    );
    expect(await state()).toMatchObject({
      status: 'yourCall',
      draft: {
        reply: 'Thursday works.',
        actions: ['book Thu 10:00 with Sam'],
        by: { type: 'agent', id: AGENTS.a },
      },
    });
    // Another agent of the organization may revise it.
    const s = as(AGENTS.star);
    await ok(
      s.run(
        draftReply(s.ctx, {
          requestId: 'rq1',
          request: await state(),
          reply: 'Thursday at 10 works.',
        }),
      ),
    );
  });

  it("refused: filing under another member's subject, drafting before filing, a person filing", async () => {
    const a = as(AGENTS.a);
    await ok(a.run(add(a)));
    await ok(a.run(add(a, { requestId: 'rqb', messageId: 'm-b', memberUid: 'bob' })));
    const bobs = assignSubject(a.ctx, {
      requestId: 'rqb',
      request: await state('rqb'),
      newName: 'Bob things',
    });
    await ok(a.run(bobs));
    await denied(
      a.run(
        assignSubject(a.ctx, {
          requestId: 'rq1',
          request: await state(),
          subjectId: bobs.subjectId,
        }),
      ),
    );
    // The action refuses to draft unfiled; a hand-built draft is refused too.
    const unfiled = await state();
    expect(() => draftReply(a.ctx, { requestId: 'rq1', request: unfiled, reply: 'x' })).toThrow(
      /subject/,
    );
    await denied(
      a.run(
        raw(
          a,
          'rq1',
          {
            status: 'yourCall',
            draft: {
              reply: 'x',
              actions: [],
              by: { type: 'agent', id: AGENTS.a },
              at: SERVER_TIME,
            },
          },
          'inbox.drafted',
        ),
      ),
    );
  });
});

describe('Send: only the member, only as drafted', () => {
  it('the member edits, sends; the fetching agent marks it sent', async () => {
    const { a } = await drafted();
    const alice = as('alice');
    await ok(
      alice.run(
        editDraft(alice.ctx, {
          requestId: 'rq1',
          request: await state(),
          reply: 'Thursday 10:00 is fine.',
        }),
      ),
    );
    expect(await state()).toMatchObject({
      status: 'yourCall',
      draft: { reply: 'Thursday 10:00 is fine.', by: { type: 'human', id: 'alice' } },
    });
    await ok(alice.run(sendReply(alice.ctx, { requestId: 'rq1', request: await state() })));
    expect(await state()).toMatchObject({
      status: 'sending',
      approved: { reply: 'Thursday 10:00 is fine.', byUid: 'alice' },
    });
    // Another agent of the organization cannot mark it sent: only the one that fetched it.
    const s = as(AGENTS.star);
    await denied(
      s.run(
        markSent(
          { ...s.ctx },
          { requestId: 'rq1', request: { ...(await state()), fetchedBy: AGENTS.star } },
        ),
      ),
    );
    await ok(
      a.run(
        markSent(a.ctx, {
          requestId: 'rq1',
          request: await state(),
          permalink: 'https://teams.example.com/m/2',
        }),
      ),
    );
    expect(await state()).toMatchObject({
      status: 'done',
      sent: { permalink: 'https://teams.example.com/m/2', by: AGENTS.a },
    });
    // Done is done: no second send, no edit, no ignore.
    await denied(alice.run(raw(alice, 'rq1', { status: 'sending' }, 'inbox.approved')));
    const done = await state();
    expect(() => ignoreRequest(alice.ctx, { requestId: 'rq1', request: done })).toThrow(/done/);
    await denied(alice.run(raw(alice, 'rq1', { status: 'ignored' }, 'inbox.ignored')));
  });

  it('no path sends without Send: agents cannot approve, move to sending or mark unapproved sent', async () => {
    const { a } = await drafted();
    const st = await state();
    // markSent before Send: the action refuses, a hand-built one is refused by the rules.
    expect(() => markSent(a.ctx, { requestId: 'rq1', request: st })).toThrow(/Send/);
    await denied(
      a.run(
        raw(
          a,
          'rq1',
          { status: 'done', sent: { permalink: null, by: AGENTS.a, at: SERVER_TIME } },
          'inbox.sent',
        ),
      ),
    );
    // An agent writing the member's approval itself.
    await denied(
      a.run(
        raw(
          a,
          'rq1',
          {
            status: 'sending',
            approved: { reply: 'Thursday works.', actions: [], byUid: 'alice', at: SERVER_TIME },
          },
          'inbox.drafted',
        ),
      ),
    );
    await denied(
      a.run(
        raw(
          a,
          'rq1',
          {
            status: 'sending',
            approved: { reply: 'Thursday works.', actions: [], byUid: 'alice', at: SERVER_TIME },
          },
          'inbox.approved',
        ),
      ),
    );
    await denied(a.run(raw(a, 'rq1', { status: 'sending' }, 'inbox.drafted')));
    // The member's Send must approve exactly the draft.
    const alice = as('alice');
    await denied(
      alice.run(
        raw(
          alice,
          'rq1',
          {
            status: 'sending',
            approved: { reply: 'Something else', actions: [], byUid: 'alice', at: SERVER_TIME },
          },
          'inbox.approved',
        ),
      ),
    );
    expect((await state()).status).toBe('yourCall');
  });

  it('refused: another member or an admin sends, edits or ignores', async () => {
    await drafted();
    const st = await state();
    for (const uid of ['bob', 'owner']) {
      const p = as(uid);
      // The actions refuse; pretend the request were theirs to get a plan the rules must refuse.
      expect(() => sendReply(p.ctx, { requestId: 'rq1', request: st })).toThrow(/person/);
      const fake = { ...st, memberUid: uid };
      await denied(p.run(sendReply(p.ctx, { requestId: 'rq1', request: fake })));
      await denied(p.run(editDraft(p.ctx, { requestId: 'rq1', request: fake, reply: 'No' })));
      await denied(p.run(ignoreRequest(p.ctx, { requestId: 'rq1', request: fake })));
    }
    expect((await state()).status).toBe('yourCall');
  });

  it('ignore and bring back', async () => {
    await drafted();
    const alice = as('alice');
    await ok(alice.run(ignoreRequest(alice.ctx, { requestId: 'rq1', request: await state() })));
    expect((await state()).status).toBe('ignored');
    // An agent cannot draft or send an ignored request.
    const a = as(AGENTS.a);
    await denied(
      a.run(
        raw(
          a,
          'rq1',
          {
            status: 'yourCall',
            draft: {
              reply: 'x',
              actions: [],
              by: { type: 'agent', id: AGENTS.a },
              at: SERVER_TIME,
            },
          },
          'inbox.drafted',
        ),
      ),
    );
    await ok(alice.run(restoreRequest(alice.ctx, { requestId: 'rq1', request: await state() })));
    expect((await state()).status).toBe('yourCall');
  });
});

describe('subjects: rename, merge, split (the member)', () => {
  it('rename by the member; refused for another member, an admin and agents', async () => {
    const { subjectId } = await drafted();
    const sub = { memberUid: 'alice', name: 'Review date' };
    const alice = as('alice');
    await ok(
      alice.run(
        renameSubject(alice.ctx, { subjectId, subject: sub, name: 'Review dates (Payments)' }),
      ),
    );
    expect(await snap(S(subjectId))).toMatchObject({ name: 'Review dates (Payments)' });
    for (const uid of ['bob', 'owner']) {
      const p = as(uid);
      await denied(
        p.run(
          renameSubject(p.ctx, {
            subjectId,
            subject: { ...sub, memberUid: uid },
            name: 'Mine now',
          }),
        ),
      );
    }
    const a = as(AGENTS.a);
    const human = { ...a.ctx, actor: { ...a.ctx.actor, type: 'human' as const } };
    await denied(
      a.run(
        renameSubject(human, {
          subjectId,
          subject: { ...sub, memberUid: AGENTS.a },
          name: 'Agent name',
        }),
      ),
    );
  });

  it('merge moves the requests and deletes the emptied subject; split makes a new one', async () => {
    const one = await drafted('rq1');
    const two = await drafted('rq2');
    const alice = as('alice');
    const subA = { memberUid: 'alice', name: 'Review date' };
    await ok(
      alice.run(
        mergeSubjects(alice.ctx, {
          fromId: two.subjectId,
          from: subA,
          intoId: one.subjectId,
          into: subA,
          requestIds: ['rq2'],
        }),
      ),
    );
    expect((await state('rq2')).subjectId).toBe(one.subjectId);
    expect(await snap(S(two.subjectId))).toEqual({});

    const sp = splitSubject(alice.ctx, {
      fromId: one.subjectId,
      from: subA,
      name: 'Thursday slot',
      requestIds: ['rq2'],
    });
    await ok(alice.run(sp));
    expect((await state('rq2')).subjectId).toBe(sp.subjectId);
    expect(await snap(S(sp.subjectId))).toMatchObject({
      memberUid: 'alice',
      name: 'Thursday slot',
      createdBy: { type: 'human', id: 'alice' },
    });
  });

  it("refused: merging or splitting someone else's subjects", async () => {
    const one = await drafted('rq1');
    const two = await drafted('rq2');
    const bob = as('bob');
    const subB = { memberUid: 'bob', name: 'x' };
    await denied(
      bob.run(
        mergeSubjects(bob.ctx, {
          fromId: two.subjectId,
          from: subB,
          intoId: one.subjectId,
          into: subB,
          requestIds: ['rq2'],
        }),
      ),
    );
    await denied(
      bob.run(
        splitSubject(bob.ctx, {
          fromId: one.subjectId,
          from: subB,
          name: 'Stolen',
          requestIds: ['rq1'],
        }),
      ),
    );
    expect((await state('rq2')).subjectId).toBe(two.subjectId);
  });
});

describe('inbox events', () => {
  it('create-only; people cannot write agent types or for someone else', async () => {
    const { a } = await drafted();
    const alice = as('alice');
    const ev = (who: As, over: Record<string, unknown>): WriteOp[] => [
      {
        kind: 'set',
        path: inboxPaths.event(W, 'ev-y'),
        data: {
          actor: { type: who.ctx.actor.type, id: who.uid, name: 'x' },
          memberUid: 'alice',
          requestId: null,
          subjectId: null,
          type: 'subject.created',
          data: {},
          at: SERVER_TIME,
          ...over,
        },
      },
    ];
    await denied(alice.run(ev(alice, { type: 'inbox.sent' })));
    const bob = as('bob');
    await denied(bob.run(ev(bob, {})));
    await denied(a.run(ev(a, { type: 'inbox.approved' })));
    await ok(alice.run(ev(alice, {})));
    await denied(
      alice.run([
        { kind: 'update', path: inboxPaths.event(W, 'ev-y'), data: { type: 'inbox.sent' } },
      ]),
    );
    await denied(alice.run([{ kind: 'delete', path: inboxPaths.event(W, 'ev-y') }]));
  });
});
