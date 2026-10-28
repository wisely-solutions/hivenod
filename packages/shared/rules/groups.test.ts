/** Card 04: saving or deleting a group recomputes deciderUids on the steps that use it. */
import { describe, expect, it } from 'vitest';
import { PROJECTS_PER_BATCH, syncGroupDeciders } from '../src/groups';
import { deleteGroup, renameWorkspace, saveGroup } from '../src/actions';
import { paths, type Step } from '../src/schema';
import { as, denied, ok, P, projectDoc, put, snap, useEmulator, W } from './harness';

useEmulator();

const ids = Array.from({ length: PROJECTS_PER_BATCH + 3 }, (_, i) => `gp${i}`);

async function seedProjects() {
  await put({
    [paths.group(W, 'g1')]: { name: 'Product', memberUids: ['alice'], lastEventId: 'seed' },
    ...Object.fromEntries(
      ids.map((id) => [P(id), projectDoc({ groupIds: ['g1'], deciderUids: ['carol', 'alice'] })]),
    ),
  });
}
const stepsOf = async (id: string) => (await snap(P(id))).steps as Step[];

describe('group changes reach gates', () => {
  it('adds a member to every gate that uses the group, across batches', async () => {
    await seedProjects();
    const o = as('owner');
    const after = ['alice', 'bob'];
    await ok(
      o.run(saveGroup(o.ctx, { groupId: 'g1', name: 'Product', memberUids: after, isNew: false })),
    );
    const projects = ids.map((id) => ({ id, steps: [] as Step[] }));
    for (const p of projects) p.steps = await stepsOf(p.id);
    const batches = syncGroupDeciders(
      o.ctx,
      { groupId: 'g1', before: ['alice'], after, others: {} },
      projects,
    );
    expect(batches).toHaveLength(2);
    for (const b of batches) await ok(o.run(b));
    for (const id of ids) {
      const review = (await stepsOf(id)).find((s) => s.id === 'review');
      expect(review?.gate?.deciderUids).toEqual(['carol', 'alice', 'bob']);
    }
  });

  it('removes a deleted group from gates', async () => {
    await seedProjects();
    const o = as('owner');
    const projects = await Promise.all(
      ids.slice(0, 2).map(async (id) => ({ id, steps: await stepsOf(id) })),
    );
    const change = { groupId: 'g1', before: ['alice'], after: [], deleted: true, others: {} };
    for (const b of syncGroupDeciders(o.ctx, change, projects)) await ok(o.run(b));
    await ok(o.run(deleteGroup(o.ctx, { groupId: 'g1' })));
    const gate = (await stepsOf('gp0')).find((s) => s.id === 'review')?.gate;
    expect(gate?.groupIds).toEqual([]);
    expect(gate?.deciderUids).toEqual(['carol']);
  });

  it('denies a plain member saving a group, so gates cannot be re-pointed', async () => {
    await seedProjects();
    const a = as('alice');
    await denied(
      a.run(
        saveGroup(a.ctx, {
          groupId: 'g1',
          name: 'Mine',
          memberUids: ['alice', 'dave'],
          isNew: false,
        }),
      ),
    );
  });
});

describe('renaming the workspace', () => {
  it('lets the owner rename it and denies members', async () => {
    const o = as('owner');
    await ok(o.run(renameWorkspace(o.ctx, { name: 'Bee team' })));
    expect((await snap(paths.workspace(W))).name).toBe('Bee team');
    const a = as('alice');
    await denied(a.run(renameWorkspace(a.ctx, { name: 'Mine now' })));
  });
});
