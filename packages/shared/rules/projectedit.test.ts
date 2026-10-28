/** Settings > Projects edit (card 9jpb1Q4a): name, emoji and a description of at most 500 characters. */
import { describe, it } from 'vitest';
import { updateProject } from '../src/actions';
import { as, denied, ok, snap, P, useEmulator } from './harness';
import { expect } from 'vitest';

useEmulator();

describe('editing a project', () => {
  it('lets an admin set name, emoji and description', async () => {
    const o = as('owner');
    await ok(
      o.run(
        updateProject(o.ctx, {
          projectId: 'p1',
          name: 'Blog 2',
          emoji: '🚀',
          description: 'Posts',
        }),
      ),
    );
    const p = await snap(P('p1'));
    expect([p.name, p.emoji, p.description]).toEqual(['Blog 2', '🚀', 'Posts']);
  });
  it('refuses a description over 500 characters and an empty name', async () => {
    const o = as('owner');
    await denied(
      o.run(
        updateProject(o.ctx, {
          projectId: 'p1',
          name: 'Blog',
          emoji: '📝',
          description: 'x'.repeat(501),
        }),
      ),
    );
    await denied(
      o.run(updateProject(o.ctx, { projectId: 'p1', name: '', emoji: '📝', description: '' })),
    );
  });
  it('refuses someone who is not on the project', async () => {
    const e = as('eve');
    await denied(
      e.run(
        updateProject(e.ctx, { projectId: 'p1', name: 'Hijack', emoji: '📝', description: '' }),
      ),
    );
  });
});
