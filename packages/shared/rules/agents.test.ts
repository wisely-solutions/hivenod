/**
 * SPEC §5.1 agent rules: revocation, the agent's own doc and presence. Projects were removed
 * (OE8Fm slice 11): an old CLI's item tools (claim, heartbeat, complete, log, attach, note,
 * finding) are refused, and nobody reads the old project data.
 */
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { SERVER_TIME, type WriteOp } from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, as, denied, eventOp, LEGACY, ok, useEmulator, W } from './harness';

useEmulator();

describe('agent scoping and revocation', () => {
  it('ATTACK: denies a revoked agent every read', async () => {
    const r = as(AGENTS.revoked);
    await denied(getDoc(doc(r.db, paths.workspace(W))));
    await denied(getDoc(doc(r.db, paths.agent(W, AGENTS.revoked))));
    await denied(getDoc(doc(r.db, paths.event(W, 'seed'))));
  });
  it('ATTACK: denies a revoked agent every write', async () => {
    const r = as(AGENTS.revoked);
    await denied(r.run([eventOp(r, 'e-rev')]));
    await denied(
      updateDoc(doc(r.db, paths.agent(W, AGENTS.revoked)), { lastSeenAt: serverTimestamp() }),
    );
  });
  it('denies an agent reading other workspace data it has no doc in', async () => {
    const a = as(AGENTS.a);
    await denied(getDoc(doc(a.db, paths.workspace('w2'))));
  });
  it('allows an agent its own agent doc and presence stamp, not other agents', async () => {
    const a = as(AGENTS.a);
    await ok(getDoc(doc(a.db, paths.agent(W, AGENTS.a))));
    await denied(getDoc(doc(a.db, paths.agent(W, AGENTS.star))));
    await ok(updateDoc(doc(a.db, paths.agent(W, AGENTS.a)), { lastSeenAt: serverTimestamp() }));
  });
  it('allows presence with the host name; ATTACK: not a long or non-string host', async () => {
    const a = as(AGENTS.a);
    const ref = doc(a.db, paths.agent(W, AGENTS.a));
    await ok(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 'laptop' }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 'x'.repeat(81) }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 5 }));
  });
  it('allows the agent to write its own CLI version with presence; ATTACK: not long, not a number, not without presence, not another agent', async () => {
    const a = as(AGENTS.a);
    const ref = doc(a.db, paths.agent(W, AGENTS.a));
    await ok(
      updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 'laptop', cliVersion: '0.2.170' }),
    );
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), cliVersion: 'x'.repeat(41) }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), cliVersion: 5 }));
    await denied(updateDoc(ref, { cliVersion: '0.2.170' }));
    await denied(
      updateDoc(doc(a.db, paths.agent(W, AGENTS.star)), {
        lastSeenAt: serverTimestamp(),
        cliVersion: '9.9.9',
      }),
    );
    // A member (not the agent) cannot forge it either.
    for (const who of ['alice', 'bob']) {
      const m = as(who);
      await denied(updateDoc(doc(m.db, paths.agent(W, AGENTS.a)), { cliVersion: '9.9.9' }));
    }
  });
  it('allows the agent its own session and host id with presence (item N0biX); ATTACK: not long, not a number, not without presence, not another agent, not a member', async () => {
    const a = as(AGENTS.a);
    const ref = doc(a.db, paths.agent(W, AGENTS.a));
    const ids = { seenSession: 's'.repeat(24), seenHostId: 'h'.repeat(32) };
    await ok(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHost: 'box', ...ids }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenSession: 'x'.repeat(65) }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHostId: 'x'.repeat(65) }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenSession: 5 }));
    await denied(updateDoc(ref, { lastSeenAt: serverTimestamp(), seenHostId: 5 }));
    await denied(updateDoc(ref, { seenSession: 'other' }));
    await denied(updateDoc(ref, { seenHostId: 'other' }));
    await denied(
      updateDoc(doc(a.db, paths.agent(W, AGENTS.star)), { lastSeenAt: serverTimestamp(), ...ids }),
    );
    for (const who of ['alice', 'bob', 'owner']) {
      const m = as(who);
      await denied(updateDoc(doc(m.db, paths.agent(W, AGENTS.a)), { seenSession: 'forged' }));
    }
  });
  it('ATTACK: denies an agent widening its own projectIds or un-revoking', async () => {
    const a = as(AGENTS.a);
    await denied(updateDoc(doc(a.db, paths.agent(W, AGENTS.a)), { projectIds: '*' }));
    const r = as(AGENTS.revoked);
    await denied(updateDoc(doc(r.db, paths.agent(W, AGENTS.revoked)), { revokedAt: null }));
  });
});

describe('Projects removed: an old CLI is refused, old data is unreadable', () => {
  /** The batch an old CLI's claim tool wrote: the item, a run and an item.claimed event. */
  function oldClaim(uid: string): WriteOp[] {
    const a = as(uid);
    return [
      {
        kind: 'update',
        path: LEGACY.item,
        data: {
          status: 'working',
          claim: { runId: 'r9', agentUid: uid, heartbeatAt: SERVER_TIME },
          lastEventId: 'e-claim',
        },
      },
      {
        kind: 'set',
        path: `workspaces/${W}/runs/r9`,
        data: {
          agentUid: uid,
          projectId: 'p1',
          itemId: 'i1',
          endedAt: null,
          lastEventId: 'e-claim',
        },
      },
      eventOp(a, 'e-claim', { projectId: 'p1', itemId: 'i1', runId: 'r9', type: 'item.claimed' }),
    ];
  }

  it('ATTACK: refuses an old CLI claiming, logging, noting or raising a finding', async () => {
    for (const uid of [AGENTS.a, AGENTS.star]) {
      const a = as(uid);
      await denied(a.run(oldClaim(uid)));
      await denied(a.run([eventOp(a, 'e-fin', { projectId: 'p1', type: 'finding.raised' })]));
      await denied(
        a.run([eventOp(a, 'e-msg', { projectId: 'p1', itemId: 'i1', type: 'message.posted' })]),
      );
      await denied(
        setDoc(doc(a.db, `${LEGACY.run}/log/0`), {
          at: serverTimestamp(),
          level: 'info',
          text: 'x',
        }),
      );
      await denied(updateDoc(doc(a.db, LEGACY.run), { heartbeatAt: serverTimestamp() }));
    }
  });

  it('ATTACK: nobody reads or writes projects, items, runs, the calendar or busy blocks', async () => {
    for (const uid of ['owner', 'alice', 'dave', AGENTS.a, AGENTS.star]) {
      const x = as(uid);
      for (const path of [LEGACY.project, LEGACY.item, LEGACY.run, LEGACY.calendar]) {
        await denied(getDoc(doc(x.db, path)));
        await denied(updateDoc(doc(x.db, path), { lastEventId: 'x' }));
      }
      await denied(setDoc(doc(x.db, `workspaces/${W}/projects/p9`), { name: 'New' }));
    }
    const alice = as('alice');
    await denied(getDoc(doc(alice.db, LEGACY.busy)));
  });

  it('old project events: admins still read them (export), members and agents do not; none are written', async () => {
    await ok(getDoc(doc(as('owner').db, LEGACY.projectEvent)));
    await denied(getDoc(doc(as('alice').db, LEGACY.projectEvent)));
    await denied(getDoc(doc(as(AGENTS.star).db, LEGACY.projectEvent)));
    const owner = as('owner');
    await denied(
      owner.run([eventOp(owner, 'e-proj', { projectId: 'p1', type: 'project.created' })]),
    );
    await denied(owner.run([eventOp(owner, 'e-item', { type: 'item.created' })]));
    await ok(getDoc(doc(as('alice').db, paths.event(W, 'seed'))));
  });
});
