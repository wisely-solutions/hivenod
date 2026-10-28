/**
 * Edit after adding (card mpWuccjl): the title, type and description of an item are changed by
 * its creator or an admin; any member can still move it in the list. Every edit leaves an event.
 */
import { describe, it, expect } from 'vitest';
import { attach, updateItem } from '../src/actions';
import { as, denied, I, itemDoc, ok, put } from './harness';

useEmulator();
import { useEmulator } from './harness';

async function mine() {
  await put({ [I('mine')]: itemDoc({ createdBy: { type: 'human', id: 'alice' } }) });
}
const edit = (a: ReturnType<typeof as>, changes: Parameters<typeof updateItem>[1]['changes']) =>
  updateItem(a.ctx, {
    projectId: 'p1',
    itemId: 'mine',
    changes,
    before: { title: 'Post about bees', type: 'idea' },
  });

describe('editing an item after adding it', () => {
  it('lets its creator change title, type and description', async () => {
    await mine();
    const a = as('alice');
    await ok(a.run(edit(a, { title: 'Post about wasps' })));
    await ok(a.run(edit(a, { type: 'bug' })));
    await ok(a.run(edit(a, { summary: '## Brief\nWith **detail**' })));
    await ok(a.run(edit(a, { title: 'All three', type: 'task', summary: 'x' })));
  });

  it('lets an admin edit an item someone else made', async () => {
    await mine();
    const o = as('owner');
    await ok(o.run(edit(o, { title: 'Fixed by admin', summary: 'Added detail' })));
  });

  it('denies another member the wording, but not the list order', async () => {
    await mine();
    const b = as('bob');
    await denied(b.run(edit(b, { title: 'Hijacked' })));
    await denied(b.run(edit(b, { type: 'bug' })));
    await denied(b.run(edit(b, { summary: 'Hijacked' })));
    await ok(b.run(edit(b, { order: 5 })));
  });

  it('denies an empty or over-long title and an over-long description', async () => {
    await mine();
    const a = as('alice');
    await denied(a.run(edit(a, { title: '' })));
    await denied(a.run(edit(a, { title: 'x'.repeat(301) })));
    await denied(a.run(edit(a, { summary: 'x'.repeat(20001) })));
  });

  it('denies turning an item into a suggestion type', async () => {
    await mine();
    const a = as('alice');
    await denied(a.run(edit(a, { type: 'finding' })));
  });

  it('denies a person outside the project, even the creator who left it', async () => {
    await put({ [I('mine')]: itemDoc({ createdBy: { type: 'human', id: 'eve' } }) });
    const e = as('eve');
    await denied(e.run(edit(e, { title: 'Nope' })));
  });

  it('denies an edit without its event', async () => {
    await mine();
    const a = as('alice');
    const p = edit(a, { title: 'Quiet' });
    await denied(a.run(p.ops.filter((op) => op.path === I('mine'))));
  });

  it('records what changed in the event', async () => {
    await mine();
    const a = as('alice');
    const p = edit(a, { title: 'Renamed', summary: 'abc' });
    const ev = p.ops.find((op) => op.path.includes('/events/'));
    expect(ev?.data).toMatchObject({
      type: 'item.updated',
      data: {
        fields: ['title', 'summary'],
        title: { from: 'Post about bees', to: 'Renamed' },
        summaryLength: 3,
      },
    });
  });

  it('lets a member attach a file to an item, as before', async () => {
    await mine();
    const b = as('bob');
    await ok(
      b.run(
        attach(b.ctx, {
          projectId: 'p1',
          itemId: 'mine',
          kind: 'text',
          name: 'n.txt',
          content: 'hi',
        }),
      ),
    );
  });
});
