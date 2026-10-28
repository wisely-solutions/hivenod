/**
 * Related subjects (item 4PEHrOW5IfXBQWgOK9wo): an agent proposes a link between two of a
 * member's subjects; only that member relates, accepts, turns down or removes it. Private like
 * the rest of Inbox.
 */
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { SERVER_TIME, type WriteOp } from '../src/actions';
import {
  inboxPaths,
  proposeRelation,
  rejectRelation,
  relateSubjects,
  unrelateSubjects,
  type RelationStateOf,
} from '../src/inbox';
import { AGENTS, as, denied, now, ok, put, snap, useEmulator, W, type As } from './harness';

useEmulator();

const R = (rid: string) => inboxPaths.relation(W, rid);
const subject = (memberUid: string, name: string) => ({
  memberUid,
  name,
  createdBy: { type: 'agent', id: AGENTS.a },
  createdAt: now(),
  updatedAt: now(),
  lastEventId: 'seed',
});
async function seed() {
  await put({
    [inboxPaths.subject(W, 'sa')]: subject('alice', 'Klarna refunds'),
    [inboxPaths.subject(W, 'sb')]: subject('alice', 'Klarna payouts'),
    [inboxPaths.subject(W, 'sc')]: subject('alice', 'Grafana'),
    [inboxPaths.subject(W, 'sx')]: subject('bob', 'Bob things'),
  });
}
const A = { memberUid: 'alice' };
const rel = async (rid = 'rel-sa-sb') => (await snap(R(rid))) as unknown as RelationStateOf;
const propose = (a: As, x = 'sb', y = 'sa', existing: RelationStateOf | null = null) =>
  proposeRelation(a.ctx, { a: x, b: y, subjectA: A, subjectB: A, existing, note: 'same client' });

/** A raw relation write plus its event, for attacks the actions refuse to build. */
function raw(
  who: As,
  kind: 'set' | 'update',
  rid: string,
  data: Record<string, unknown>,
  type: string,
  member = 'alice',
): WriteOp[] {
  return [
    {
      kind,
      path: R(rid),
      data: {
        ...data,
        ...(kind === 'update' ? { updatedAt: SERVER_TIME } : {}),
        lastEventId: 'ev-r',
      },
    },
    {
      kind: 'set',
      path: inboxPaths.event(W, 'ev-r'),
      data: {
        actor: { type: who.ctx.actor.type, id: who.uid, name: who.ctx.actor.name },
        memberUid: member,
        threadId: null,
        subjectId: null,
        type,
        data: { relationId: rid },
        at: SERVER_TIME,
      },
    },
  ];
}

describe('related subjects', () => {
  it('an agent proposes; the member accepts; it is private to the member and the agents', async () => {
    await seed();
    const a = as(AGENTS.a);
    const p = propose(a);
    expect(p.relationId).toBe('rel-sa-sb');
    await ok(a.run(p));
    expect(await snap(R('rel-sa-sb'))).toMatchObject({
      a: 'sa',
      b: 'sb',
      state: 'proposed',
      note: 'same client',
    });
    const alice = as('alice');
    await ok(getDoc(doc(alice.db, R('rel-sa-sb'))));
    await ok(
      getDocs(
        query(
          collection(alice.db, `workspaces/${W}/inboxRelations`),
          where('memberUid', '==', 'alice'),
        ),
      ),
    );
    for (const uid of ['bob', 'owner', 'eve'])
      await denied(getDoc(doc(as(uid).db, R('rel-sa-sb'))));
    await ok(getDocs(collection(as(AGENTS.star).db, `workspaces/${W}/inboxRelations`)));
    await denied(getDoc(doc(as(AGENTS.revoked).db, R('rel-sa-sb'))));
    // Only the member decides.
    const accept = (who: As) =>
      relateSubjects(who.ctx, {
        a: 'sa',
        b: 'sb',
        subjectA: A,
        subjectB: A,
        existing: { ...A, a: 'sa', b: 'sb', note: 'same client', state: 'proposed' },
      });
    await denied(
      as('bob').run(
        raw(
          as('bob'),
          'update',
          'rel-sa-sb',
          { state: 'related', decision: { byUid: 'bob', at: SERVER_TIME } },
          'relation.accepted',
          'bob',
        ),
      ),
    );
    await denied(
      a.run(
        raw(
          a,
          'update',
          'rel-sa-sb',
          { state: 'related', decision: { byUid: AGENTS.a, at: SERVER_TIME } },
          'relation.accepted',
        ),
      ),
    );
    await ok(alice.run(accept(alice)));
    expect(await snap(R('rel-sa-sb'))).toMatchObject({
      state: 'related',
      decision: { byUid: 'alice' },
    });
    // Removing it leaves it turned down, so it is not proposed again.
    await ok(
      alice.run(unrelateSubjects(alice.ctx, { relationId: 'rel-sa-sb', relation: await rel() })),
    );
    expect((await rel()).state).toBe('rejected');
    await denied(
      a.run(
        raw(
          a,
          'set',
          'rel-sa-sb',
          {
            memberUid: 'alice',
            a: 'sa',
            b: 'sb',
            note: '',
            state: 'proposed',
            proposedBy: { type: 'agent', id: AGENTS.a },
            decision: null,
            createdAt: SERVER_TIME,
            updatedAt: SERVER_TIME,
          },
          'relation.proposed',
        ),
      ),
    );
    // The member relates it again.
    await ok(
      alice.run(
        relateSubjects(alice.ctx, {
          a: 'sa',
          b: 'sb',
          subjectA: A,
          subjectB: A,
          existing: await rel(),
        }),
      ),
    );
    expect((await rel()).state).toBe('related');
  });

  it('the member turns a proposal down, or links two subjects directly', async () => {
    await seed();
    const a = as(AGENTS.a);
    await ok(a.run(propose(a, 'sc', 'sa')));
    const alice = as('alice');
    await denied(
      as('bob').run(
        rejectRelation(as('bob').ctx, {
          relationId: 'rel-sa-sc',
          relation: { ...(await rel('rel-sa-sc')), memberUid: 'bob' },
        }),
      ),
    );
    await ok(
      alice.run(
        rejectRelation(alice.ctx, { relationId: 'rel-sa-sc', relation: await rel('rel-sa-sc') }),
      ),
    );
    expect((await rel('rel-sa-sc')).state).toBe('rejected');
    const direct = relateSubjects(alice.ctx, {
      a: 'sc',
      b: 'sb',
      subjectA: A,
      subjectB: A,
      existing: null,
      note: 'both money',
    });
    await ok(alice.run(direct));
    expect(await snap(R('rel-sb-sc'))).toMatchObject({
      state: 'related',
      proposedBy: { type: 'human', id: 'alice' },
    });
  });

  it('refused: another member’s subject, a wrong id, out of order, by an outsider or a revoked agent', async () => {
    await seed();
    const a = as(AGENTS.a);
    // A subject of bob's with one of alice's (the action would refuse; forge it).
    const mixed = proposeRelation(a.ctx, {
      a: 'sa',
      b: 'sx',
      subjectA: A,
      subjectB: A,
      existing: null,
    });
    await denied(a.run(mixed));
    const body = {
      memberUid: 'alice',
      a: 'sa',
      b: 'sb',
      note: '',
      state: 'proposed',
      proposedBy: { type: 'agent', id: AGENTS.a },
      decision: null,
      createdAt: SERVER_TIME,
      updatedAt: SERVER_TIME,
    };
    await denied(a.run(raw(a, 'set', 'rel-other', body, 'relation.proposed')));
    await denied(
      a.run(raw(a, 'set', 'rel-sb-sa', { ...body, a: 'sb', b: 'sa' }, 'relation.proposed')),
    );
    await denied(
      a.run(raw(a, 'set', 'rel-sa-sb', { ...body, state: 'related' }, 'relation.proposed')),
    );
    await denied(as(AGENTS.revoked).run(propose(as(AGENTS.revoked))));
    const bob = as('bob');
    await denied(
      bob.run(
        relateSubjects(bob.ctx, {
          a: 'sa',
          b: 'sb',
          subjectA: { memberUid: 'bob' },
          subjectB: { memberUid: 'bob' },
          existing: null,
        }),
      ),
    );
    await ok(a.run(propose(a)));
  });
});
