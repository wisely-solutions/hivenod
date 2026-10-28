/**
 * Delete an item for good (Delete… in an item menu), in chunks: begin (flag `erasing`), delete the
 * history (log lines, runs, messages, files), finish (the item and a "deleted" line). Only its
 * creator or an organization admin, never an agent, never while an agent holds it. The children
 * cannot be deleted while the flag is not set.
 */
import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { beginItemErase, finishItemErase, type ItemState } from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, as, denied, I, itemDoc, ok, put, snap, useEmulator, W, type As } from './harness';

useEmulator();

const R = (rid: string) => paths.run(W, rid);
const A = (aid: string) => paths.attachment(W, 'p1', 'i1', aid);
const L = (rid: string, n: number | string) => `${paths.run(W, rid)}/log/${n}`;
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
    [L('r1', 0)]: { at: Timestamp.now(), level: 'info', text: 'x' },
    [L('r1', 1)]: { at: Timestamp.now(), level: 'info', text: 'y' },
    // A run of another item stays.
    [R('other')]: { agentUid: AGENTS.a, projectId: 'p1', itemId: 'gated', stepId: 'draft' },
  });
}

const item = (over: Record<string, unknown> = {}) => itemDoc(over) as unknown as ItemState;
const begin = (who: As, over: Record<string, unknown> = {}) =>
  beginItemErase(who.ctx, { projectId: 'p1', itemId: 'i1', item: item(over) });
const finish = (who: As) =>
  finishItemErase(who.ctx, { projectId: 'p1', itemId: 'i1', title: 'Post about bees' });
const children = [L('r1', 0), L('r1', 1), R('r1'), M('m1'), A('a1')];
const wipe = (who: As, paths_: string[] = children) =>
  who.run({ ops: paths_.map((path) => ({ kind: 'delete' as const, path })) });

const gone = async (path: string) => expect(Object.keys(await snap(path))).toHaveLength(0);

describe('delete an item for good', () => {
  it('lets its creator erase it with log lines, runs, messages and files, leaving one history line', async () => {
    await history();
    const a = as('alice');
    await ok(a.run(begin(a)));
    expect(await snap(I('i1'))).toMatchObject({ erasing: true, status: 'stopped' });
    await ok(wipe(a));
    await ok(a.run(finish(a)));
    for (const p of [I('i1'), ...children]) await gone(p);
    expect(await snap(R('other'))).toBeTruthy();
    const ev = await snap(paths.event(W, 'del-items-i1'));
    expect(ev).toMatchObject({
      type: 'item.deleted',
      data: { title: 'Post about bees', forever: true },
    });
  });

  it('resumes: a second begin and a partial wipe do no harm', async () => {
    await history();
    const a = as('alice');
    await ok(a.run(begin(a)));
    await ok(wipe(a, [L('r1', 0)]));
    // the tab closed here; later the same walk runs again over what is left
    await ok(wipe(a, [L('r1', 1), R('r1')]));
    await ok(wipe(a, [M('m1'), A('a1')]));
    await ok(a.run(finish(a)));
    await gone(I('i1'));
  });

  it('lets an organization admin erase an item somebody else made', async () => {
    await history();
    const o = as('owner');
    await ok(o.run(begin(o)));
    await ok(wipe(o));
    await ok(o.run(finish(o)));
    await gone(I('i1'));
  });

  for (const status of ['stopped', 'done'])
    it(`works for a ${status} item`, async () => {
      await history({ status });
      const a = as('alice');
      await ok(a.run(begin(a, { status })));
      await ok(wipe(a));
      await ok(a.run(finish(a)));
      await gone(I('i1'));
    });

  it('denies children (log lines included) until the item is flagged erasing', async () => {
    await history();
    const a = as('alice');
    const o = as('owner');
    for (const path of children) {
      await denied(wipe(a, [path]));
      await denied(wipe(o, [path]));
    }
    expect(await snap(L('r1', 0))).toBeTruthy();
  });

  it('keeps log lines immutable otherwise (no update, no agent delete)', async () => {
    await history();
    const a = as('alice');
    await ok(a.run(begin(a)));
    await denied(a.run({ ops: [{ kind: 'update', path: L('r1', 0), data: { text: 'z' } }] }));
    await denied(wipe(as(AGENTS.a), [L('r1', 0), R('r1'), M('m1')]));
    expect(await snap(L('r1', 0))).toBeTruthy();
  });

  it('denies another member (not the creator, not an admin) at every step', async () => {
    await history();
    const b = as('bob');
    await denied(b.run(begin(b)));
    const a = as('alice');
    await ok(a.run(begin(a)));
    await denied(wipe(b));
    await denied(wipe(as('dave')));
    await denied(b.run(finish(b)));
    expect(await snap(I('i1'))).toBeTruthy();
  });

  it('denies a signed-in stranger and a member of another organization', async () => {
    await history();
    const a = as('alice');
    await ok(a.run(begin(a)));
    const e = as('eve');
    await denied(e.run(begin(e)));
    await denied(wipe(e));
    const e2 = as('eve', { workspaceId: 'w2' });
    await denied(wipe(e2));
  });

  it('denies an agent, even one that raised the item', async () => {
    await history({ createdBy: { type: 'agent', id: AGENTS.a } });
    const g = as(AGENTS.a);
    await denied(
      g.run({
        ops: [
          {
            kind: 'update',
            path: I('i1'),
            data: { erasing: true, status: 'stopped', claim: null, gate: null },
          },
        ],
      }),
    );
    const o = as('owner');
    await ok(o.run(begin(o)));
    await denied(wipe(g));
    await denied(g.run({ ops: [{ kind: 'delete', path: I('i1') }] }));
    expect(await snap(I('i1'))).toBeTruthy();
  });

  it('denies an item an agent holds, even for an admin', async () => {
    await history({
      status: 'working',
      claim: { runId: 'r1', agentUid: AGENTS.a, heartbeatAt: Timestamp.now() },
    });
    const o = as('owner');
    await denied(
      o.run({
        ops: [
          {
            kind: 'update',
            path: I('i1'),
            data: { erasing: true, status: 'stopped', claim: null, gate: null },
          },
        ],
      }),
    );
    expect(() =>
      beginItemErase(o.ctx, {
        projectId: 'p1',
        itemId: 'i1',
        item: item({ claim: { runId: 'r1' } }),
      }),
    ).toThrow();
    await denied(wipe(o));
    expect(await snap(I('i1'))).toBeTruthy();
  });

  it('denies deleting the item without the history line', async () => {
    await history();
    const a = as('alice');
    await ok(a.run(begin(a)));
    await denied(a.run({ ops: [{ kind: 'delete', path: I('i1') }] }));
  });

  it('denies restoring an item that is being erased', async () => {
    await history();
    const a = as('alice');
    await ok(a.run(begin(a)));
    await denied(
      a.run({
        ops: [{ kind: 'update', path: I('i1'), data: { archivedAt: null, status: 'queued' } }],
      }),
    );
  });
});
