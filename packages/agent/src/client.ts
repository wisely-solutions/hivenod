/**
 * The Hivenod agent client: signs in with HIVENOD_TOKEN and performs every agent operation through the
 * shared actions (SPEC section 5.2), so each write is one batch = domain change + one event doc,
 * and firestore.rules enforce tracking and the gates. The CLI and the MCP server are thin shells
 * around this class.
 */
import { hostname } from 'node:os';
import { signInWithToken } from '@hive/shared/agent-auth';
import { applyPlan, converters } from '@hive/shared/firestore';
import {
  ActionError,
  agentMayTakeStep,
  attach as attachAction,
  guardrailsOf,
  isOnHold,
  isPaused,
  liveTerminal,
  newTokens,
  releaseClaim,
  type RunUsage,
  claimItem,
  completeStep,
  endRun as endRunAction,
  heartbeat as heartbeatAction,
  logLine,
  pairingPath,
  paths,
  postMessage,
  raiseFinding,
  parkItem,
  parkOf,
  reportProgress,
  unparkItem,
  decodeToken,
  askPathChange,
  isUnshaped,
  nextOnPath,
  proposeStep,
  shapeItem,
  skipStep,
  stepsOnPath,
  type ProposalInput,
  type ActionContext,
  type ActionPlan,
  type Agent,
  type AgentGuardState,
  type Attachment,
  type Item,
  type Message,
  type Project,
  type Run,
  type WriteOp,
  agentRounds,
  agentSendBack,
  agentSendBackTargets,
  checkSendBackTarget,
  MAX_AGENT_SEND_BACKS,
  requireSendBackReason,
  stuckQuestion,
  ownGet,
} from '@hive/shared';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, inMemoryPersistence, initializeAuth, type Auth } from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDocs,
  getDoc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  query,
  terminate,
  where,
  type Firestore,
} from 'firebase/firestore';
import { prepareAttachment } from './attach';
import { resolveToken } from './credentials';
import {
  errorCode,
  isRateLimited,
  RATE_LIMIT_MESSAGE,
  GATE_MESSAGE,
  HiveError,
  messageOf,
  ON_HOLD_MESSAGE,
  REVOKED_MESSAGE,
  stoppedMessage,
} from './errors';

// Public web config (not a secret); security is enforced by firestore.rules. Defaults are the hosted
// service (https://hivenod.com). A self-hosted install sets HIVENOD_FIREBASE_API_KEY, _AUTH_DOMAIN,
// _PROJECT_ID (or HIVENOD_PROJECT_ID), _APP_ID and _MESSAGING_SENDER_ID (docs/SELF-HOST.md).
const penv = process.env;
export const FIREBASE_OPTIONS = {
  apiKey: penv.HIVENOD_FIREBASE_API_KEY || 'AIzaSyCmFfvMHbbGr3lGdc_DefEkomtUOaLH6J4',
  authDomain: penv.HIVENOD_FIREBASE_AUTH_DOMAIN || 'hivenod.com',
  projectId: penv.HIVENOD_FIREBASE_PROJECT_ID || penv.HIVENOD_PROJECT_ID || 'hive-board-43be',
  appId: penv.HIVENOD_FIREBASE_APP_ID || '1:493986079810:web:71cf28f12f79f3cf9bf9db',
  messagingSenderId: penv.HIVENOD_FIREBASE_MESSAGING_SENDER_ID || '493986079810',
};

export const HEARTBEAT_INTERVAL_MS = 60_000;

export interface ConnectOptions {
  /** Defaults to process.env.HIVENOD_TOKEN, then the token saved by pairing (~/.hivenod/agent.json). */
  token?: string;
  /** host:port; defaults to FIREBASE_AUTH_EMULATOR_HOST. */
  authEmulator?: string;
  /** host:port; defaults to FIRESTORE_EMULATOR_HOST. */
  firestoreEmulator?: string;
  /** Overrides the Firebase project (tests; or HIVENOD_PROJECT_ID). */
  projectId?: string;
  heartbeatIntervalMs?: number;
}

export interface RunOutcome {
  costEur?: number;
  tokensIn?: number;
  tokensOut?: number;
  /** Part of tokensIn read from the prompt cache (shown apart from new tokens). */
  tokensCached?: number;
  model?: string | null;
  summary?: string | null;
}

interface Loc {
  projectId: string;
  itemId: string;
}
interface Loaded extends Loc {
  project: Project;
  item: Item;
}

/** A Firebase app for this process (emulators from the environment, as for the CLI). */
export function firebaseApp(
  opts: Pick<ConnectOptions, 'authEmulator' | 'firestoreEmulator' | 'projectId'> = {},
) {
  const authEmu = opts.authEmulator ?? process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const fsEmu = opts.firestoreEmulator ?? process.env.FIRESTORE_EMULATOR_HOST;
  const app = initializeApp(
    {
      ...FIREBASE_OPTIONS,
      projectId: opts.projectId ?? process.env.HIVENOD_PROJECT_ID ?? FIREBASE_OPTIONS.projectId,
    },
    `hive-agent-${Math.random().toString(36).slice(2)}`,
  );
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  if (authEmu) connectAuthEmulator(auth, `http://${authEmu}`, { disableWarnings: true });
  const db = getFirestore(app);
  if (fsEmu) {
    const [host, port] = fsEmu.split(':');
    connectFirestoreEmulator(db, host ?? '127.0.0.1', Number(port ?? 8080));
  }
  return { app, auth, db };
}

const toMs = (t: { toMillis(): number } | null | undefined) => (t ? t.toMillis() : null);

/**
 * The hand-out order of work (item QjTTL): oldest first, by when the item reached its step
 * (`stepAt`). Items that have not moved since stepAt exists have none and count as older than any
 * that has, among themselves by their last change; the item id breaks ties.
 */
export function arrivalKey(item: Pick<Item, 'stepAt' | 'updatedAt'>, itemId: string) {
  // Whole milliseconds, like the Go CLI (toMillis keeps a fraction of the nanoseconds).
  const ms = (t: { toMillis(): number } | undefined) => Math.floor(toMs(t) ?? 0);
  return [ms(item.stepAt), ms(item.updatedAt), itemId] as const;
}
type ArrivalKey = ReturnType<typeof arrivalKey>;
export function compareArrival(a: ArrivalKey, b: ArrivalKey): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}

export const STEP_LIMITED_MESSAGE =
  'This step is limited to other agents in the project’s process. Pick another item (hivenod work list shows only what you may take).';

export const HELD_MESSAGE =
  'This item waits for people to answer a question in "Needs you" (asked when the last run gave it back). Nobody can claim it until it is answered. Pick another item (hivenod work list).';

function pausedMessage(a: Pick<Agent, 'pausedReason'>): string {
  return `This agent is paused${a.pausedReason ? ` (${a.pausedReason})` : ''}. It takes no new work until an admin resumes it on its page in Hivenod (Agents).`;
}
function pausedNow(a: Pick<Agent, 'failStreak' | 'guardrails'>): string {
  const n = (a.failStreak ?? 0) + 1;
  return `This agent is now paused after ${n} failed runs in a row (limit ${guardrailsOf(a).maxFailedRuns}). It takes no new work until an admin resumes it in Hivenod.`;
}

/** Token usage for a run's end: what the caller reports, else what the run already recorded. */
function withRunUsage<T extends RunOutcome | RunUsage>(run: Run, o: T): T & RunOutcome {
  return {
    ...o,
    tokensIn: o.tokensIn ?? run.tokensIn,
    tokensOut: o.tokensOut ?? run.tokensOut,
    ...((o.tokensCached ?? run.tokensCached) !== undefined
      ? { tokensCached: o.tokensCached ?? run.tokensCached }
      : {}),
    model: o.model !== undefined ? o.model : run.model,
  };
}
const iso = (t: { toMillis(): number } | null | undefined) =>
  t ? new Date(t.toMillis()).toISOString() : null;

/** The part of a Firestore document snapshot that the work rows read. */
interface WorkDoc {
  id: string;
  data: () => Item;
  /** Raw field access (a snapshot): 'none' gives null for a server timestamp not yet confirmed. */
  get?: (field: string, options: { serverTimestamps: 'none' }) => unknown;
}

export interface WorkRow {
  itemId: string;
  projectId: string;
  project: string;
  title: string;
  type: string;
  stepId: string;
  step: string;
  status: string;
  claim: { runId: string; mine: boolean; stale: boolean } | null;
  progress: { done: number; total: number } | null;
  sendBackCount: number;
  /**
   * 'shape': a new item waiting to be shaped (card st5INNZj). Claiming it starts a shaping run:
   * pick the steps it needs (shape), do not do its work. Any agent on the project may shape.
   */
  job: 'shape' | null;
}

/** Why an item is at its step now (channel mode, card KLCTVnX8). */
export type Arrival =
  | { why: 'arrived' }
  | { why: 'sent_back'; by: string; text: string }
  | { why: 'answered'; by: string; text: string; question?: string };

export class HiveClient {
  readonly workspaceId: string;
  readonly uid: string;
  readonly db: Firestore;
  private agent: Agent;
  private readonly ctx: ActionContext;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastBeatEventMs = new Map<string, number>();
  private readonly nextLog = new Map<string, number>();
  private readonly itemProject = new Map<string, string>();
  /** The hand-out order key of each work row seen (see arrivalKey). */
  private readonly arrivalKeys = new Map<string, ArrivalKey>();
  /** Last problem an automatic heartbeat hit; surfaced by `whoami` style callers and tests. */
  autoHeartbeatError: string | null = null;

  private constructor(
    private readonly app: FirebaseApp,
    private readonly auth: Auth,
    db: Firestore,
    uid: string,
    workspaceId: string,
    agent: Agent,
    private readonly intervalMs: number,
  ) {
    this.db = db;
    this.uid = uid;
    this.workspaceId = workspaceId;
    this.agent = agent;
    this.ctx = { workspaceId, actor: { type: 'agent', id: uid, name: agent.name } };
  }

  /** Signs in with the token. The Firebase SDK refreshes the session for as long as we run. */
  static async connect(opts: ConnectOptions = {}): Promise<HiveClient> {
    const token = opts.token ?? resolveToken()?.token;
    if (!token) {
      throw new HiveError(
        'HIVENOD_TOKEN is not set and this terminal is not paired. Run `hivenod pair` to pair it with Hivenod, or set HIVENOD_TOKEN.',
      );
    }
    try {
      decodeToken(token);
    } catch {
      throw new HiveError(
        'HIVENOD_TOKEN is not a valid Hivenod agent token (it starts with hive_agt_).',
      );
    }
    const { app, auth, db } = firebaseApp(opts);
    try {
      const { uid, workspaceId } = await signInWithToken(auth, token);
      let agent: Agent;
      try {
        const snap = await getDoc(
          doc(db, paths.agent(workspaceId, uid)).withConverter(converters.agent),
        );
        const data = snap.data();
        if (!data) throw new HiveError(REVOKED_MESSAGE);
        agent = data;
      } catch (e) {
        if (e instanceof HiveError) throw e;
        throw new HiveError(REVOKED_MESSAGE);
      }
      if (agent.revokedAt) throw new HiveError(REVOKED_MESSAGE);
      return new HiveClient(
        app,
        auth,
        db,
        uid,
        workspaceId,
        agent,
        opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      );
    } catch (e) {
      await terminate(db).catch(() => undefined);
      await deleteApp(app).catch(() => undefined);
      if (e instanceof HiveError) throw e;
      if (isRateLimited(e)) throw new HiveError(RATE_LIMIT_MESSAGE);
      if (errorCode(e).startsWith('auth/')) {
        throw new HiveError(
          'Hivenod rejected this token. The agent may have been revoked or rotated: ask an admin for a new one.',
        );
      }
      throw e;
    }
  }

  /** Stops heartbeats and releases the connection so the process can exit. */
  async close(): Promise<void> {
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    await terminate(this.db).catch(() => undefined);
    await deleteApp(this.app).catch(() => undefined);
  }

  // ---------- reading ----------

  /** Reads this agent's own doc again (settings, pause) and keeps it for later calls. */
  async refreshAgent(): Promise<Agent> {
    let data: Agent | undefined;
    try {
      const snap = await getDoc(
        doc(this.db, paths.agent(this.workspaceId, this.uid)).withConverter(converters.agent),
      );
      data = snap.data();
    } catch (e) {
      if (errorCode(e) === 'permission-denied') throw new HiveError(REVOKED_MESSAGE);
      throw e;
    }
    if (!data || data.revokedAt) throw new HiveError(REVOKED_MESSAGE);
    this.agent = data;
    return data;
  }

  /** Throws a clear message when this agent is paused (no new work until an admin resumes it). */
  private async requireNotPaused(): Promise<Agent> {
    const a = await this.refreshAgent();
    if (isPaused(a)) throw new HiveError(pausedMessage(a));
    return a;
  }

  private async getProject(projectId: string): Promise<Project> {
    const snap = await this.read(() =>
      getDoc(
        doc(this.db, paths.project(this.workspaceId, projectId)).withConverter(converters.project),
      ),
    );
    const data = snap.data();
    if (!data) throw new HiveError(`Project ${projectId} not found, or this agent may not use it`);
    return data;
  }

  private async projectIds(): Promise<string[]> {
    const ids = this.agent.projectIds;
    if (ids !== '*') return ids;
    const snap = await this.read(() =>
      getDocs(collection(this.db, `workspaces/${this.workspaceId}/projects`)),
    );
    return snap.docs.map((d) => d.id);
  }

  /** Finds an item by id in the projects this agent may use. */
  private async load(itemId: string, projectId?: string): Promise<Loaded> {
    const candidates = projectId
      ? [projectId]
      : [
          ...(this.itemProject.has(itemId) ? [this.itemProject.get(itemId) as string] : []),
          ...(await this.projectIds()),
        ];
    for (const pid of new Set(candidates)) {
      const snap = await this.read(() =>
        getDoc(
          doc(this.db, paths.item(this.workspaceId, pid, itemId)).withConverter(converters.item),
        ),
      ).catch((e: unknown) => {
        if (e instanceof HiveError) return null;
        throw e;
      });
      const item = snap?.data();
      if (item) {
        this.itemProject.set(itemId, pid);
        return { projectId: pid, itemId, item, project: await this.getProject(pid) };
      }
    }
    throw new HiveError(
      `Item ${itemId} not found. Check the id (hivenod work list) and that this agent may use its project.`,
    );
  }

  private async loadRun(runId: string): Promise<Run> {
    const snap = await this.read(() =>
      getDoc(doc(this.db, paths.run(this.workspaceId, runId)).withConverter(converters.run)),
    );
    const run = snap.data();
    if (!run || run.agentUid !== this.uid)
      throw new HiveError(`Run ${runId} not found (it must be one of your own)`);
    return run;
  }

  /** Runs a read and turns a permission error into a message a person can act on. */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (errorCode(e) === 'permission-denied') throw new HiveError(await this.diagnose(null));
      throw e;
    }
  }

  // ---------- writing ----------

  /** Commits one plan. A denied write is explained (gate, someone else's claim, revoked, …). */
  async write(plan: Pick<ActionPlan, 'ops'>, at?: Loc): Promise<void> {
    try {
      await applyPlan(this.db, plan);
    } catch (e) {
      if (errorCode(e) === 'permission-denied')
        throw new HiveError(await this.diagnose(at ?? null));
      throw e;
    }
  }

  private async diagnose(at: Loc | null): Promise<string> {
    try {
      const me = await getDoc(doc(this.db, paths.agent(this.workspaceId, this.uid)));
      if (!me.exists() || me.data()?.revokedAt) return REVOKED_MESSAGE;
      if (me.data()?.pausedAt) return pausedMessage(me.data() as Agent);
    } catch {
      return REVOKED_MESSAGE;
    }
    if (at) {
      try {
        const loaded = await this.load(at.itemId, at.projectId);
        const step = loaded.project.steps.find((s) => s.id === loaded.item.stepId);
        if (step?.kind === 'human' && !isUnshaped(loaded.item)) return GATE_MESSAGE;
        if (loaded.item.awaitingAnswer) return HELD_MESSAGE;
        // A person pressed Stop work (card BrK0r2FE): the claim and the run are gone.
        if (loaded.item.workStopped && !loaded.item.claim) {
          const run = await this.loadRun(loaded.item.workStopped.runId).catch(() => null);
          return run?.status === 'stopped' ? stoppedMessage(run) : ON_HOLD_MESSAGE;
        }
        if (!loaded.item.claim && !agentMayTakeStep(loaded.project, loaded.item.stepId, this.uid))
          return STEP_LIMITED_MESSAGE;
        const claim = loaded.item.claim;
        if (claim && claim.agentUid !== this.uid) return 'Another agent holds this item right now.';
      } catch {
        /* fall through to the generic message */
      }
    }
    return 'Hivenod refused this change (permission denied). This agent may not be allowed on this project, or the item is no longer in the state it was read in. Read the item again with hivenod item read.';
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ActionError) throw new HiveError(e.message);
      throw e;
    }
  }

  // ---------- operations (SPEC section 10) ----------

  whoami() {
    return {
      agentUid: this.uid,
      name: this.agent.name,
      workspaceId: this.workspaceId,
      projectIds: this.agent.projectIds,
      paused: isPaused(this.agent),
      pausedReason: this.agent.pausedReason ?? null,
      guardrails: guardrailsOf(this.agent),
    };
  }

  /** Turns the item documents of one project into the rows an agent may take now. */
  private workRows(
    pid: string,
    project: Project,
    docs: WorkDoc[],
    filter: { stepId?: string },
  ): WorkRow[] {
    const agentSteps = new Map(
      project.steps.filter((s) => s.kind === 'agent').map((s) => [s.id, s]),
    );
    const out: WorkRow[] = [];
    for (const d of docs) {
      const item = d.data();
      const shaping = isUnshaped(item);
      // An unshaped item is shaping work at its first step, whatever that step is.
      const step = shaping
        ? project.steps.find((s) => s.id === item.stepId)
        : agentSteps.get(item.stepId);
      if (!step || (filter.stepId && item.stepId !== filter.stepId)) continue;
      // Held for people's answer (e.g. after an agent's question): nobody may claim it.
      if (item.awaitingAnswer) continue;
      // On hold after Stop work, Go back (card BrK0r2FE) until someone presses Resume.
      if (isOnHold(item)) continue;
      const claim = item.claim;
      const mine = claim?.agentUid === this.uid;
      const stale = !!claim && Date.now() - claim.heartbeatAt.toMillis() > 10 * 60_000;
      if (claim && !mine && !stale) continue;
      // A step limited to other agents is not work for this one (the rules deny the claim too).
      if (!mine && !shaping && !agentMayTakeStep(project, item.stepId, this.uid)) continue;
      this.itemProject.set(d.id, pid);
      // This client's own write that moved the item (a complete, a send-back) is still pending: the
      // SDK's local estimate of a server timestamp is cut to whole seconds, which sorts the item
      // before everything that arrived earlier in the same second. It moved just now: use that.
      const pending = d.get?.('stepAt', { serverTimestamps: 'none' }) === null;
      this.arrivalKeys.set(
        d.id,
        pending
          ? ([Date.now(), Math.floor(item.updatedAt?.toMillis() ?? 0), d.id] as const)
          : arrivalKey(item, d.id),
      );
      out.push({
        itemId: d.id,
        projectId: pid,
        project: project.name,
        title: item.title,
        type: item.type,
        stepId: item.stepId,
        step: shaping ? 'Shaping' : step.name,
        status: item.status,
        claim: claim ? { runId: claim.runId, mine, stale } : null,
        progress: item.progress,
        sendBackCount: item.sendBackCount,
        job: shaping ? 'shape' : null,
      });
    }
    return out;
  }

  private workQuery(pid: string) {
    return query(
      collection(this.db, `workspaces/${this.workspaceId}/projects/${pid}/items`).withConverter(
        converters.item,
      ),
      where('status', 'in', ['queued', 'working']),
    );
  }

  async listWork(filter: { projectId?: string; stepId?: string } = {}): Promise<WorkRow[]> {
    await this.requireNotPaused();
    const ids = filter.projectId ? [filter.projectId] : await this.projectIds();
    const out: WorkRow[] = [];
    for (const pid of ids) {
      const project = await this.getProject(pid);
      const snap = await this.read(() => getDocs(this.workQuery(pid)));
      out.push(...this.workRows(pid, project, snap.docs, filter));
    }
    return this.oldestFirst(out);
  }

  /** Rows in hand-out order: oldest first by when they reached their step (item QjTTL). */
  private oldestFirst(rows: WorkRow[]): WorkRow[] {
    const key = (r: WorkRow) => this.arrivalKeys.get(r.itemId) ?? ([0, 0, r.itemId] as const);
    return rows.sort((a, b) => compareArrival(key(a), key(b)));
  }

  /**
   * Waits until there is work for this agent and returns it (same rows as listWork). Listens live,
   * so an item that reaches an agent step (for example right after a human approves a gate) is
   * seen within about a second. Returns `{ timedOut: true, work: [] }` after `timeoutMs`
   * (default 10 minutes) so the caller can loop. Stale claims are re-checked every 30 s.
   */
  async waitForWork(
    filter: {
      projectId?: string;
      stepId?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      /** Items that are not new work for the caller (a channel session's held items). */
      exclude?: (itemId: string) => boolean;
    } = {},
  ): Promise<{ timedOut: boolean; work: WorkRow[] }> {
    const timeoutMs = filter.timeoutMs ?? 10 * 60_000;
    await this.requireNotPaused();
    const ids = filter.projectId ? [filter.projectId] : await this.projectIds();
    const projects = new Map<string, Project>();
    for (const pid of ids) projects.set(pid, await this.getProject(pid));
    return new Promise((resolve, reject) => {
      const latest = new Map<string, WorkDoc[]>();
      const stops: (() => void)[] = [];
      let done = false;
      const finish = (timedOut: boolean, err?: unknown, work: WorkRow[] = []) => {
        if (done) return;
        done = true;
        stops.forEach((f) => f());
        clearTimeout(timer);
        clearInterval(tick);
        filter.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve({ timedOut, work: timedOut ? [] : work });
      };
      const check = (): void => {
        if (done) return;
        const ex = filter.exclude;
        const rows = this.collect(projects, latest, filter).filter((r) => !ex?.(r.itemId));
        if (rows.length) finish(false, undefined, rows);
      };
      const onAbort = () => finish(true);
      const timer = setTimeout(() => finish(true), timeoutMs);
      // Also re-checks stale claims (a claim going stale does not touch the item).
      const tick = setInterval(check, 30_000);
      if (filter.signal?.aborted) return finish(true);
      filter.signal?.addEventListener('abort', onAbort);
      for (const pid of ids) {
        stops.push(
          onSnapshot(
            this.workQuery(pid),
            // Metadata changes tell us when the server has answered; cached rows may be stale.
            { includeMetadataChanges: true },
            (snap) => {
              if (snap.metadata.fromCache) return;
              latest.set(pid, snap.docs);
              check();
            },
            (e) =>
              errorCode(e) === 'permission-denied'
                ? this.diagnose(null).then(
                    (m) => finish(false, new HiveError(m)),
                    (x) => finish(false, x),
                  )
                : finish(false, e),
          ),
        );
      }
    });
  }

  private collect(
    projects: Map<string, Project>,
    latest: Map<string, WorkDoc[]>,
    filter: { stepId?: string },
  ): WorkRow[] {
    const out: WorkRow[] = [];
    for (const [pid, docs] of latest) {
      const project = projects.get(pid);
      if (project) out.push(...this.workRows(pid, project, docs, filter));
    }
    return this.oldestFirst(out);
  }

  /** Claims an item and starts a run. Idempotent for an item this agent already holds. */
  async claim(itemId: string, projectId?: string) {
    const l = await this.load(itemId, projectId);
    const step = l.project.steps.find((s) => s.id === l.item.stepId);
    const shaping = isUnshaped(l.item);
    if (step?.kind !== 'agent' && !shaping) throw new HiveError(GATE_MESSAGE);
    // The hold and the pause come first: they also stop resuming an item this agent still holds.
    if (l.item.awaitingAnswer) throw new HiveError(HELD_MESSAGE);
    if (isOnHold(l.item)) throw new HiveError(ON_HOLD_MESSAGE);
    await this.requireNotPaused();
    if (l.item.claim?.agentUid === this.uid) {
      // Resume only a run that is still open. After `run end` without complete the claim is
      // still ours but its run is over: a new run takes it on (the rules allow that).
      const own = await this.loadRun(l.item.claim.runId);
      if (!own.endedAt) {
        this.trackRun(l.item.claim.runId);
        return this.claimResult(l, l.item.claim.runId, true);
      }
    }
    if (!shaping && !agentMayTakeStep(l.project, l.item.stepId, this.uid))
      throw new HiveError(STEP_LIMITED_MESSAGE);
    if (l.item.status === 'suggested')
      throw new HiveError(
        'This is a suggestion waiting for people to add it or dismiss it. It is not work yet.',
      );
    if (l.item.status === 'done' || l.item.status === 'stopped')
      throw new HiveError(`This item is ${l.item.status}; there is nothing to claim.`);
    const c = l.item.claim?.agentUid === this.uid ? undefined : l.item.claim;
    if (c && Date.now() - c.heartbeatAt.toMillis() <= 10 * 60_000)
      throw new HiveError('Another agent holds this item right now (its heartbeat is recent).');
    // Taking over another agent's stale claim also closes its open run (e.g. the CLI was cut
    // off by a revoke or a crash), so that run does not show as running forever.
    let takeover: { runId: string } | undefined;
    if (c) {
      const old = await getDoc(
        doc(this.db, paths.run(this.workspaceId, c.runId)).withConverter(converters.run),
      ).catch(() => null);
      if (old?.data() && !old.data()!.endedAt) takeover = { runId: c.runId };
    }
    const p = this.wrap(() =>
      claimItem(this.ctx, {
        projectId: l.projectId,
        itemId,
        item: l.item,
        takeover,
        ...(shaping ? { job: 'shape' as const } : {}),
      }),
    );
    await this.write(p, l);
    this.lastBeatEventMs.set(p.runId, Date.now());
    this.trackRun(p.runId);
    return this.claimResult(l, p.runId, false);
  }

  private claimResult(l: Loaded, runId: string, resumed: boolean) {
    return {
      runId,
      resumed,
      itemId: l.itemId,
      projectId: l.projectId,
      title: l.item.title,
      stepId: l.item.stepId,
      job: isUnshaped(l.item) ? ('shape' as const) : null,
      hint: isUnshaped(l.item)
        ? 'A shaping run: read the item and the step library (read_item / hivenod item read), then choose the steps it needs with shape_item / hivenod item shape. Do not do the work itself.'
        : 'Call read_item / hivenod item read for the full brief, then log, attach and complete.',
    };
  }

  async log(runId: string, text: string, level: 'info' | 'warn' | 'error' = 'info') {
    const run = await this.loadRun(runId);
    if (run.status === 'stopped') throw new HiveError(stoppedMessage(run));
    if (run.endedAt)
      throw new HiveError('This run has ended; start a new one with hivenod work claim.');
    let n = this.nextLog.get(runId);
    if (n === undefined) n = await this.countLog(runId);
    for (let attempt = 0; ; attempt++) {
      const op = this.wrap(() => logLine(this.ctx, { runId, n: n as number, level, text }));
      try {
        await applyPlan(this.db, { ops: [op as WriteOp] });
        break;
      } catch (e) {
        // Another process wrote this number first: count again and retry once.
        if (attempt === 0 && errorCode(e) === 'permission-denied') {
          n = await this.countLog(runId);
          continue;
        }
        if (errorCode(e) === 'permission-denied')
          throw new HiveError(
            await this.diagnose({ projectId: run.projectId, itemId: run.itemId }),
          );
        throw e;
      }
    }
    this.nextLog.set(runId, n + 1);
    return { runId, line: n };
  }

  private async countLog(runId: string): Promise<number> {
    const snap = await this.read(() =>
      getDocs(collection(this.db, `workspaces/${this.workspaceId}/runs/${runId}/log`)),
    );
    return snap.size;
  }

  /** One heartbeat (an event is written at most every 5 minutes; rules coalesce the rest). */
  async heartbeat(runId: string) {
    const run = await this.loadRun(runId);
    if (run.status === 'stopped') throw new HiveError(stoppedMessage(run));
    if (run.endedAt) throw new HiveError('This run has ended; nothing to keep alive.');
    const last = this.lastBeatEventMs.get(runId) ?? toMs(run.heartbeatEventAt) ?? 0;
    const p = this.wrap(() =>
      heartbeatAction(this.ctx, {
        projectId: run.projectId,
        itemId: run.itemId,
        runId,
        lastHeartbeatEventAtMs: last,
      }),
    );
    await this.write(p, run);
    if (p.eventId) this.lastBeatEventMs.set(runId, Date.now());
    return { runId, event: p.eventId !== null };
  }

  /** Beat every minute while this process lives and the run is open. */
  trackRun(runId: string): void {
    if (this.timers.has(runId)) return;
    const timer = setInterval(() => {
      this.heartbeat(runId).then(
        () => {
          this.autoHeartbeatError = null;
        },
        (e: unknown) => {
          this.autoHeartbeatError = messageOf(e);
          this.untrackRun(runId);
        },
      );
    }, this.intervalMs);
    timer.unref();
    this.timers.set(runId, timer);
  }

  untrackRun(runId: string): void {
    const t = this.timers.get(runId);
    if (t) clearInterval(t);
    this.timers.delete(runId);
  }

  async attach(
    itemId: string,
    source: string,
    opts: { name?: string; projectId?: string; deny?: readonly string[] } = {},
  ) {
    const l = await this.load(itemId, opts.projectId);
    const prepared = await prepareAttachment(source, opts);
    const runId = l.item.claim?.agentUid === this.uid ? l.item.claim.runId : null;
    const p = this.wrap(() =>
      attachAction(this.ctx, { projectId: l.projectId, itemId, runId, ...prepared }),
    );
    await this.write(p, l);
    return { attachmentId: p.attachmentId, name: prepared.name, kind: prepared.kind };
  }

  async ask(itemId: string, text: string, projectId?: string) {
    const l = await this.load(itemId, projectId);
    const claim = l.item.claim;
    if (!claim)
      throw new HiveError(
        `You have not claimed this item, so you cannot ask a question on it yet. Run hivenod work claim ${itemId} first.`,
      );
    if (claim.agentUid !== this.uid)
      throw new HiveError('Another agent holds this item right now.');
    const runId = claim.runId;
    const p = this.wrap(() =>
      postMessage(this.ctx, { projectId: l.projectId, itemId, kind: 'question', text, runId }),
    );
    await this.write(p, l);
    return { messageId: p.messageId, note: 'The question now shows under "Needs you" in Hivenod.' };
  }

  async progress(itemId: string, done: number, total: number, projectId?: string) {
    if (!Number.isInteger(done) || !Number.isInteger(total) || done < 0 || total < done)
      throw new HiveError('Progress needs whole numbers with 0 <= done <= total.');
    const l = await this.load(itemId, projectId);
    const p = this.wrap(() =>
      reportProgress(this.ctx, {
        projectId: l.projectId,
        itemId,
        item: l.item,
        progress: { done, total },
      }),
    );
    await this.write(p, l);
    return { itemId, progress: { done, total } };
  }

  /**
   * Parks the item this agent holds (item QjTTL): it waits on something outside the agent. It
   * stays claimed; a channel session no longer counts it toward max_items.
   */
  async park(itemId: string, reason: string, projectId?: string) {
    const l = await this.load(itemId, projectId);
    const p = this.wrap(() =>
      parkItem(this.ctx, { projectId: l.projectId, itemId, item: l.item, reason }),
    );
    await this.write(p, l);
    return { itemId, parked: { reason: reason.trim() } };
  }

  /** The parked item this agent holds is active again (item QjTTL). No write when not parked. */
  async unpark(itemId: string, projectId?: string) {
    const l = await this.load(itemId, projectId);
    if (!parkOf(l.item)) return { itemId, parked: null, changed: false };
    const p = this.wrap(() =>
      unparkItem(this.ctx, { projectId: l.projectId, itemId, item: l.item }),
    );
    await this.write(p, l);
    return { itemId, parked: null, changed: true };
  }

  async raiseFinding(itemId: string, title: string, details: string, projectId?: string) {
    const l = await this.load(itemId, projectId);
    const p = this.wrap(() =>
      raiseFinding(this.ctx, {
        project: l.project,
        projectId: l.projectId,
        parentItemId: itemId,
        parent: l.item,
        title,
        details,
      }),
    );
    await this.write(p, l);
    const first = l.project.steps[0]?.name ?? 'the first step';
    return {
      findingItemId: p.itemId,
      status: 'suggested' as const,
      note: `Suggested to people: it waits in the ${first} suggestions until someone adds it or dismisses it. It is not work: it never shows in work list and cannot be claimed.`,
    };
  }

  async endRun(runId: string, status: 'done' | 'failed', outcome: RunOutcome = {}) {
    const run = await this.loadRun(runId);
    if (run.status === 'stopped') throw new HiveError(stoppedMessage(run));
    if (run.endedAt) throw new HiveError('This run has already ended.');
    const result = { ...withRunUsage(run, outcome), status };
    // A failed run gives the item back: left claimed it would show "working" for ever. A run that
    // ended as done keeps the claim, so `complete` can still move the item on.
    const l = status === 'failed' ? await this.load(run.itemId, run.projectId) : null;
    const held = l?.item.claim?.agentUid === this.uid && l.item.claim.runId === runId;
    const paused = await this.writeWithStreak(
      (agent) =>
        this.wrap(() =>
          held && l
            ? releaseClaim(this.ctx, {
                projectId: l.projectId,
                itemId: run.itemId,
                item: l.item,
                result,
                status: 'failed',
                agent,
              })
            : endRunAction(this.ctx, {
                projectId: run.projectId,
                itemId: run.itemId,
                runId,
                result,
                agent,
              }),
        ),
      run,
    );
    this.untrackRun(runId);
    return {
      runId,
      ...result,
      ...(held ? { released: true } : {}),
      ...(paused ? { agentPaused: true, note: paused } : {}),
    };
  }

  /**
   * Watches one of this agent's runs live (card BrK0r2FE): calls `onStopped` once when a person
   * stops it in Hivenod (status `stopped`), usually within a second. Returns the unsubscribe.
   */
  watchRun(runId: string, onStopped: (run: Run) => void): () => void {
    let fired = false;
    return onSnapshot(
      doc(this.db, paths.run(this.workspaceId, runId)).withConverter(converters.run),
      (snap) => {
        let run: Run | undefined;
        try {
          run = snap.data();
        } catch {
          return; // a shape this client does not know: not a stop
        }
        if (!fired && run?.status === 'stopped') {
          fired = true;
          onStopped(run);
        }
      },
      // A broken listener is not a stop: the heartbeats still notice one (within a minute).
      () => undefined,
    );
  }

  /**
   * Gives an item this agent holds back to the queue (claim cleared, run ended as released, or
   * left as it ended when `run end` already closed it). Nothing else changes: the item stays at
   * its step for any agent to claim.
   */
  async release(itemId: string, projectId?: string) {
    const l = await this.load(itemId, projectId);
    const c = l.item.claim;
    if (c?.agentUid !== this.uid)
      throw new HiveError('You do not hold this item, so there is nothing to release.');
    const run = await this.loadRun(c.runId);
    const p = this.wrap(() =>
      releaseClaim(this.ctx, {
        projectId: l.projectId,
        itemId,
        item: l.item,
        result: withRunUsage(run, {}),
        runEnded: !!run.endedAt,
      }),
    );
    await this.write(p, l);
    this.untrackRun(c.runId);
    return { itemId, runId: c.runId, released: true };
  }

  /**
   * Writes a plan that ends a run together with this agent's failure streak (it pauses the agent
   * after too many failed runs in a row). Returns the pause message when this write paused it.
   * If the streak write is refused (another session of this agent ended a run at the same
   * moment) the agent is read again and the write retried; the run's end is never lost.
   */
  private async writeWithStreak(
    build: (agent: AgentGuardState | undefined) => Pick<ActionPlan, 'ops'>,
    at: Loc,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const agent = await this.refreshAgent();
      const p = build(agent);
      try {
        await applyPlan(this.db, p);
        const pausing = p.ops.some(
          (o) => o.path === paths.agent(this.workspaceId, this.uid) && 'pausedAt' in (o.data ?? {}),
        );
        return pausing ? pausedNow(agent) : null;
      } catch (e) {
        if (errorCode(e) !== 'permission-denied') throw e;
      }
    }
    await this.write(build(undefined), at);
    return null;
  }

  /**
   * Reports this run's token usage so far (running totals; they only grow) and the model. Usage is
   * tracked and shown, never limited: nothing here stops a run over tokens.
   */
  async reportUsage(runId: string, usage: RunUsage & { costEur?: number }) {
    for (const [k, v] of Object.entries({
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      tokensCached: usage.tokensCached ?? 0,
    }))
      if (!Number.isInteger(v) || v < 0) throw new HiveError(`${k} must be a whole number >= 0.`);
    if ((usage.tokensCached ?? 0) > usage.tokensIn)
      throw new HiveError('tokensCached is part of tokensIn, so it cannot be larger.');
    const run = await this.loadRun(runId);
    if (run.status === 'stopped') throw new HiveError(stoppedMessage(run));
    if (run.endedAt)
      throw new HiveError('This run has ended; start a new one with hivenod work claim.');
    if (
      usage.tokensIn < run.tokensIn ||
      usage.tokensOut < run.tokensOut ||
      (usage.tokensCached ?? run.tokensCached ?? 0) < (run.tokensCached ?? 0)
    )
      throw new HiveError(
        `Report running totals for the whole run; they only grow (so far: ${run.tokensIn} in, ${run.tokensOut} out).`,
      );
    const last = this.lastBeatEventMs.get(runId) ?? toMs(run.heartbeatEventAt) ?? 0;
    const p = this.wrap(() =>
      heartbeatAction(this.ctx, {
        projectId: run.projectId,
        itemId: run.itemId,
        runId,
        lastHeartbeatEventAtMs: last,
        usage:
          usage.costEur === undefined
            ? usage
            : { ...usage, costEur: Math.max(usage.costEur, run.costEur ?? 0) },
      }),
    );
    await this.write(p, run);
    if (p.eventId) this.lastBeatEventMs.set(runId, Date.now());
    return { runId, newTokens: newTokens(usage) };
  }

  /**
   * Gives the item back without moving it (used by `hivenod run`): the run ends as `released` (a
   * question for people, Ctrl+C) or `failed` (the CLI failed; counts toward the pause). With
   * `holdFor` (an open question this agent asked on the item) nobody can claim the item until
   * people answer. Returns the pause message when this failure paused the agent.
   */
  async releaseRun(
    runId: string,
    opts: { status?: 'released' | 'failed'; holdFor?: string; outcome?: RunOutcome } = {},
  ): Promise<{ status: 'released' | 'failed'; held: boolean; agentPaused: string | null }> {
    const run = await this.loadRun(runId);
    if (run.status === 'stopped') throw new HiveError(stoppedMessage(run));
    if (run.endedAt) throw new HiveError('This run has already ended.');
    const status = opts.status ?? 'released';
    const l = await this.load(run.itemId, run.projectId);
    const result = withRunUsage(run, opts.outcome ?? {});
    let paused: string | null;
    let held = false;
    if (l.item.claim?.agentUid === this.uid && l.item.claim.runId === runId) {
      held = !!opts.holdFor;
      paused = await this.writeWithStreak(
        (agent) =>
          this.wrap(() =>
            releaseClaim(this.ctx, {
              projectId: l.projectId,
              itemId: run.itemId,
              item: l.item,
              result,
              status,
              agent,
              ...(opts.holdFor ? { holdFor: opts.holdFor } : {}),
            }),
          ),
        l,
      );
    } else {
      // The claim is gone (released as stalled): only the run is left to close.
      paused = await this.writeWithStreak(
        (agent) =>
          this.wrap(() =>
            endRunAction(this.ctx, {
              projectId: run.projectId,
              itemId: run.itemId,
              runId,
              result: { ...result, status: 'failed' },
              agent,
            }),
          ),
        run,
      );
    }
    this.untrackRun(runId);
    return { status, held, agentPaused: paused };
  }

  // ---------- channel mode (card KLCTVnX8) ----------

  /**
   * Why an item is at its step now, from the event that put it there (its lastEventId): sent
   * back by an agent or a person (with the reason), handed back by a person's answer (with the
   * answer and the question), or just arrived. Best effort: an unreadable event is 'arrived'.
   */
  async arrivalOf(itemId: string, projectId?: string): Promise<Arrival> {
    const l = await this.load(itemId, projectId);
    const eid = l.item.lastEventId;
    const base = `workspaces/${this.workspaceId}/projects/${l.projectId}`;
    try {
      const ev = await getDoc(doc(this.db, paths.event(this.workspaceId, eid)));
      const e = ev.data() as
        { type: string; actor: { name: string }; data: Record<string, unknown> } | undefined;
      if (e?.type === 'item.sentBack')
        return { why: 'sent_back', by: e.actor.name, text: String(e.data.reason ?? '') };
      if (e?.type === 'decision.sentBack') {
        const d = await getDoc(doc(this.db, `${base}/decisions/${eid}`));
        return { why: 'sent_back', by: e.actor.name, text: String(d.data()?.rationale ?? '') };
      }
      if (e?.type === 'decision.answered') {
        const a = (await getDoc(doc(this.db, `${base}/items/${itemId}/messages/${eid}`))).data();
        const q = a?.replyTo
          ? (await getDoc(doc(this.db, `${base}/items/${itemId}/messages/${a.replyTo}`))).data()
          : undefined;
        return {
          why: 'answered',
          by: e.actor.name,
          text: String(a?.text ?? ''),
          ...(q ? { question: String(q.text ?? '') } : {}),
        };
      }
    } catch {
      /* not readable: just say it arrived */
    }
    return { why: 'arrived' };
  }

  /** Live item doc (null when it is gone or unreadable). Returns the unsubscribe. */
  watchItem(projectId: string, itemId: string, onChange: (item: Item | null) => void): () => void {
    return onSnapshot(
      doc(this.db, paths.item(this.workspaceId, projectId, itemId)).withConverter(converters.item),
      // Only what the server says: a cached first snapshot may not have the claim yet.
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.metadata.fromCache) return;
        let item: Item | null;
        try {
          item = snap.data() ?? null;
        } catch {
          return; // a shape this client does not know: ignore
        }
        onChange(item);
      },
      () => onChange(null),
    );
  }

  /**
   * Messages added to an item after the listener starts (the ones already there are skipped),
   * with the question an answer replies to. Returns the unsubscribe.
   */
  watchNewMessages(
    projectId: string,
    itemId: string,
    onMessage: (m: Message & { id: string; question: string | null }) => void,
  ): () => void {
    let first = true;
    const texts = new Map<string, string>();
    return onSnapshot(
      collection(
        this.db,
        `workspaces/${this.workspaceId}/projects/${projectId}/items/${itemId}/messages`,
      ).withConverter(converters.message),
      // Only answers from the server count: a first snapshot from the cache would replay old ones.
      { includeMetadataChanges: true },
      (snap) => {
        if (first && snap.metadata.fromCache) return;
        const added: (Message & { id: string })[] = [];
        for (const ch of snap.docChanges()) {
          let m: Message;
          try {
            m = ch.doc.data();
          } catch {
            continue;
          }
          texts.set(ch.doc.id, m.text);
          if (!first && ch.type === 'added') added.push({ ...m, id: ch.doc.id });
        }
        first = false;
        for (const m of added)
          onMessage({ ...m, question: m.replyTo ? (texts.get(m.replyTo) ?? null) : null });
      },
      () => undefined,
    );
  }

  /** Removes the pairing request this terminal was paired with (it has done its job). */
  async deletePairing(code: string): Promise<void> {
    await deleteDoc(doc(this.db, pairingPath(code))).catch(() => undefined);
  }

  /**
   * `--project`: the project's id when this agent may use it (an id or an exact name), else a
   * clear error (the loop stops instead of retrying).
   */
  async checkProject(idOrName: string): Promise<string> {
    const ids = await this.projectIds().catch(() => [] as string[]);
    const names = new Map<string, string>();
    for (const pid of ids) {
      const p = await this.getProject(pid).catch(() => null);
      if (p) names.set(pid, p.name);
    }
    if (names.has(idOrName)) return idOrName;
    const byName = [...names].filter(([, n]) => n.toLowerCase() === idOrName.toLowerCase());
    if (byName.length === 1) return byName[0]![0];
    const list = [...names.values()].join(', ');
    throw new HiveError(
      `This agent cannot use the project "${idOrName}"${list ? `. Its projects: ${list}` : ': it has no projects yet'}. Change its projects in Hivenod (Agents), or run without --project.`,
    );
  }

  /** Tells Hivenod this agent is online (the agents page shows "Online" for 2 minutes). */
  async markSeen(): Promise<void> {
    await updateDoc(doc(this.db, paths.agent(this.workspaceId, this.uid)), {
      lastSeenAt: serverTimestamp(),
      seenHost: hostname().slice(0, 80),
    });
  }

  /**
   * Records the Remote Control link of the interactive Claude session working on a run (card
   * OPpbi0MS), so people can open it from the run in Hivenod. Set once, while the run is open; the
   * rules accept only a claude.ai/code session link.
   */
  async setRemote(runId: string, remote: { url: string; sessionId: string }): Promise<void> {
    await updateDoc(doc(this.db, paths.run(this.workspaceId, runId)), {
      remote: { url: remote.url, sessionId: remote.sessionId },
    });
  }

  /**
   * One terminal per agent (card wvLiSoy8): refuses when another terminal of this agent is alive
   * (seen within the online window, not signed out). Call before pairing or claiming anything.
   */
  checkNoOtherTerminal(now = this.serverNow()): void {
    const t = liveTerminal(this.agent, now);
    if (!t) return;
    throw new HiveError(
      `This agent is already running in another terminal (${t.host ?? 'unknown host'}, last seen ${t.since.toLocaleTimeString()}). Stop it first, or create another agent. (If that terminal crashed, try again in 2 minutes.)`,
    );
  }

  /** Server clock minus local clock (ms), from {@link syncServerClock}; 0 until synced. */
  private clockOffsetMs = 0;

  /** The current time on the server's clock (local clock plus the measured offset). */
  serverNow(): number {
    return Date.now() + this.clockOffsetMs;
  }

  /**
   * Measures how far this machine's clock is from the server's, from the HTTP Date header of the
   * Firestore endpoint (one second resolution), so the "is another terminal alive" check compares
   * server time with server time (card wvLiSoy8). Best effort: on any failure the local clock is used.
   */
  async syncServerClock(fetchFn: typeof fetch = fetch): Promise<void> {
    const host = process.env.FIRESTORE_EMULATOR_HOST;
    const url = host ? `http://${host}/` : 'https://firestore.googleapis.com/';
    try {
      const t0 = Date.now();
      const res = await fetchFn(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      const t1 = Date.now();
      const date = Date.parse(res.headers.get('date') ?? '');
      if (Number.isNaN(date)) return;
      // The header is truncated to the second: add half a second, and use the middle of the round trip.
      this.clockOffsetMs = date + 500 - (t0 + t1) / 2;
    } catch {
      /* keep the local clock */
    }
  }

  /** Tells Hivenod this agent stopped (Ctrl+C, --once, exit): it shows as offline at once. */
  async markOffline(): Promise<void> {
    await updateDoc(doc(this.db, paths.agent(this.workspaceId, this.uid)), {
      signedOutAt: serverTimestamp(),
    });
  }

  /** Names of the projects this agent may use (for the terminal header). */
  async projectNames(): Promise<string[]> {
    if (this.agent.projectIds === '*') return ['all projects'];
    const out: string[] = [];
    for (const pid of this.agent.projectIds) {
      out.push(
        await this.getProject(pid).then(
          (p) => p.name,
          () => pid,
        ),
      );
    }
    return out;
  }

  /**
   * Finishes the step: the item moves one step forward and stops at the next human gate. Ends
   * the run as done (with any cost given), unless `hivenod run end` already ended it.
   */
  async complete(itemId: string, runId: string, outcome: RunOutcome = {}, projectId?: string) {
    const l = await this.load(itemId, projectId);
    const step = l.project.steps.find((s) => s.id === l.item.stepId);
    if (step?.kind !== 'agent') throw new HiveError(GATE_MESSAGE);
    if (l.item.workStopped?.runId === runId && !l.item.claim)
      throw new HiveError(stoppedMessage(await this.loadRun(runId).catch(() => null)));
    if (l.item.claim?.agentUid !== this.uid || l.item.claim.runId !== runId)
      throw new HiveError(
        'You do not hold this item with that run. Claim it first (hivenod work claim).',
      );
    const run = await this.loadRun(runId);
    if (run.endedAt) await this.write(this.completeAfterEnd(l, run), l);
    else
      await this.writeWithStreak(
        (agent) =>
          this.wrap(() =>
            completeStep(this.ctx, {
              project: l.project,
              projectId: l.projectId,
              itemId,
              item: l.item,
              result: withRunUsage(run, outcome),
              agent,
            }),
          ),
        l,
      );
    this.untrackRun(runId);
    const next = this.nextState(l);
    return { itemId, runId, ...next };
  }

  /**
   * Sends the item this agent holds back to an earlier agent step (card KLCTVnX8), with a reason
   * the receiving agent gets. Never across a people step. After MAX_AGENT_SEND_BACKS rounds without
   * a person acting on the item, the item is held for people instead: a question in Needs you
   * with the reasons, the run ends and the item waits at this step until someone answers.
   */
  async sendBack(
    itemId: string,
    runId: string,
    toStepId: string,
    reason: string,
    outcome: RunOutcome = {},
    projectId?: string,
  ) {
    const l = await this.load(itemId, projectId);
    const step = l.project.steps.find((s) => s.id === l.item.stepId);
    if (step?.kind !== 'agent') throw new HiveError(GATE_MESSAGE);
    if (l.item.workStopped?.runId === runId && !l.item.claim)
      throw new HiveError(stoppedMessage(await this.loadRun(runId).catch(() => null)));
    if (l.item.claim?.agentUid !== this.uid || l.item.claim.runId !== runId)
      throw new HiveError(
        'You do not hold this item with that run. Claim it first (hivenod work claim).',
      );
    this.wrap(() => {
      requireSendBackReason(reason);
      checkSendBackTarget(l.project, l.item, toStepId);
    });
    const run = await this.loadRun(runId);
    if (run.endedAt)
      throw new HiveError('This run has ended; claim the item again to send it back.');
    const to = l.project.steps.find((s) => s.id === toStepId)!;
    if (agentRounds(l.item) >= MAX_AGENT_SEND_BACKS) {
      const earlier = (await this.agentSendBacks(l)).map((r) => r.reason);
      const asked = await this.ask(itemId, stuckQuestion(earlier, reason.trim()), l.projectId);
      await this.releaseRun(runId, { holdFor: asked.messageId, outcome });
      return {
        itemId,
        runId,
        sentBack: false,
        heldForPeople: true,
        note: `Agents already sent this item back ${MAX_AGENT_SEND_BACKS} times, so it now waits for people: a question with the reasons is in "Needs you". Their answer hands it back to the agents. Your run has ended.`,
      };
    }
    let round = 0;
    await this.writeWithStreak((agent) => {
      const p = this.wrap(() =>
        agentSendBack(this.ctx, {
          project: l.project,
          projectId: l.projectId,
          itemId,
          item: l.item,
          toStepId,
          reason,
          result: withRunUsage(run, outcome),
          agent,
        }),
      );
      round = p.round;
      return p;
    }, l);
    this.untrackRun(runId);
    return {
      itemId,
      runId,
      sentBack: true,
      movedTo: { stepId: to.id, name: to.name },
      round,
      roundsLeft: MAX_AGENT_SEND_BACKS - round,
    };
  }

  /** Agent send-backs of this item, oldest first (from its item.sentBack events). */
  private async agentSendBacks(l: Loc) {
    const snap = await this.read(() =>
      getDocs(
        query(
          collection(this.db, `workspaces/${this.workspaceId}/events`),
          where('projectId', '==', l.projectId),
          where('itemId', '==', l.itemId),
          where('type', '==', 'item.sentBack'),
        ),
      ),
    ).catch(() => null);
    return (snap?.docs ?? [])
      .map(
        (d) =>
          d.data() as {
            at?: { toMillis(): number };
            actor: { name: string };
            data: Record<string, unknown>;
          },
      )
      .sort((a, b) => (a.at?.toMillis() ?? 0) - (b.at?.toMillis() ?? 0))
      .map((e) => ({
        at: iso(e.at),
        by: e.actor.name,
        fromStepId: String(e.data.fromStepId ?? ''),
        toStepId: String(e.data.toStepId ?? ''),
        reason: String(e.data.reason ?? ''),
      }));
  }

  /** A note on the item this agent holds, for people and the next agent (card KLCTVnX8). */
  async addNote(itemId: string, text: string, projectId?: string) {
    const l = await this.load(itemId, projectId);
    const claim = l.item.claim;
    if (claim?.agentUid !== this.uid)
      throw new HiveError(
        'You can add notes only to the item you are working on (claim it first).',
      );
    const p = this.wrap(() =>
      postMessage(this.ctx, {
        projectId: l.projectId,
        itemId,
        kind: 'note',
        text,
        runId: claim.runId,
      }),
    );
    await this.write(p, l);
    return { messageId: p.messageId };
  }

  /** The run already ended: move the item alone (the run doc is closed to updates). */
  private completeAfterEnd(l: Loaded, run: Run): ActionPlan {
    const whole = this.wrap(() =>
      completeStep(this.ctx, {
        project: l.project,
        projectId: l.projectId,
        itemId: l.itemId,
        item: l.item,
        result: { costEur: run.costEur },
      }),
    );
    const runPath = paths.run(this.workspaceId, (l.item.claim as { runId: string }).runId);
    return { ...whole, ops: whole.ops.filter((o) => o.path !== runPath) };
  }

  private nextState(l: Loaded) {
    // The next step on the item's path: steps it skips are passed over (card st5INNZj).
    const next = nextOnPath(l.project, l.item);
    if (!next) return { movedTo: null, status: 'done', waitingForPeople: false };
    return {
      movedTo: { stepId: next.id, name: next.name },
      status: next.kind === 'human' ? 'waiting' : 'queued',
      waitingForPeople: next.kind === 'human',
    };
  }

  // ---------- per-item paths (card st5INNZj) ----------

  /** The item this agent holds with `runId` (shaping or step work), loaded. */
  private async held(itemId: string, runId: string | null, projectId?: string) {
    const l = await this.load(itemId, projectId);
    const c = l.item.claim;
    if (!c || c.agentUid !== this.uid || (runId && c.runId !== runId))
      throw new HiveError(
        'You do not hold this item. Path changes are for the item you are working on (claim it first).',
      );
    return l;
  }

  /**
   * Ends a shaping run with the path: the steps to skip (with why) and a one-line note. Agent
   * steps are skipped at once; a people step in `skips` is asked of its deciders (it stays on the
   * path until one approves). The item then waits at the first step of its path.
   */
  async shape(
    itemId: string,
    runId: string,
    choice: { skips: Readonly<Record<string, string>>; note: string },
    outcome: RunOutcome = {},
    projectId?: string,
  ) {
    const l = await this.held(itemId, runId, projectId);
    if (!isUnshaped(l.item)) throw new HiveError('This item is already shaped.');
    const unknown = Object.keys(choice.skips).filter(
      (id) => !l.project.steps.some((s) => s.id === id),
    );
    if (unknown.length)
      throw new HiveError(
        `Unknown step id(s): ${unknown.join(', ')}. Use the ids from read_item's path.`,
      );
    const run = await this.loadRun(runId);
    const build = (agent?: AgentGuardState) =>
      this.wrap(() =>
        shapeItem(this.ctx, {
          project: l.project,
          projectId: l.projectId,
          itemId,
          item: l.item,
          skips: choice.skips,
          note: choice.note,
          result: withRunUsage(run, outcome),
          agent,
        }),
      );
    const first = build();
    for (const ask of first.asks) await this.write(ask, l);
    await this.writeWithStreak((agent) => build(agent), l);
    this.untrackRun(runId);
    const names = (ids: string[]) =>
      ids.map((id) => l.project.steps.find((s) => s.id === id)?.name ?? id);
    const at = l.project.steps.find((s) => !first.skipped.includes(s.id));
    return {
      itemId,
      runId,
      skipped: names(first.skipped),
      askedToSkip: names(first.pending),
      firstStep: at?.name ?? null,
      note:
        first.pending.length > 0
          ? 'Shaped. The people steps you asked to skip stay on the path until one of their deciders approves.'
          : 'Shaped.',
    };
  }

  /**
   * Skips an agent step ahead of the current one on the item you hold, or puts it back. Logged on
   * the item; people can undo it. People steps: use askPathChange.
   */
  async skipStep(itemId: string, stepId: string, skip: boolean, reason = '', projectId?: string) {
    const l = await this.held(itemId, null, projectId);
    const p = this.wrap(() =>
      skipStep(this.ctx, {
        project: l.project,
        projectId: l.projectId,
        itemId,
        item: l.item,
        stepId,
        skip,
        reason,
      }),
    );
    await this.write(p, l);
    return { itemId, stepId, skipped: skip };
  }

  /** Asks the deciders of a people step ahead to skip it, or to put a skipped one back. */
  async askPathChange(itemId: string, stepId: string, reason: string, projectId?: string) {
    const l = await this.held(itemId, null, projectId);
    const p = this.wrap(() =>
      askPathChange(this.ctx, {
        project: l.project,
        projectId: l.projectId,
        itemId,
        item: l.item,
        stepId,
        reason,
      }),
    );
    await this.write(p, l);
    return {
      itemId,
      stepId,
      op: p.op,
      note: 'Asked: it shows under "Needs you" for the deciders of that step. Keep going meanwhile; the item waits at that step if it gets there first.',
    };
  }

  /** Proposes a new library step (an approver adds it, or rejects it with a reason). */
  async proposeStep(itemId: string, proposal: ProposalInput, projectId?: string) {
    const l = await this.held(itemId, null, projectId);
    const p = this.wrap(() =>
      proposeStep(this.ctx, {
        project: l.project,
        projectId: l.projectId,
        itemId,
        item: l.item,
        proposal,
      }),
    );
    await this.write(p, l);
    return {
      proposalId: p.proposalId,
      note: 'Proposed: an approver (admins and the project creator) adds it to the library or rejects it. Carry on without it.',
    };
  }

  /** Everything the next agent needs, including why people sent the item back. */
  async readItem(itemId: string, projectId?: string) {
    const l = await this.load(itemId, projectId);
    const base = `workspaces/${this.workspaceId}/projects/${l.projectId}`;
    const [atts, msgs, decs] = await this.read(() =>
      Promise.all([
        getDocs(
          collection(this.db, `${base}/items/${itemId}/attachments`).withConverter(
            converters.attachment,
          ),
        ),
        getDocs(
          collection(this.db, `${base}/items/${itemId}/messages`).withConverter(converters.message),
        ),
        getDocs(
          query(
            collection(this.db, `${base}/decisions`).withConverter(converters.decision),
            where('itemId', '==', itemId),
          ),
        ),
      ]),
    );
    const byTime = <T extends { at: { toMillis(): number } }>(a: T, b: T) =>
      a.at.toMillis() - b.at.toMillis();
    const decisions = decs.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byTime);
    const step = l.project.steps.find((s) => s.id === l.item.stepId);
    return {
      itemId,
      projectId: l.projectId,
      project: l.project.name,
      title: l.item.title,
      type: l.item.type,
      summary: l.item.summary,
      status: l.item.status,
      step: step
        ? {
            id: step.id,
            name: step.name,
            kind: step.kind,
            description: step.description,
            instructions: step.instructions ?? null,
            outputs: step.outputs ?? [],
          }
        : null,
      claim: l.item.claim
        ? { runId: l.item.claim.runId, mine: l.item.claim.agentUid === this.uid }
        : null,
      progress: l.item.progress,
      costEur: l.item.costEur,
      sendBackCount: l.item.sendBackCount,
      // Per-item paths (card st5INNZj): the whole step library and what each step is for this
      // item. 'shape' = a new item waiting for its path (a shaping run decides it).
      job: isUnshaped(l.item) ? ('shape' as const) : null,
      shape: l.item.shape ? { by: l.item.shape.by, note: l.item.shape.note } : null,
      path: stepsOnPath(l.project, l.item).map((p) => ({
        id: p.step.id,
        name: p.step.name,
        kind: p.step.kind,
        description: p.step.description,
        state: p.state,
        ...(p.note ? { skipReason: p.note } : {}),
        ...(p.request
          ? {
              pending: {
                op: p.request,
                reason: ownGet(l.item.pathRequests, p.step.id)?.reason ?? '',
              },
            }
          : {}),
        ...(l.item.pathRefused?.includes(p.step.id) ? { refused: true } : {}),
      })),
      sendBackReasons: decisions
        .filter((d) => d.outcome === 'sentBack')
        .map((d) => ({ at: iso(d.at), toStepId: d.toStepId, reason: d.rationale, tags: d.tags })),
      // Agents sending it back to an earlier agent step (card KLCTVnX8); rounds since a person acted.
      agentSendBacks: {
        rounds: agentRounds(l.item),
        max: MAX_AGENT_SEND_BACKS,
        history: await this.agentSendBacks(l),
        targets: agentSendBackTargets(l.project, l.item).map((s) => ({ id: s.id, name: s.name })),
      },
      decisions: decisions.map((d) => ({
        at: iso(d.at),
        outcome: d.outcome,
        stepId: d.stepId,
        toStepId: d.toStepId,
        byUid: d.byUid,
        rationale: d.rationale,
        tags: d.tags,
      })),
      messages: msgs.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort(byTime)
        .map((m: Message & { id: string }) => ({
          id: m.id,
          at: iso(m.at),
          by: m.by,
          kind: m.kind,
          text: m.text,
          answered: m.answered,
        })),
      attachments: atts.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort(byTime)
        .map((a: Attachment & { id: string }) => ({
          id: a.id,
          at: iso(a.at),
          name: a.name,
          kind: a.kind,
          bytes: originalBytes(a),
          by: a.by,
          url: a.url,
          // Text kinds come back in full; images and PDFs are data URLs, not useful as text.
          content:
            a.kind === 'html' || a.kind === 'markdown' || a.kind === 'text' ? a.content : null,
        })),
    };
  }
}

/**
 * Images and PDFs are stored as base64 data URLs, so `bytes` counts the encoded text. People
 * and agents want the size of the file itself.
 */
export function originalBytes(a: { kind: string; content?: string | null; bytes: number }): number {
  if (a.kind !== 'image' && a.kind !== 'pdf') return a.bytes;
  const m = /^data:[^,]*;base64,(.*)$/s.exec(a.content ?? '');
  if (!m) return a.bytes;
  const b64 = m[1] ?? '';
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}
