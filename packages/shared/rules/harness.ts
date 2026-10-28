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
import { buildStepIndex, paths, type Gate, type Step } from '../src/schema';

export const W = 'w1';
export const W2 = 'w2';

export const HUMANS = {
  owner: 'owner',
  alice: 'alice',
  bob: 'bob',
  carol: 'carol',
  dave: 'dave', // member, never a decider
  eve: 'eve', // signed in, not a member
} as const;
export const AGENTS = {
  a: 'agentA', // allowed in p1 only
  star: 'agentStar', // allowed everywhere
  revoked: 'agentRevoked', // revoked
} as const;

export const gate = (over: Partial<Gate> = {}): Gate => ({
  deciderUids: ['alice', 'bob', 'carol'],
  groupIds: [],
  rule: 'any',
  n: 1,
  mustInclude: [],
  rejectPolicy: 'one',
  remindAfterHours: 24,
  ...over,
});

/** intake (agent) → draft (agent) → review (human gate) → publish (agent) */
export function steps(g: Partial<Gate> = {}): Step[] {
  return [
    { id: 'intake', name: 'Intake', kind: 'agent', description: 'New work' },
    { id: 'draft', name: 'Draft', kind: 'agent', description: 'Write it', instructions: 'Write' },
    { id: 'review', name: 'Review', kind: 'human', description: 'Decide', gate: gate(g) },
    { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
  ];
}

let env: RulesTestEnvironment;
export const getEnv = () => env;

/** The rules under test, as deployed. */
export const RULES = readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8');

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

export function projectDoc(g: Partial<Gate> = {}, extra: Record<string, unknown> = {}) {
  const s = steps(g);
  return {
    name: 'Blog',
    emoji: '📝',
    color: '#2F5FD0',
    budgetEur: 10, // seeded like an older project: a stored budget is kept and ignored
    templateId: 'content',
    steps: s,
    stepIndex: buildStepIndex(s),
    memberUids: ['alice', 'bob', 'carol', 'dave'],
    createdBy: 'owner',
    createdAt: now(),
    archivedAt: null,
    lastEventId: 'seed',
    ...extra,
  };
}

export function itemDoc(over: Record<string, unknown> = {}) {
  return {
    title: 'Post about bees',
    type: 'idea',
    stepId: 'draft',
    status: 'queued',
    summary: '',
    source: { kind: 'manual', label: 'Alice' },
    createdBy: { type: 'human', id: 'alice' },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: now(),
    lastEventId: 'seed',
    ...over,
  };
}

export const waitingGate = (approvals: string[] = [], rejections: string[] = []) => ({
  stepId: 'review',
  approvals: Object.fromEntries(approvals.map((u) => [u, { at: now(), rationale: 'ok' }])),
  rejections: Object.fromEntries(
    rejections.map((u) => [u, { at: now(), rationale: 'not this one' }]),
  ),
});

/** An item waiting at the review gate. */
export const atGate = (approvals: string[] = [], rejections: string[] = []) =>
  itemDoc({ stepId: 'review', status: 'waiting', gate: waitingGate(approvals, rejections) });

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

export const P = (pid: string) => paths.project(W, pid);
export const I = (iid: string, pid = 'p1') => paths.item(W, pid, iid);

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
    [P('p1')]: projectDoc(),
    [P('p2')]: projectDoc(),
    [I('i1')]: itemDoc(),
    [I('i1', 'p2')]: itemDoc(),
    [I('gated')]: atGate(),
    [paths.group(W, 'g1')]: { name: 'Product', memberUids: ['alice'], lastEventId: 'seed' },
    [paths.event(W, 'seed')]: {
      actor: { type: 'human', id: 'owner', name: 'Owner' },
      projectId: 'p1',
      itemId: null,
      runId: null,
      type: 'project.created',
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
      projectId: 'p1',
      itemId: null,
      runId: null,
      type: 'item.updated',
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
