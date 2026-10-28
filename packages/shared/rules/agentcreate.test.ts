/**
 * Item DhsO9: agents create items (create_item) in a project that allows it ("Agents may create
 * items", off by default), of their own workspace, within their project access. Everything else
 * is refused by the rules.
 */
import { describe, expect, it } from 'vitest';
import {
  attach,
  claimItem,
  createItem,
  setAgentsMayCreateItems,
  updateProject,
} from '../src/actions';
import { paths } from '../src/schema';
import {
  AGENTS,
  as,
  denied,
  I,
  ok,
  P,
  projectDoc,
  put,
  snap,
  steps,
  useEmulator,
  W,
  W2,
} from './harness';

useEmulator();

const open = { steps: steps(), agentsMayCreateItems: true };
const allow = (pid = 'p1') => put({ [P(pid)]: projectDoc({}, { agentsMayCreateItems: true }) });
const create = (who = as(AGENTS.a), over: Partial<Parameters<typeof createItem>[1]> = {}) =>
  createItem(who.ctx, {
    project: open,
    projectId: 'p1',
    title: 'Fix the checkout timeout',
    type: 'task',
    summary: 'Asked by João on Telegram.',
    ...over,
  });

describe('an agent creates an item', () => {
  it('in an allowed project: ordinary work at the first step, created by the agent', async () => {
    await allow();
    const a = as(AGENTS.a);
    const p = create(a);
    await ok(a.run(p));
    expect(await snap(I(p.itemId))).toMatchObject({
      title: 'Fix the checkout timeout',
      type: 'task',
      stepId: 'intake',
      status: 'queued',
      claim: null,
      createdBy: { type: 'agent', id: AGENTS.a },
      source: { kind: 'agent', label: AGENTS.a },
    });
    expect(await snap(paths.event(W, p.eventId))).toMatchObject({
      type: 'item.created',
      actor: { type: 'agent', id: AGENTS.a },
      itemId: p.itemId,
    });
    // It is work: the same agent (or any other on the project) can claim it at once.
    const c = claimItem(a.ctx, {
      projectId: 'p1',
      itemId: p.itemId,
      item: (await snap(I(p.itemId))) as never,
    });
    await ok(a.run(c));
  });

  it('waiting to be shaped when the project shapes new items', async () => {
    await put({
      [P('p1')]: projectDoc({}, { agentsMayCreateItems: true, shapeNewItems: true }),
    });
    const a = as(AGENTS.a);
    const p = create(a, { unshaped: true });
    await ok(a.run(p));
    expect(await snap(I(p.itemId))).toMatchObject({ shape: null, stepId: 'intake' });
  });

  it('at a people first step, waiting at its gate', async () => {
    const s = steps();
    const gated = [s[2]!, s[3]!];
    await put({
      [P('p1')]: {
        ...projectDoc({}, { agentsMayCreateItems: true }),
        steps: gated,
        stepIndex: { review: 0, publish: 1 },
      },
    });
    const a = as(AGENTS.a);
    const p = createItem(a.ctx, {
      project: { steps: gated, agentsMayCreateItems: true },
      projectId: 'p1',
      title: 'Approve the new banner',
      type: 'request',
    });
    await ok(a.run(p));
    expect(await snap(I(p.itemId))).toMatchObject({ stepId: 'review', status: 'waiting' });
  });

  it('with files attached right after, while nobody holds it', async () => {
    await allow();
    const a = as(AGENTS.a);
    const p = create(a);
    await ok(a.run(p));
    const file = () =>
      attach(a.ctx, {
        projectId: 'p1',
        itemId: p.itemId,
        kind: 'markdown',
        name: 'findings.md',
        content: '# What I saw',
      });
    await ok(a.run(file()));
    await ok(a.run(file()));
    expect((await snap(I(p.itemId))).attachmentCount).toBe(2);
    // Not on an item someone else created, and not once it is claimed by another agent.
    const s = as(AGENTS.star);
    await denied(
      s.run(
        attach(s.ctx, { projectId: 'p1', itemId: p.itemId, kind: 'text', name: 'x', content: 'y' }),
      ),
    );
    await denied(
      a.run(
        attach(a.ctx, { projectId: 'p1', itemId: 'i1', kind: 'text', name: 'x', content: 'y' }),
      ),
    );
  });
});

describe('refused', () => {
  it('when the setting is off (absent, or switched off)', async () => {
    const a = as(AGENTS.a);
    // The action itself refuses with a clear message…
    expect(() =>
      createItem(a.ctx, { project: { steps: steps() }, projectId: 'p1', title: 'x', type: 'task' }),
    ).toThrow(/does not let agents create items/);
    // …and the rules refuse a hand-built write: the seeded p1 has no setting.
    await denied(a.run(create(a)));
    await put({ [P('p1')]: projectDoc({}, { agentsMayCreateItems: false }) });
    await denied(a.run(create(a)));
  });

  it('in a project outside its access', async () => {
    await allow('p2');
    const a = as(AGENTS.a); // allowed on p1 only
    await denied(a.run(create(a, { projectId: 'p2' })));
  });

  it('in another workspace', async () => {
    await put({ [paths.project(W2, 'x1')]: projectDoc({}, { agentsMayCreateItems: true }) });
    const s = as(AGENTS.star, { workspaceId: W2 }); // an agent of w1 only
    await denied(
      s.run(createItem(s.ctx, { project: open, projectId: 'x1', title: 'x', type: 'task' })),
    );
  });

  it('for a revoked agent', async () => {
    await allow();
    const r = as(AGENTS.revoked);
    await denied(r.run(create(r)));
  });

  it('ATTACK: as a finding, claimed, past the first step, with a run, or as someone else', async () => {
    await allow();
    const a = as(AGENTS.a);
    const patched = (over: Record<string, unknown>) => {
      const p = create(a);
      return {
        ...p,
        ops: p.ops.map((op) =>
          op.path.includes('/items/') ? { ...op, data: { ...op.data, ...over } } : op,
        ),
      };
    };
    await denied(a.run(patched({ type: 'finding' })));
    await denied(a.run(patched({ status: 'working' })));
    await denied(a.run(patched({ stepId: 'draft' })));
    await denied(a.run(patched({ sourceRunId: 'r1' })));
    await denied(a.run(patched({ createdBy: { type: 'human', id: 'alice' } })));
    await denied(a.run(patched({ createdBy: { type: 'agent', id: AGENTS.star } })));
  });

  it('a person cannot pass as an agent', async () => {
    await allow();
    const al = as('alice');
    const p = createItem(
      { ...al.ctx, actor: { ...al.ctx.actor, type: 'agent' } },
      { project: open, projectId: 'p1', title: 'x', type: 'task' },
    );
    await denied(al.run(p));
  });
});

describe('the project setting "Agents may create items"', () => {
  it("admins and the project's creator switch it; other members and agents cannot", async () => {
    const d = as('dave');
    await denied(d.run(setAgentsMayCreateItems(d.ctx, { projectId: 'p1', on: true })));
    const o = as('owner'); // admin and the creator of p1
    await ok(o.run(setAgentsMayCreateItems(o.ctx, { projectId: 'p1', on: true })));
    expect((await snap(P('p1'))).agentsMayCreateItems).toBe(true);
    // The creator, as a plain member.
    await put({ [P('p2')]: projectDoc({}, { createdBy: 'carol' }) });
    const c = as('carol');
    await ok(c.run(setAgentsMayCreateItems(c.ctx, { projectId: 'p2', on: true })));
    await ok(c.run(setAgentsMayCreateItems(c.ctx, { projectId: 'p2', on: false })));
    expect((await snap(P('p2'))).agentsMayCreateItems).toBe(false);
    // An agent never.
    const a = as(AGENTS.a);
    await denied(
      a.run({
        ops: [
          {
            kind: 'update',
            path: P('p1'),
            data: { agentsMayCreateItems: false, lastEventId: 'seed' },
          },
        ],
      }),
    );
  });

  it('the project edit form saves it with the name, for the same people', async () => {
    const o = as('owner');
    const edit = (who = o, on = true) =>
      updateProject(who.ctx, {
        projectId: 'p1',
        name: 'Blog',
        emoji: '📝',
        description: '',
        agentsMayCreateItems: on,
      });
    await ok(o.run(edit()));
    expect((await snap(P('p1'))).agentsMayCreateItems).toBe(true);
    const d = as('dave');
    await denied(d.run(edit(d, false)));
    // Not a boolean
    await denied(
      o.run({
        ...edit(),
        ops: edit().ops.map((op) =>
          op.path === P('p1') ? { ...op, data: { ...op.data, agentsMayCreateItems: 'yes' } } : op,
        ),
      }),
    );
  });
});
