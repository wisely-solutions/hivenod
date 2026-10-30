/**
 * Deleting an organization (card 9jpb1Q4a): an admin flags it, then removes everything under it
 * document by document. Nothing is deletable before the flag, nobody but an admin can set it or
 * delete, and once it is set no new event (so no other domain write) can be written.
 */
import { deleteDoc, doc, getDoc } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { beginOrgDelete, renameWorkspace } from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, as, denied, eventOp, LEGACY, ok, put, useEmulator, W } from './harness';

useEmulator();

const flag = () => put({ [paths.workspace(W)]: flaggedWs() });
function flaggedWs() {
  return {
    name: 'Hive',
    ownerUid: 'owner',
    adminUids: ['owner'],
    memberRoles: {
      owner: 'admin',
      alice: 'member',
      bob: 'member',
      carol: 'member',
      dave: 'member',
    },
    createdAt: new Date(),
    lastEventId: 'seed',
    deletingAt: new Date(),
    deletingBy: 'owner',
  };
}
const del = (uid: string, path: string) => deleteDoc(doc(as(uid).db, path));

describe('starting the delete', () => {
  it('lets an admin set the flag with its event', async () => {
    const o = as('owner');
    await ok(o.run(beginOrgDelete(o.ctx)));
  });
  it('refuses a member and an agent', async () => {
    const a = as('alice');
    await denied(a.run(beginOrgDelete(a.ctx)));
    const g = as(AGENTS.star);
    // An agent token pretending to be a person is refused too.
    await denied(g.run(beginOrgDelete({ ...g.ctx, actor: { ...g.ctx.actor, type: 'human' } })));
  });
  it('refuses a flag set without the event, or with someone else named', async () => {
    const o = as('owner');
    await denied(
      o.run([
        {
          kind: 'update',
          path: paths.workspace(W),
          data: { deletingAt: new Date(), deletingBy: 'owner', lastEventId: 'seed' },
        },
      ]),
    );
  });
  it('keeps renaming working while not flagged', async () => {
    const o = as('owner');
    await ok(o.run(renameWorkspace(o.ctx, { name: 'New' })));
  });
});

describe('before the flag nothing under the organization can be deleted', () => {
  for (const [what, path] of [
    ['event', paths.event(W, 'seed')],
    ['agent', paths.agent(W, AGENTS.a)],
    ['member card', paths.member(W, 'alice')],
    ['organization', paths.workspace(W)],
  ] as const) {
    it(`refuses the admin deleting a ${what}`, async () => {
      await denied(del('owner', path));
    });
  }
});

describe('after the flag', () => {
  it('lets an admin delete every kind of document, the organization last', async () => {
    await flag();
    await put({ [`${LEGACY.run}/log/1`]: { text: 'x' } });
    // Old Projects data still under the organization can go too (the deletion script normally
    // removes it first).
    for (const path of [
      `${LEGACY.run}/log/1`,
      LEGACY.run,
      LEGACY.item,
      LEGACY.project,
      LEGACY.calendar,
      LEGACY.projectEvent,
      paths.group(W, 'g1'),
      paths.agent(W, AGENTS.a),
      paths.event(W, 'seed'),
    ])
      await ok(del('owner', path));
    await ok(del('owner', paths.workspace(W)));
  });
  it('refuses members, outsiders and agents', async () => {
    await flag();
    for (const uid of ['alice', 'dave', 'eve', AGENTS.star, AGENTS.a]) {
      await denied(del(uid, LEGACY.item));
      await denied(del(uid, LEGACY.project));
      await denied(del(uid, paths.agent(W, AGENTS.a)));
      await denied(del(uid, paths.workspace(W)));
    }
  });
  it('does not reach into another organization', async () => {
    await flag();
    await denied(del('owner', paths.workspace('w2')));
  });
  it('refuses every new event, so no other write goes through', async () => {
    await flag();
    const a = as('alice');
    await denied(a.run([eventOp(a, 'late')]));
    const o = as('owner');
    await denied(o.run(renameWorkspace(o.ctx, { name: 'Late' })));
  });
  it('still lets members read the flag, so their screens can react', async () => {
    await flag();
    await ok(getDoc(doc(as('alice').db, paths.workspace(W))));
  });
});

describe('the leftover first-run record', () => {
  it('can be removed by its owner once the organization is gone, not before', async () => {
    await put({
      [`users/alice/firstrun/${W}`]: { dismissed: false, project: true, idea: false, agent: false },
    });
    await denied(del('alice', `users/alice/firstrun/${W}`));
    await put({
      [`users/alice/firstrun/gone`]: { dismissed: false, project: true, idea: false, agent: false },
    });
    await ok(del('alice', `users/alice/firstrun/gone`));
    await denied(del('bob', `users/alice/firstrun/gone`));
  });
});
