/**
 * Bulk actions (card O2Ehb9CG): Move to step and Archive/Restore are single-item writes the
 * bulk bar repeats, so each item passes the same rules. Steps: intake, draft (agents), review
 * (human gate), publish (agent).
 */
import { describe, expect, it } from 'vitest';
import { archiveItem, moveItem, restoreItem } from '../src/actions';
import { steps } from './harness';
import { as, atGate, denied, I, itemDoc, ok, put, useEmulator, minutesAgo, snap } from './harness';

useEmulator();

const project = { steps: steps() };
const mine = () => itemDoc({ createdBy: { type: 'human', id: 'alice' } });

const move = (a: ReturnType<typeof as>, item: ReturnType<typeof itemDoc>, toStepId: string) =>
  moveItem(a.ctx, { project, projectId: 'p1', itemId: 'i', item: item as never, toStepId });
const archive = (a: ReturnType<typeof as>, item: ReturnType<typeof itemDoc>) =>
  archiveItem(a.ctx, { projectId: 'p1', itemId: 'i', item: item as never });

describe('move to step', () => {
  it('lets a member send an item back to an earlier step, with a fresh gate at a human step', async () => {
    await put({ [I('i')]: itemDoc({ stepId: 'publish' }) });
    const b = as('bob');
    await ok(b.run(move(b, itemDoc({ stepId: 'publish' }), 'review')));
    const d = await snap(I('i'));
    expect(d.status).toBe('waiting');
    expect(d.stepId).toBe('review');
  });

  it('lets a member send a waiting item back to an agent step', async () => {
    await put({ [I('i')]: atGate() });
    const b = as('bob');
    await ok(b.run(move(b, atGate(), 'intake')));
  });

  it('denies a member moving an item forward over gates, but allows an admin', async () => {
    await put({ [I('i')]: itemDoc({ stepId: 'intake' }) });
    const b = as('bob');
    await denied(b.run(move(b, itemDoc({ stepId: 'intake' }), 'publish')));
    const o = as('owner');
    await ok(o.run(move(o, itemDoc({ stepId: 'intake' }), 'publish')));
  });

  it('denies moving an item an agent holds', async () => {
    const held = itemDoc({
      stepId: 'publish',
      status: 'working',
      claim: { agentUid: 'agentA', runId: 'r1', at: minutesAgo(1), heartbeatAt: minutesAgo(1) },
    });
    await put({ [I('i')]: held });
    const b = as('bob');
    await denied(
      b.run(
        moveItem(b.ctx, {
          project,
          projectId: 'p1',
          itemId: 'i',
          item: { ...held, claim: null, status: 'queued' } as never,
          toStepId: 'review',
        }),
      ),
    );
  });

  it('denies a person outside the project and an agent', async () => {
    await put({ [I('i')]: itemDoc({ stepId: 'publish' }) });
    const e = as('eve');
    await denied(e.run(move(e, itemDoc({ stepId: 'publish' }), 'draft')));
  });

  it('denies a move without its event, to the same step, or landing wrong', async () => {
    await put({ [I('i')]: itemDoc({ stepId: 'publish' }) });
    const b = as('bob');
    const p = move(b, itemDoc({ stepId: 'publish' }), 'draft');
    await denied(b.run(p.ops.filter((op) => op.path === I('i'))));
    // arriving at a human step as "queued" is not how an item arrives
    const bad = move(b, itemDoc({ stepId: 'publish' }), 'review');
    const op = bad.ops.find((o) => o.path === I('i'))!;
    await denied(
      b.run({
        ops: bad.ops.map((o) =>
          o === op ? { ...o, data: { ...o.data, status: 'queued', gate: null } } : o,
        ),
      }),
    );
  });
});

describe('archive and restore', () => {
  it('lets the creator and an admin archive an open item, and restore it', async () => {
    await put({ [I('i')]: mine() });
    const a = as('alice');
    await ok(a.run(archive(a, mine())));
    await ok(a.run(restoreItem(a.ctx, { project, projectId: 'p1', itemId: 'i', stepId: 'draft' })));
    const o = as('owner');
    await ok(o.run(archive(o, mine())));
  });

  it('restores an item archived at a gate with a fresh gate', async () => {
    await put({ [I('i')]: atGate(['alice'], []) });
    const a = as('alice');
    await ok(a.run(archiveItem(a.ctx, { projectId: 'p1', itemId: 'i', item: atGate() as never })));
    await ok(
      a.run(restoreItem(a.ctx, { project, projectId: 'p1', itemId: 'i', stepId: 'review' })),
    );
  });
});

describe('archive denies', () => {
  it('another member who did not create the item', async () => {
    await put({ [I('i')]: mine() });
    const b = as('bob');
    await denied(b.run(archive(b, mine())));
  });

  it('a person outside the project', async () => {
    await put({ [I('i')]: mine() });
    const e = as('eve');
    await denied(e.run(archive(e, mine())));
  });

  it('an item an agent holds, and an item already archived or done', async () => {
    const held = itemDoc({
      createdBy: { type: 'human', id: 'alice' },
      status: 'working',
      claim: { agentUid: 'agentA', runId: 'r1', at: minutesAgo(1), heartbeatAt: minutesAgo(1) },
    });
    await put({ [I('i')]: held });
    const a = as('alice');
    await denied(a.run(archive(a, mine())));
    await put({ [I('i')]: itemDoc({ createdBy: { type: 'human', id: 'alice' }, status: 'done' }) });
    await denied(a.run(archive(a, mine())));
  });

  it('an archive without its event, or one that also changes the step', async () => {
    await put({ [I('i')]: mine() });
    const a = as('alice');
    const p = archive(a, mine());
    await denied(a.run(p.ops.filter((op) => op.path === I('i'))));
    const op = p.ops.find((o) => o.path === I('i'))!;
    await denied(
      a.run({
        ops: p.ops.map((o) => (o === op ? { ...o, data: { ...o.data, stepId: 'publish' } } : o)),
      }),
    );
  });
});

describe('restore denies', () => {
  const archived = () =>
    itemDoc({
      createdBy: { type: 'human', id: 'alice' },
      status: 'stopped',
      archivedAt: minutesAgo(1),
    });
  it('another member', async () => {
    await put({ [I('i')]: archived() });
    const b = as('bob');
    await denied(
      b.run(restoreItem(b.ctx, { project, projectId: 'p1', itemId: 'i', stepId: 'draft' })),
    );
  });

  it('a rejected item (stopped at a gate, never archived) restores for its creator', async () => {
    await put({
      [I('i')]: itemDoc({ createdBy: { type: 'human', id: 'alice' }, status: 'stopped' }),
    });
    const a = as('alice');
    await ok(a.run(restoreItem(a.ctx, { project, projectId: 'p1', itemId: 'i', stepId: 'draft' })));
  });

  it('a restore to a different step than the one it was archived at', async () => {
    await put({ [I('i')]: archived() });
    const a = as('alice');
    await denied(
      a.run(restoreItem(a.ctx, { project, projectId: 'p1', itemId: 'i', stepId: 'publish' })),
    );
  });
});
