/**
 * Delete an item for good (Delete… in an item menu): the item with its messages, files and runs.
 * Only its creator or an organization admin, never an agent, never while an agent holds it, and the
 * history keeps one "deleted" line. The children cannot be deleted on their own.
 */
import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { deleteItem, type ItemState } from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, as, denied, I, itemDoc, ok, put, snap, useEmulator, W, type As } from './harness';

useEmulator();

const R = (rid: string) => paths.run(W, rid);
const A = (aid: string) => paths.attachment(W, 'p1', 'i1', aid);
const M = (mid: string) => paths.message(W, 'p1', 'i1', mid);

async function history(over: Record<string, unknown> = {}) {
  await put({
    [I('i1')]: itemDoc({ ...over }),
    [A('a1')]: {
      kind: 'text',
      name: 'a.txt',
      content: 'x',
      url: null,
      bytes: 1,
      runId: null,
      by: { type: 'agent', id: AGENTS.a },
      at: Timestamp.now(),
      lastEventId: 'seed',
    },
    [M('m1')]: {
      workspaceId: W,
      projectId: 'p1',
      itemId: 'i1',
      by: { type: 'human', id: 'bob' },
      kind: 'note',
      text: 'hi',
      at: Timestamp.now(),
      answered: false,
      replyTo: null,
      lastEventId: 'seed',
    },
    [R('r1')]: {
      agentUid: AGENTS.a,
      projectId: 'p1',
      itemId: 'i1',
      stepId: 'draft',
      startedAt: Timestamp.now(),
      status: 'done',
      costEur: 0,
      lastEventId: 'seed',
    },
    // A run of another item stays.
    [R('other')]: { agentUid: AGENTS.a, projectId: 'p1', itemId: 'gated', stepId: 'draft' },
  });
}

const erase = (who: As, over: Record<string, unknown> = {}) =>
  deleteItem(who.ctx, {
    projectId: 'p1',
    itemId: 'i1',
    item: itemDoc(over) as unknown as ItemState,
    attachmentIds: ['a1'],
    messageIds: ['m1'],
    runIds: ['r1'],
  });

const gone = async (path: string) => expect(Object.keys(await snap(path))).toHaveLength(0);

describe('delete an item for good', () => {
  it('lets its creator erase it with messages, files and runs, and leaves one history line', async () => {
    await history();
    const a = as('alice');
    await ok(a.run(erase(a)));
    await gone(I('i1'));
    await gone(A('a1'));
    await gone(M('m1'));
    await gone(R('r1'));
    expect(await snap(R('other'))).toBeTruthy();
    const ev = await snap(paths.event(W, 'del-items-i1'));
    expect(ev).toMatchObject({
      type: 'item.deleted',
      data: { title: 'Post about bees', forever: true },
    });
  });

  it('lets an organization admin erase an item somebody else made', async () => {
    await history();
    const o = as('owner');
    await ok(o.run(erase(o)));
    await gone(I('i1'));
  });

  for (const status of ['stopped', 'done'])
    it(`works for a ${status} item`, async () => {
      await history({ status });
      const a = as('alice');
      await ok(a.run(erase(a)));
      await gone(I('i1'));
    });

  it('denies another member (not the creator, not an admin)', async () => {
    await history();
    const b = as('bob');
    await denied(b.run(erase(b)));
    await denied(as('dave').run(erase(as('dave'))));
    expect(await snap(I('i1'))).toBeTruthy();
  });

  it('denies a signed-in stranger and a member of another organization', async () => {
    await history();
    const e = as('eve');
    await denied(e.run(erase(e)));
    const e2 = as('eve', { workspaceId: 'w2' });
    await denied(e2.run(erase(e2)));
  });

  it('denies an agent, even one that raised the item', async () => {
    await history({ createdBy: { type: 'agent', id: AGENTS.a } });
    const g = as(AGENTS.a);
    await denied(
      g.run([
        { kind: 'delete', path: M('m1') },
        { kind: 'delete', path: I('i1') },
        {
          kind: 'set',
          path: paths.event(W, 'del-items-i1'),
          data: {
            actor: { type: 'agent', id: AGENTS.a, name: 'A' },
            projectId: 'p1',
            itemId: 'i1',
            runId: null,
            type: 'item.deleted',
            data: {},
            at: new Date(),
          },
        },
      ]),
    );
  });

  it('denies an item an agent holds, even for an admin', async () => {
    await history({
      status: 'working',
      claim: { runId: 'r1', agentUid: AGENTS.a, heartbeatAt: Timestamp.now() },
    });
    const o = as('owner');
    await denied(
      o.run(
        deleteItem(o.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item: itemDoc() as unknown as ItemState,
          attachmentIds: [],
          messageIds: [],
          runIds: [],
        }),
      ),
    );
    expect(await snap(I('i1'))).toBeTruthy();
  });

  it('denies deleting the item without the history line', async () => {
    await history();
    const a = as('alice');
    await denied(a.run([{ kind: 'delete', path: I('i1') }]));
  });

  it('denies deleting a message, a file or a run on their own', async () => {
    await history();
    const a = as('alice');
    const o = as('owner');
    const tomb = erase(a).ops.filter((op) => op.path.includes('/events/'));
    for (const path of [M('m1'), A('a1'), R('r1')]) {
      await denied(a.run([{ kind: 'delete', path }, ...tomb]));
      await denied(o.run([{ kind: 'delete', path }]));
    }
  });

  it('refuses to delete the run of an item the person could not erase', async () => {
    await history();
    const b = as('bob');
    await denied(
      b.run([
        { kind: 'delete', path: R('r1') },
        ...erase(b).ops.filter((o) => o.path.includes('/events/')),
      ]),
    );
  });
});
