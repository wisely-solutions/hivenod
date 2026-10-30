/**
 * Shared fixtures for the rules suite. A fresh, known world is seeded (rules disabled) before
 * every test; tests then act as one identity through the real actions in src/actions.ts.
 */
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, Timestamp, type Firestore } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { SERVER_TIME, type ActionContext, type ActionPlan, type WriteOp } from '../src/actions';
import { applyPlan, toFirestoreValue } from '../src/firestore';
import { paths } from '../src/schema';

export const W = 'w1';
export const W2 = 'w2';

export const HUMANS = {
  owner: 'owner',
  alice: 'alice',
  bob: 'bob',
  carol: 'carol',
  dave: 'dave', // member
  eve: 'eve', // signed in, not a member
} as const;
export const AGENTS = {
  a: 'agentA', // legacy projectIds ['p1'] (ignored since Projects were removed)
  star: 'agentStar', // legacy projectIds '*'
  revoked: 'agentRevoked', // revoked
} as const;

let env: RulesTestEnvironment;
export const getEnv = () => env;

/** The rules under test, as deployed (the mutation runner points HIVE_RULES_FILE at a temp copy). */
export const RULES = readFileSync(
  process.env.HIVE_RULES_FILE ?? new URL('../../../firestore.rules', import.meta.url),
  'utf8',
);

export function useEmulator() {
  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: 'hive-rules-test',
      firestore: { rules: RULES },
    });
  });
  afterAll(async () => env?.cleanup());
  beforeEach(reset);
}

/** A fresh, known world: everything cleared, then the standard fixtures. */
export async function reset() {
  // The emulator's clear can fail with a 500 when a client of the previous test closed a listener
  // a moment ago (it notifies the closed stream: "Stream is already completed"). Retry, bounded.
  for (let attempt = 1; ; attempt++) {
    try {
      await env.clearFirestore();
      break;
    } catch (e) {
      // A listener of another process (the Go CLI) closing at the same moment shows up as a
      // cancelled call (499) or a lock timeout (409): also worth a bounded retry.
      if (attempt >= 5 || !/"code":(500|499|409)/.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  await seed();
}

/** Replaces the emulator's rules for the test project (e.g. instrumented copies of RULES). */
export async function setRules(rules: string) {
  const { host, port } = env.emulators.firestore!;
  const res = await fetch(
    `http://${host}:${port}/emulator/v1/projects/hive-rules-test:securityRules`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rules }] } }),
    },
  );
  if (!res.ok) throw new Error(`Loading rules failed: ${res.status} ${await res.text()}`);
}

export const minutesAgo = (m: number) => Timestamp.fromMillis(Date.now() - m * 60_000);
export const now = () => Timestamp.now();

/** Writes docs with rules disabled. */
export async function put(docs: Record<string, Record<string, unknown>>) {
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore() as unknown as Firestore;
    for (const [path, data] of Object.entries(docs)) {
      await setDoc(doc(db, path), toFirestoreValue(data) as Record<string, unknown>);
    }
  });
}

/**
 * Old Projects data (removed in OE8Fm slice 11): still in the database until the deletion script
 * runs, and no rule lets anyone read or write it.
 */
export const LEGACY = {
  project: `workspaces/w1/projects/p1`,
  item: `workspaces/w1/projects/p1/items/i1`,
  run: `workspaces/w1/runs/r1`,
  calendar: `workspaces/w1/calendar/c1`,
  busy: `users/alice/busy/w1_c1`,
  projectEvent: `workspaces/w1/events/seed-project`,
} as const;

function agentDoc(projectIds: string[] | '*', revoked = false) {
  return {
    name: 'Agent',
    color: '#2F5FD0',
    projectIds,
    createdBy: 'owner',
    createdAt: now(),
    revokedAt: revoked ? now() : null,
    lastSeenAt: null,
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  };
}

async function seed() {
  await put({
    [paths.workspace(W)]: {
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
      createdAt: now(),
      lastEventId: 'seed',
    },
    [paths.workspace(W2)]: {
      name: 'Other',
      ownerUid: 'eve',
      adminUids: ['eve'],
      memberRoles: { eve: 'admin' },
      createdAt: now(),
      lastEventId: 'seed',
    },
    [paths.agent(W, AGENTS.a)]: agentDoc(['p1']),
    [paths.agent(W, AGENTS.star)]: agentDoc('*'),
    [paths.agent(W, AGENTS.revoked)]: agentDoc('*', true),
    [LEGACY.project]: {
      name: 'Blog',
      memberUids: ['alice'],
      createdBy: 'owner',
      lastEventId: 'seed',
    },
    [LEGACY.item]: { title: 'Post about bees', stepId: 'draft', status: 'queued', claim: null },
    [LEGACY.run]: { agentUid: AGENTS.a, projectId: 'p1', itemId: 'i1', endedAt: null },
    [LEGACY.calendar]: { title: 'Call', memberUid: 'alice' },
    [LEGACY.busy]: { workspaceId: W, start: now(), end: now() },
    [LEGACY.projectEvent]: {
      actor: { type: 'human', id: 'owner', name: 'Owner' },
      projectId: 'p1',
      itemId: null,
      runId: null,
      type: 'project.created',
      data: {},
      at: now(),
    },
    [paths.group(W, 'g1')]: { name: 'Product', memberUids: ['alice'], lastEventId: 'seed' },
    [paths.event(W, 'seed')]: {
      actor: { type: 'human', id: 'owner', name: 'Owner' },
      projectId: null,
      itemId: null,
      runId: null,
      type: 'workspace.created',
      data: {},
      at: now(),
    },
    [paths.user('alice')]: {
      name: 'Alice',
      email: 'alice@example.com',
      photoURL: null,
      color: '#000',
      workspaceId: W,
      workspaceIds: [W],
      theme: null,
    },
  });
}

// ---------- acting as someone ----------

const NAMES: Record<string, string> = { owner: 'Owner', alice: 'Alice', bob: 'Bob' };

export interface As {
  uid: string;
  db: Firestore;
  ctx: ActionContext;
  /** Commit a plan / raw ops as this identity. */
  run: (p: Pick<ActionPlan, 'ops'> | WriteOp[]) => Promise<void>;
}

export function as(
  uid: string,
  opts: { email?: string; workspaceId?: string; unverified?: boolean } = {},
): As {
  const isAgent = Object.values(AGENTS).includes(uid as never) || uid.startsWith('agent');
  // Google accounts (and confirmed password accounts) carry email_verified; `unverified` is a
  // password account that has not confirmed its address yet (card rxGgHFZs).
  const token = { ...(opts.email ? { email: opts.email } : {}), email_verified: !opts.unverified };
  const db = env.authenticatedContext(uid, token).firestore() as unknown as Firestore;
  const ctx: ActionContext = {
    workspaceId: opts.workspaceId ?? W,
    actor: { type: isAgent ? 'agent' : 'human', id: uid, name: NAMES[uid] ?? uid },
  };
  return {
    uid,
    db,
    ctx,
    run: (p) => applyPlan(db, Array.isArray(p) ? { ops: p } : p),
  };
}

export const anon = () => env.unauthenticatedContext().firestore() as unknown as Firestore;

export const ok = <T>(p: Promise<T>) => assertSucceeds(p);
export const denied = <T>(p: Promise<T>) => assertFails(p);

/** Event op as an actor would write it (for hand-built attack batches). */
export function eventOp(a: As, id: string, over: Record<string, unknown> = {}): WriteOp {
  return {
    kind: 'set',
    path: paths.event(W, id),
    data: {
      actor: { type: a.ctx.actor.type, id: a.uid, name: a.ctx.actor.name },
      projectId: null,
      itemId: null,
      runId: null,
      type: 'group.updated',
      data: {},
      at: SERVER_TIME,
      ...over,
    },
  };
}

/** Reads a doc with rules disabled. */
export async function snap(path: string): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {};
  await env.withSecurityRulesDisabled(async (c) => {
    const s = await c.firestore().doc(path).get();
    data = s.data() ?? {};
  });
  return data;
}
