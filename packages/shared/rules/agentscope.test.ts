/**
 * Item fJnu6: an Inbox and Calendar agent (scope 'inbox', e.g. the personal agent in a "Personal"
 * organization). It uses the Calendar (and Inbox) of its organization and is refused on every
 * development item: no project, item, claim, finding, created item or project event, whatever its
 * projectIds say. Only an admin creates one; its scope never changes and it never gets projects.
 */
import { collection, doc, getDoc, getDocs, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  claimItem,
  createAgent,
  createItem,
  raiseFinding,
  rotateAgent,
  updateAgentSettings,
  type ItemState,
} from '../src/actions';
import { paths } from '../src/schema';
import {
  as,
  denied,
  I,
  itemDoc,
  now,
  ok,
  P,
  projectDoc,
  put,
  snap,
  steps,
  useEmulator,
  W,
} from './harness';

useEmulator();

const INBOX = 'agentInbox';
const A = (uid: string) => paths.agent(W, uid);
const queued = itemDoc() as unknown as ItemState;

/** An Inbox and Calendar agent as stored. `over` lets a test seed a forged doc. */
function inboxAgent(over: Record<string, unknown> = {}) {
  return {
    name: 'Personal',
    color: 'agent-3',
    projectIds: [],
    scope: 'inbox',
    createdBy: 'owner',
    createdAt: now(),
    revokedAt: null,
    lastSeenAt: null,
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
    ...over,
  };
}

const seedInbox = (over: Record<string, unknown> = {}) => put({ [A(INBOX)]: inboxAgent(over) });

describe('creating an Inbox and Calendar agent', () => {
  it('an admin creates one with no projects', async () => {
    const owner = as('owner');
    await ok(
      owner.run(
        createAgent(owner.ctx, {
          agentUid: 'agentNewInbox',
          name: 'Personal',
          color: 'agent-3',
          projectIds: [],
          scope: 'inbox',
          tokenHint: 'abcd',
        }),
      ),
    );
    expect(await snap(A('agentNewInbox'))).toMatchObject({ scope: 'inbox', projectIds: [] });
  });

  it('ATTACK: refuses projects, another scope value and a plain member creating one', async () => {
    const owner = as('owner');
    const p = createAgent(owner.ctx, {
      agentUid: 'agentX',
      name: 'X',
      color: 'agent-1',
      projectIds: [],
      scope: 'inbox',
      tokenHint: 'abcd',
    });
    for (const projectIds of [['p1'], '*']) {
      const forged = structuredClone(p);
      (forged.ops[0]!.data as Record<string, unknown>).projectIds = projectIds;
      await denied(owner.run(forged));
    }
    const other = structuredClone(p);
    (other.ops[0]!.data as Record<string, unknown>).scope = 'everything';
    await denied(owner.run(other));
    // A plain member's connect may never carry a scope (nor empty projects).
    const alice = as('alice');
    await denied(
      alice.run(
        createAgent(alice.ctx, {
          agentUid: 'agentY',
          name: 'Y',
          color: 'agent-1',
          projectIds: [],
          scope: 'inbox',
          tokenHint: 'abcd',
        }),
      ),
    );
    // The shared action refuses it before any write.
    expect(() =>
      createAgent(owner.ctx, {
        agentUid: 'agentZ',
        name: 'Z',
        color: 'agent-1',
        projectIds: ['p1'],
        scope: 'inbox',
        tokenHint: 'abcd',
      }),
    ).toThrow(/no projects/);
  });

  it('rotation keeps the scope', async () => {
    await seedInbox();
    const owner = as('owner');
    await ok(
      owner.run(
        rotateAgent(owner.ctx, {
          previousAgentUid: INBOX,
          agentUid: 'agentInbox2',
          name: 'Personal',
          color: 'agent-3',
          projectIds: [],
          scope: 'inbox',
          tokenHint: 'b1c2',
        }),
      ),
    );
    expect(await snap(A('agentInbox2'))).toMatchObject({ scope: 'inbox', projectIds: [] });
  });
});

describe('its scope never changes', () => {
  it('ATTACK: an admin cannot give it projects or drop the scope; the agent cannot either', async () => {
    await seedInbox();
    const owner = as('owner');
    await denied(
      owner.run(
        updateAgentSettings(owner.ctx, { agentUid: INBOX, name: 'Personal', projectIds: ['p1'] }),
      ),
    );
    expect(() =>
      updateAgentSettings(owner.ctx, {
        agentUid: INBOX,
        name: 'Personal',
        projectIds: '*',
        scope: 'inbox',
      }),
    ).toThrow(/no projects/);
    // Guardrails are still the admin's to set.
    await ok(
      owner.run(
        updateAgentSettings(owner.ctx, {
          agentUid: INBOX,
          name: 'Personal',
          guardrails: { maxFailedRuns: 4 },
        }),
      ),
    );
    const a = as(INBOX);
    await denied(updateDoc(doc(a.db, A(INBOX)), { scope: null }));
    await denied(updateDoc(doc(owner.db, A(INBOX)), { projectIds: '*' }));
  });

  it('ATTACK: the scope cannot be added to an existing project agent', async () => {
    const owner = as('owner');
    await denied(updateDoc(doc(owner.db, A('agentA')), { scope: 'inbox', projectIds: [] }));
  });
});

describe('refused on development items', () => {
  it('reads no project, item or project event, even if projectIds were forged to every project', async () => {
    // A doc forged around the rules (seeded directly) still gets nothing: the scope wins.
    await seedInbox({ projectIds: '*' });
    const a = as(INBOX);
    await denied(getDoc(doc(a.db, P('p1'))));
    await denied(getDoc(doc(a.db, I('i1'))));
    await denied(getDocs(collection(a.db, `${P('p1')}/items`)));
    await denied(getDoc(doc(a.db, paths.event(W, 'seed'))));
  });

  it('claims nothing, creates no item and raises no finding', async () => {
    await seedInbox({ projectIds: '*' });
    await put({ [P('p1')]: projectDoc({}, { agentsMayCreateItems: true }) });
    const a = as(INBOX);
    await denied(
      a.run(claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: queued, runId: 'runX' })),
    );
    await denied(
      a.run(
        createItem(a.ctx, {
          project: { steps: steps(), agentsMayCreateItems: true },
          projectId: 'p1',
          title: 'x',
          type: 'task',
        }),
      ),
    );
    await denied(
      a.run(
        raiseFinding(a.ctx, {
          project: { steps: steps() },
          projectId: 'p1',
          parentItemId: 'i1',
          parent: { title: 'x', claim: null },
          title: 'Found',
          details: 'Something',
        }),
      ),
    );
  });
});

describe('its own organization', () => {
  it('reads its own doc and the organization (Calendar removed, OE8Fm slice 5)', async () => {
    await seedInbox();
    const a = as(INBOX);
    await ok(getDoc(doc(a.db, A(INBOX))));
    await ok(getDoc(doc(a.db, paths.workspace(W))));
  });
});
