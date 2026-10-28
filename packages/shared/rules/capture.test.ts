/**
 * Quick capture (card M3ipmzNY): the Undo on the "Added" toast takes a just-made item back, with
 * its files. Only its creator can, within two minutes, while nobody has claimed or decided it.
 */
import { Timestamp } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { attach, createItem, undoCreateItem } from '../src/actions';
import { paths } from '../src/schema';
import { as, denied, I, itemDoc, ok, put, steps, useEmulator, W } from './harness';

useEmulator();

const project = { steps: steps() };

async function capture(withFile = false) {
  const a = as('alice');
  const plan = createItem(a.ctx, { project, projectId: 'p1', title: 'Quick one', type: 'idea' });
  await ok(a.run(plan));
  let attachmentId: string | undefined;
  if (withFile) {
    const at = attach(a.ctx, {
      projectId: 'p1',
      itemId: plan.itemId,
      kind: 'text',
      name: 'note.txt',
      content: 'hello',
    });
    await ok(a.run(at));
    attachmentId = at.attachmentId;
  }
  const undo = (who = a) =>
    undoCreateItem(who.ctx, {
      projectId: 'p1',
      itemId: plan.itemId,
      title: 'Quick one',
      attachmentIds: attachmentId ? [attachmentId] : [],
    });
  return { a, plan, undo };
}

describe('undo of a new item', () => {
  it('lets its creator take it back, with its files', async () => {
    const { a, undo } = await capture(true);
    await ok(a.run(undo()));
  });

  it('works for an item with no files', async () => {
    const { a, undo } = await capture();
    await ok(a.run(undo()));
  });

  it('denies another member', async () => {
    const { undo } = await capture();
    const b = as('bob');
    await denied(b.run(undo(b)));
  });

  it('denies an item an agent holds', async () => {
    const { a, plan, undo } = await capture();
    await put({
      [I(plan.itemId)]: itemDoc({
        stepId: 'intake',
        status: 'working',
        claim: { runId: 'r1', agentUid: 'agentA', heartbeatAt: Timestamp.now() },
      }),
    });
    await denied(a.run(undo()));
  });

  it('denies a delete without the tombstone event', async () => {
    const { a, plan } = await capture();
    await denied(a.run([{ kind: 'delete', path: paths.item(W, 'p1', plan.itemId) }]));
  });
});
