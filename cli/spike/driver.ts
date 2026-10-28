/* eslint-disable @typescript-eslint/no-explicit-any -- free-form JSON from the CLI and the logs */
/**
 * Spike driver for the Go CLI (item zLwtX2WEEg3mER4CR74g, part 1). Plays the people side (a
 * throwaway human, all writes through the rules with the shared actions) against the Go spike
 * binary acting as the agent, on the emulators or on production, and measures what the Go side
 * sees. Bundled with esbuild and run with node (cli/spike/soak.sh does both). Never prints a token.
 *
 *   setup   --target emu|prod --dir D       throwaway human + workspace + project + agent
 *   check-a --dir D --spike BIN             reads, a TS-built claim plan applied by Go, a denied write
 *   run     --dir D --spike BIN --duration S --interval S [--dial ADDR]
 *                                           Go listens; the human changes things; latency per change
 *   report  --dir D                         pass/fail from the logs (also after a detached soak)
 *   go-cli  --dir D --bin BIN               the Go CLI: pair (confirmed as the admin), whoami,
 *                                           MCP tools, revoke, logout
 *   cleanup --dir D                         revoke, delete the throwaway users and workspace
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { createAgentIdentity } from '../../packages/shared/src/agentAuth';
import {
  claimItem,
  createAgent,
  createItem,
  createProject,
  createWorkspace,
  postMessage,
  revokeAgent,
  stopWork,
  updateAgentSettings,
  updateItem,
  randomId,
  paths,
  tokenHint,
  buildStepIndex,
  pairingCompletion,
  pairingPath,
  sealToken,
  type ActionContext,
  type Step,
} from '../../packages/shared/src/index';
import { applyPlan } from '../../packages/shared/src/firestore';
import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  inMemoryPersistence,
  initializeAuth,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  terminate,
  updateDoc,
} from 'firebase/firestore';
import { toFirestoreValue } from '../../packages/shared/src/firestore';

const PROD = {
  apiKey: 'AIzaSyCmFfvMHbbGr3lGdc_DefEkomtUOaLH6J4',
  authDomain: 'hivenod.com',
  projectId: 'hive-board-43be',
  appId: '1:493986079810:web:71cf28f12f79f3cf9bf9db',
  messagingSenderId: '493986079810',
};
const EMU_PROJECT = 'hive-rules-test';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] as string) : d;
};
const dir = resolve(opt('dir', '.')!);
const log = (s: string) => console.error(`[driver ${new Date().toISOString()}] ${s}`);

interface World {
  target: 'emu' | 'prod';
  authEmu?: string;
  fsEmu?: string;
  humanUid: string;
  humanEmail: string;
  agentUid: string;
  workspaceId: string;
  projectId: string;
  heldItemId: string;
  steps: Step[];
}
const secretFile = () => join(dir, 'secrets.json'); // 0600: human password + agent token
const worldFile = () => join(dir, 'world.json');
const loadWorld = (): World => JSON.parse(readFileSync(worldFile(), 'utf8'));
const loadSecrets = (): { humanPassword: string; agentToken: string } =>
  JSON.parse(readFileSync(secretFile(), 'utf8'));

function admin(w: Pick<World, 'target' | 'authEmu' | 'fsEmu'>) {
  if (w.target === 'emu') {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = w.authEmu;
    process.env.FIRESTORE_EMULATOR_HOST = w.fsEmu;
  }
  const req = createRequire(resolve('packages/notifier/package.json'));
  const { initializeApp: initAdmin, applicationDefault } = req('firebase-admin/app');
  const { getFirestore: adminDb } = req('firebase-admin/firestore');
  const { getAuth } = req('firebase-admin/auth');
  const projectId = w.target === 'emu' ? EMU_PROJECT : PROD.projectId;
  const app = initAdmin(
    w.target === 'emu' ? { projectId } : { projectId, credential: applicationDefault() },
    `admin-${randomId(6)}`,
  );
  return { auth: getAuth(app), db: adminDb(app) };
}

function webApp(w: Pick<World, 'target' | 'authEmu' | 'fsEmu'>) {
  const app = initializeApp(
    w.target === 'emu' ? { ...PROD, apiKey: 'fake-api-key', projectId: EMU_PROJECT } : PROD,
    `drv-${randomId(6)}`,
  );
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  const db = getFirestore(app);
  if (w.target === 'emu') {
    connectAuthEmulator(auth, `http://${w.authEmu}`, { disableWarnings: true });
    const [h, p] = w.fsEmu!.split(':');
    connectFirestoreEmulator(db, h!, Number(p));
  }
  return { app, auth, db };
}

async function human(w: World) {
  const { auth, db } = webApp(w);
  const cred = await signInWithEmailAndPassword(auth, w.humanEmail, loadSecrets().humanPassword);
  const ctx: ActionContext = {
    workspaceId: w.workspaceId,
    actor: { type: 'human', id: cred.user.uid, name: 'Spike Tester' },
  };
  return { db, ctx };
}

function spikeEnv(w: World, extra: Record<string, string> = {}) {
  const e: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    HIVENOD_TOKEN: loadSecrets().agentToken,
    ...extra,
  };
  if (w.target === 'emu') {
    e.FIREBASE_AUTH_EMULATOR_HOST = w.authEmu!;
    e.FIRESTORE_EMULATOR_HOST = w.fsEmu!;
    e.HIVENOD_PROJECT_ID = EMU_PROJECT;
    e.HIVENOD_FIREBASE_API_KEY = 'fake-api-key';
  }
  return e;
}

function spikeRun(w: World, bin: string, argv: string[], input?: string) {
  const r = spawnSync(bin, argv, { env: spikeEnv(w), input, encoding: 'utf8', timeout: 60_000 });
  const lines = (r.stdout || '')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { status: r.status, lines, stderr: r.stderr };
}

const STEPS = (deciderUid: string): Step[] => [
  { id: 'build', name: 'Build', kind: 'agent', description: 'Agent work' },
  {
    id: 'accept',
    name: 'Accept',
    kind: 'human',
    description: 'Decide',
    gate: {
      deciderUids: [deciderUid],
      groupIds: [],
      rule: 'any',
      n: 1,
      mustInclude: [],
      rejectPolicy: 'one',
      remindAfterHours: 24,
    },
  } as Step,
];

// ---------- setup ----------

async function setup() {
  const target = opt('target') as 'emu' | 'prod';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base: Pick<World, 'target' | 'authEmu' | 'fsEmu'> =
    target === 'emu'
      ? {
          target,
          authEmu: opt('auth-emu', '127.0.0.1:9199'),
          fsEmu: opt('fs-emu', '127.0.0.1:8180'),
        }
      : { target };
  const a = admin(base);
  const humanEmail = `spike-${randomId(10).toLowerCase()}@example.invalid`;
  const humanPassword = randomId(32);
  const user = await a.auth.createUser({
    email: humanEmail,
    password: humanPassword,
    emailVerified: true,
    displayName: 'Spike Tester',
  });
  writeFileSync(secretFile(), JSON.stringify({ humanPassword, agentToken: '' }), { mode: 0o600 });
  const workspaceId = randomId();
  const w: World = {
    ...base,
    humanUid: user.uid,
    humanEmail,
    agentUid: '',
    workspaceId,
    projectId: '',
    heldItemId: '',
    steps: STEPS(user.uid),
  };
  writeFileSync(worldFile(), JSON.stringify(w, null, 2));
  const { db, ctx } = await human(w);
  await applyPlan(db, createWorkspace(ctx, { name: 'Go CLI spike (throwaway)' }));
  const proj = createProject(ctx, {
    name: 'Spike',
    emoji: '🧪',
    color: '#2F5FD0',
    templateId: 'blank',
    steps: w.steps,
    shapeNewItems: false,
  });
  await applyPlan(db, proj);
  w.projectId = proj.projectId;
  const project = { steps: w.steps };
  const held = createItem(ctx, {
    project,
    projectId: w.projectId,
    title: 'held-0',
    type: 'task',
  });
  await applyPlan(db, held);
  w.heldItemId = held.itemId;
  const ident = await createAgentIdentity(
    target === 'emu' ? { ...PROD, apiKey: 'fake-api-key', projectId: EMU_PROJECT } : PROD,
    workspaceId,
    target === 'emu' ? { authEmulatorUrl: `http://${w.authEmu}` } : {},
  );
  await applyPlan(
    db,
    createAgent(ctx, {
      agentUid: ident.uid,
      name: 'Go spike agent',
      color: '#2F5FD0',
      projectIds: [w.projectId],
      tokenHint: tokenHint(ident.token),
    }),
  );
  w.agentUid = ident.uid;
  writeFileSync(secretFile(), JSON.stringify({ humanPassword, agentToken: ident.token }), {
    mode: 0o600,
  });
  chmodSync(secretFile(), 0o600);
  writeFileSync(worldFile(), JSON.stringify(w, null, 2));
  await terminate(db);
  log(`setup ${target}: workspace ${workspaceId}, project ${w.projectId}, agent ${w.agentUid}`);
}

// ---------- (a) reads and writes under the rules ----------

async function checkA() {
  const w = loadWorld();
  const bin = opt('spike')!;
  const results: Record<string, unknown> = {};
  const who = spikeRun(w, bin, ['whoami']);
  results.whoami = who.lines[0];
  const ok1 = who.status === 0 && who.lines[0]?.uid === w.agentUid;

  const itemPath = paths.item(w.workspaceId, w.projectId, w.heldItemId);
  const read = spikeRun(w, bin, ['read', itemPath]);
  const ok2 = read.status === 0 && read.lines[0]?.data?.title === 'held-0';
  results.read = { status: read.status, title: read.lines[0]?.data?.title };

  // Not allowed: reading another organization's doc, and writing a decision as the agent.
  const other = spikeRun(w, bin, ['read', `workspaces/${randomId()}`]);
  const ok3 = other.status !== 0 && other.lines[0]?.code === 'PermissionDenied';
  results.readOther = other.lines[0]?.code;

  const { db, ctx } = await human(w);
  const item = (await getDoc(doc(db, itemPath))).data()!;
  const agentCtx: ActionContext = {
    workspaceId: w.workspaceId,
    actor: { type: 'agent', id: w.agentUid, name: 'Go spike agent' },
  };
  // A move the rules forbid an agent (straight past the people step), as a plain batch.
  const evil = {
    ops: [
      {
        kind: 'update',
        path: itemPath,
        data: { stepId: 'accept', status: 'waiting', lastEventId: 'x' },
      },
    ],
  };
  const denied = spikeRun(w, bin, ['apply'], JSON.stringify(evil));
  const ok4 = denied.status !== 0 && denied.lines[0]?.code === 'PermissionDenied';
  results.forbiddenWrite = denied.lines[0]?.code;

  // The real claim plan, built by the TypeScript shared actions, committed by Go.
  const claim = claimItem(agentCtx, {
    projectId: w.projectId,
    itemId: w.heldItemId,
    item: item as never,
  });
  const applied = spikeRun(w, bin, ['apply'], JSON.stringify(claim));
  const after = (await getDoc(doc(db, itemPath))).data()!;
  const run = (await getDoc(doc(db, paths.run(w.workspaceId, claim.runId)))).data();
  const ev = (await getDoc(doc(db, paths.event(w.workspaceId, claim.eventId)))).data();
  const ok5 =
    applied.status === 0 &&
    after.claim?.agentUid === w.agentUid &&
    after.status === 'working' &&
    run?.status === 'running' &&
    typeof run?.startedAt?.toMillis === 'function' &&
    ev?.type === 'item.claimed' &&
    ev?.actor?.id === w.agentUid;
  results.claim = { status: applied.status, err: applied.lines[0]?.code, runId: claim.runId };
  writeFileSync(join(dir, 'run-id'), claim.runId);
  await terminate(db);
  void ctx;
  const pass = ok1 && ok2 && ok3 && ok4 && ok5;
  results.pass = {
    whoami: ok1,
    read: ok2,
    readOtherDenied: ok3,
    forbiddenWriteDenied: ok4,
    claimApplied: ok5,
  };
  writeFileSync(join(dir, 'check-a.json'), JSON.stringify(results, null, 2));
  log(`check-a ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(results.pass)}`);
  process.exitCode = pass ? 0 : 1;
}

// ---------- (b, c, d) live listeners over time ----------

interface Expect {
  kind: string;
  match: Record<string, unknown>;
  t0: number;
  t1: number;
  label: string;
}

async function runSoak() {
  const w = loadWorld();
  const bin = opt('spike')!;
  const duration = Number(opt('duration', '120')) * 1000;
  const interval = Number(opt('interval', '20')) * 1000;
  const dial = opt('dial');
  const goLog = join(dir, 'go.jsonl');
  const expFile = join(dir, 'expect.jsonl');
  writeFileSync(goLog, '');
  writeFileSync(expFile, '');
  const child = spawn(bin, ['listen', '-projects', w.projectId, '-presence', '60s'], {
    env: spikeEnv(w, dial ? { HIVENOD_SPIKE_DIAL: dial } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  let ready!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  child.stdout.on('data', (d: Buffer) => {
    appendFileSync(goLog, d);
    buf += d.toString();
    if (buf.includes('"kind":"holding"')) ready();
  });
  child.stderr.on('data', (d: Buffer) => appendFileSync(join(dir, 'go.stderr'), d));
  let goExited = false;
  child.once('exit', (c) => {
    goExited = true;
    log(`Go listener exited (${c})`);
  });
  await Promise.race([
    isReady,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Go listener not ready in 60 s')), 60_000),
    ),
  ]);
  log('Go listener ready and holding the item');

  const { db, ctx } = await human(w);
  const project = { steps: w.steps };
  const expect = async (e: Omit<Expect, 't0' | 't1'>, fn: () => Promise<void>) => {
    const t0 = Date.now();
    try {
      await fn();
    } catch (err) {
      log(`write failed (${e.label}): ${(err as Error).message}`);
      appendFileSync(
        expFile,
        JSON.stringify({ ...e, t0, t1: Date.now(), writeFailed: true }) + '\n',
      );
      return;
    }
    appendFileSync(expFile, JSON.stringify({ ...e, t0, t1: Date.now() }) + '\n');
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + duration;
  let title = 'held-0';
  for (let i = 1; Date.now() < end && !goExited; i++) {
    const start = Date.now();
    const newTitle = `soak-${i}-new`;
    await expect(
      { kind: 'work', match: { title: newTitle, change: 'added' }, label: `new item ${i}` },
      () =>
        applyPlan(
          db,
          createItem(ctx, { project, projectId: w.projectId, title: newTitle, type: 'task' }),
        ),
    );
    await pause(2000);
    const t = `held-${i}`;
    await expect({ kind: 'item', match: { title: t }, label: `held item edit ${i}` }, () =>
      applyPlan(
        db,
        updateItem(ctx, {
          projectId: w.projectId,
          itemId: w.heldItemId,
          changes: { title: t },
          before: { title },
        }),
      ),
    );
    title = t;
    await pause(2000);
    const text = `msg-${i}`;
    await expect({ kind: 'message', match: { text }, label: `note ${i}` }, () =>
      applyPlan(
        db,
        postMessage(ctx, { projectId: w.projectId, itemId: w.heldItemId, kind: 'note', text }),
      ),
    );
    await pause(2000);
    const mfr = 4 + (i % 15);
    await expect(
      { kind: 'agent', match: { maxFailedRuns: mfr }, label: `agent settings ${i}` },
      () =>
        applyPlan(
          db,
          updateAgentSettings(ctx, {
            agentUid: w.agentUid,
            name: 'Go spike agent',
            guardrails: { maxFailedRuns: mfr },
          }),
        ),
    );
    const left = interval - (Date.now() - start);
    if (left > 0) await pause(Math.min(left, Math.max(0, end - Date.now())));
  }

  // Stop work on the held item (the run turns "stopped"), then revoke the agent.
  const itemPath = paths.item(w.workspaceId, w.projectId, w.heldItemId);
  const item = (await getDoc(doc(db, itemPath))).data()!;
  const runId = item.claim?.runId as string;
  const run = (await getDoc(doc(db, paths.run(w.workspaceId, runId)))).data()!;
  await expect({ kind: 'run', match: { status: 'stopped' }, label: 'stop work' }, () =>
    applyPlan(
      db,
      stopWork(ctx, {
        project,
        projectId: w.projectId,
        itemId: w.heldItemId,
        item: item as never,
        mode: 'back',
        run: { costEur: run.costEur ?? 0, endedAt: run.endedAt ?? null },
      }),
    ),
  );
  await pause(3000);
  // A revoked agent may read nothing: its agent listener ends with permission-denied.
  await expect({ kind: 'denied', match: { listener: 'agent' }, label: 'revoke' }, () =>
    applyPlan(db, revokeAgent(ctx, { agentUid: w.agentUid })),
  );
  await pause(5000);
  if (!goExited) {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
  await terminate(db);
  log('soak finished');
  report();
}

// ---------- report ----------

function readJsonl(f: string): Record<string, any>[] {
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

function report() {
  const go = readJsonl(join(dir, 'go.jsonl'));
  const exp = readJsonl(join(dir, 'expect.jsonl')) as (Expect & { writeFailed?: boolean })[];
  const flaky = readJsonl(join(dir, 'flaky.jsonl'));
  // Drop windows: from "down" until 120 s after "up" (time to notice, reconnect, resync).
  const windows: [number, number][] = [];
  for (let i = 0; i < flaky.length; i++) {
    if (flaky[i]!.event === 'down') {
      const up = flaky.slice(i + 1).find((f) => f.event === 'up');
      windows.push([flaky[i]!.t, (up?.t ?? Date.now()) + 120_000]);
    }
  }
  const inDrop = (t: number) => windows.some(([a, b]) => t >= a && t <= b);
  const rows = exp.map((e) => {
    const hit = go.find(
      (g) =>
        g.kind === e.kind && g.t >= e.t0 && Object.entries(e.match).every(([k, v]) => g[k] === v),
    );
    return {
      label: e.label,
      found: !!hit,
      latencyMs: hit ? hit.t - e.t0 : null,
      inDrop: inDrop(e.t0),
      writeFailed: !!e.writeFailed,
      resync: !!hit?.resync,
    };
  });
  const normal = rows.filter((r) => !r.inDrop && !r.writeFailed);
  const lat = normal.map((r) => r.latencyMs ?? Infinity).sort((a, b) => a - b);
  const q = (p: number) =>
    lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null;
  const presence = go.filter((g) => g.kind === 'presence');
  const presenceFails = presence.filter((g) => !g.ok);
  const revokedAt = exp.find((e) => e.label === 'revoke')?.t0 ?? Infinity;
  const presenceFailsOutsideDrops = presenceFails.filter((g) => !inDrop(g.t) && g.t < revokedAt);
  const stopped = go.find((g) => g.kind === 'stopped');
  const firstReady = go.find((g) => g.kind === 'ready');
  // A document listener delivers states, not every write: a value overwritten while the network
  // was away is superseded, not missed, when the next value of the same doc was seen instead.
  const superseded = rows.filter((r, i) => {
    if (r.found || r.writeFailed || !r.inDrop) return false;
    const e = exp[i]!;
    if (e.kind !== 'item' && e.kind !== 'agent') return false;
    const nextIdx = exp.findIndex((x, j) => j > i && x.kind === e.kind && !x.writeFailed);
    return nextIdx > i && rows[nextIdx]!.found;
  });
  const missed = rows.filter((r) => !r.found && !r.writeFailed && !superseded.includes(r));
  const slow = normal.filter((r) => (r.latencyMs ?? Infinity) > 2000);
  const span = firstReady && go.length ? (go[go.length - 1]!.t - firstReady.t) / 60_000 : 0;
  const out = {
    sessionMinutes: Math.round(span),
    changes: rows.length,
    writeFailures: rows.filter((r) => r.writeFailed).length,
    missed: missed.map((r) => r.label),
    supersededDuringDrops: superseded.map((r) => r.label),
    normalChanges: normal.length,
    latencyMs: { p50: q(0.5), p95: q(0.95), max: lat.length ? lat[lat.length - 1] : null },
    over2s: slow.map((r) => `${r.label}: ${r.latencyMs} ms`),
    drops: windows.length,
    changesDuringDrops: rows.filter((r) => r.inDrop).length,
    dropChangesSeen: rows.filter((r) => r.inDrop && r.found).length,
    listenerErrors: go
      .filter((g) => g.kind === 'listener-error' && g.t < revokedAt)
      .map((g) => `${new Date(g.t).toISOString()} ${g.listener} ${g.code}`),
    presenceWrites: presence.length,
    presenceFails: presenceFails.length,
    presenceFailsOutsideDrops: presenceFailsOutsideDrops.length,
    tokenRefreshes: stopped?.refreshes ?? presence[presence.length - 1]?.refreshes ?? 0,
    revokedSeen: rows.find((r) => r.label === 'revoke')?.found ?? false,
    deniedAfterRevoke: go.filter((g) => g.kind === 'denied').length,
    pass: false,
  };
  out.pass = missed.length === 0 && slow.length === 0 && presenceFailsOutsideDrops.length === 0;
  writeFileSync(join(dir, 'report.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

// ---------- the Go CLI against a throwaway world (part 2) ----------

/** JSON-RPC over the binary's stdio: one request at a time. */
function mcpSession(bin: string, env: Record<string, string>, args: string[] = ['mcp']) {
  const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events: { t: number; meta: Record<string, string>; content: string }[] = [];
  let buf = '';
  const waiting = new Map<number, (v: Record<string, any>) => void>();
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined) waiting.get(m.id)?.(m);
        else if (m.method === 'notifications/claude/channel')
          events.push({ t: Date.now(), meta: m.params.meta, content: m.params.content });
      } catch {
        /* not JSON */
      }
    }
  });
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      const n = ++id;
      waiting.set(n, resolve);
      setTimeout(() => reject(new Error(`no answer to ${method}`)), 60_000);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  return {
    events,
    async init() {
      const r = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'prod-check', version: '0' },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      return r;
    },
    async tool(name: string, args: Record<string, unknown>) {
      const r = await request('tools/call', { name, arguments: args });
      const text = r.result?.content?.[0]?.text ?? '';
      let out: any = text;
      try {
        out = JSON.parse(text);
      } catch {
        /* message */
      }
      return { ok: !r.result?.isError, out };
    },
    close() {
      child.stdin.end();
      return new Promise((r) => child.once('exit', r));
    },
  };
}

async function goCli() {
  const w = loadWorld();
  const bin = resolve(opt('bin')!);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    HIVENOD_HOME: home,
  };
  const results: Record<string, unknown> = {};
  // 1. hivenod pair, confirmed by the throwaway admin as the web app does it.
  const child = spawn(bin, ['pair'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  child.stdout.on('data', (d: Buffer) => (said += d.toString()));
  child.stderr.on('data', (d: Buffer) => (said += d.toString()));
  const exited = new Promise<number | null>((r) => child.once('exit', r));
  for (let i = 0; i < 100 && !/code=/.test(said); i++) await new Promise((r) => setTimeout(r, 200));
  const m = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said);
  if (!m) throw new Error(`no pairing code shown: ${said}`);
  const code = m[1]! + m[2]!;
  results.pairUrl = said
    .split('\n')
    .find((l) => l.includes('/agents/connect'))
    ?.trim();
  const { db, ctx } = await human(w);
  const req = (await getDoc(doc(db, pairingPath(code)))).data()!;
  const ident = await createAgentIdentity(
    w.target === 'emu' ? { ...PROD, apiKey: 'fake-api-key', projectId: EMU_PROJECT } : PROD,
    w.workspaceId,
    w.target === 'emu' ? { authEmulatorUrl: `http://${w.authEmu}` } : {},
  );
  await applyPlan(
    db,
    createAgent(ctx, {
      agentUid: ident.uid,
      name: 'Go CLI check',
      color: '#2F5FD0',
      projectIds: [w.projectId],
      tokenHint: tokenHint(ident.token),
    }),
  );
  writeFileSync(join(dir, 'paired-uid'), ident.uid);
  const sealed = await sealToken(ident.token, req.publicKey as string, code);
  await updateDoc(
    doc(db, pairingPath(code)),
    toFirestoreValue(
      pairingCompletion({
        workspaceId: w.workspaceId,
        agentUid: ident.uid,
        agentName: 'Go CLI check',
        pairedBy: ctx.actor.id,
        sealed,
      }),
    ) as Record<string, unknown>,
  );
  results.pairExit = await exited;
  results.pairSaid = said.split('\n').filter((l) => l.startsWith('✓'));
  results.tokenPrinted = said.includes(ident.token);
  results.pairingDocLeft =
    (await getDoc(doc(db, pairingPath(code))).catch(() => null))?.exists() ?? 'unreadable';
  // 2. whoami
  const who = spawnSync(bin, ['whoami', '--json'], { env, encoding: 'utf8' });
  results.whoami = who.status === 0 ? JSON.parse(who.stdout) : who.stderr;
  // 3. MCP: list, claim, log, attach a link, note, progress, complete.
  const s = mcpSession(bin, env);
  const init = await s.init();
  results.server = init.result?.serverInfo;
  const calls: unknown[] = [];
  const t = async (name: string, args: Record<string, unknown>) => {
    const r = await s.tool(name, args);
    calls.push({ name, ok: r.ok, out: typeof r.out === 'string' ? r.out : Object.keys(r.out) });
    return r;
  };
  const work = await t('list_work', {});
  const row = (work.out as any[]).find((x) => x.title === 'held-0') ?? (work.out as any[])[0];
  const claim = await t('claim', { itemId: row.itemId });
  const runId = claim.out.runId;
  await t('read_item', { itemId: row.itemId });
  await t('log', { runId, text: 'Go CLI production check' });
  await t('attach', { itemId: row.itemId, source: 'https://hivenod.com/', name: 'Hivenod' });
  await t('add_note', { itemId: row.itemId, text: 'A note from the Go CLI' });
  await t('progress', { itemId: row.itemId, done: 1, total: 1 });
  const done = await t('complete', { itemId: row.itemId, runId, costEur: 0 });
  results.complete = done.out;
  await s.close();
  results.calls = calls;
  const item = (await getDoc(doc(db, paths.item(w.workspaceId, w.projectId, row.itemId)))).data()!;
  results.itemAfter = {
    stepId: item.stepId,
    status: item.status,
    claim: item.claim,
    attachmentCount: item.attachmentCount,
  };
  // 4. Revoke; the CLI says so plainly.
  await applyPlan(db, revokeAgent(ctx, { agentUid: ident.uid }));
  const after = spawnSync(bin, ['whoami'], { env, encoding: 'utf8' });
  results.afterRevoke = { status: after.status, stderr: after.stderr.trim() };
  const logout = spawnSync(bin, ['logout'], { env, encoding: 'utf8' });
  results.logout = logout.stdout.trim();
  results.agentJsonLeft = existsSync(join(home, 'agent.json'));
  await terminate(db);
  const pass =
    results.pairExit === 0 &&
    results.tokenPrinted === false &&
    results.pairingDocLeft === false &&
    (results.whoami as any)?.name === 'Go CLI check' &&
    calls.every((c: any) => c.ok) &&
    (results.complete as any)?.movedTo?.stepId === 'accept' &&
    item.stepId === 'accept' &&
    item.status === 'waiting' &&
    results.afterRevoke &&
    (results.afterRevoke as any).status === 1 &&
    /revoked/.test((results.afterRevoke as any).stderr) &&
    results.agentJsonLeft === false;
  results.pass = pass;
  writeFileSync(join(dir, 'go-cli.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = pass ? 0 : 1;
}

// ---------- channel mode through a network drop (part 3) ----------

async function channelDrop() {
  const w = loadWorld();
  const bin = resolve(opt('bin')!);
  const dial = opt('dial')!;
  const flakyLog = join(dir, 'flaky.jsonl');
  const env: Record<string, string> = {
    ...spikeEnv(w),
    FIRESTORE_EMULATOR_HOST: dial,
    HIVENOD_HOME: join(dir, 'home'),
  };
  if (w.target !== 'emu')
    throw new Error('channel-drop runs on the emulator (through the forwarder)');
  const s = mcpSession(bin, env, ['mcp', '--channel', '--max-items', '3']);
  await s.init();
  const until = async (f: () => boolean, ms: number) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) {
      if (f()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const works = () => s.events.filter((e) => e.meta.kind === 'work');
  if (!(await until(() => works().length >= 1, 20_000))) throw new Error('no first handover');
  const { db, ctx } = await human(w);
  const flaky = () => readJsonl(flakyLog);
  if (!(await until(() => flaky().some((f) => f.event === 'down'), 120_000)))
    throw new Error('no drop');
  await new Promise((r) => setTimeout(r, 5000));
  const during = createItem(ctx, {
    project: { steps: w.steps },
    projectId: w.projectId,
    title: 'made during the drop',
    type: 'task',
  });
  await applyPlan(db, during);
  const madeAt = Date.now();
  if (!(await until(() => flaky().some((f) => f.event === 'up'), 180_000)))
    throw new Error('no up');
  const up = flaky().find((f) => f.event === 'up')!.t;
  const got = await until(() => works().some((e) => e.meta.item_id === during.itemId), 120_000);
  const ev = works().find((e) => e.meta.item_id === during.itemId);
  // A note on the held item after the network is back.
  const held = works()[0]!.meta;
  const noteAt = Date.now();
  await applyPlan(
    db,
    postMessage(ctx, {
      projectId: w.projectId,
      itemId: held.item_id!,
      kind: 'note',
      text: 'after the drop',
    }),
  );
  await until(() => s.events.some((e) => e.meta.kind === 'note'), 30_000);
  const note = s.events.find((e) => e.meta.kind === 'note');
  await s.close();
  await terminate(db);
  const out = {
    handedOverAfterUpMs: ev ? ev.t - up : null,
    madeDuringDropAtMs: madeAt - up,
    noteLatencyMs: note ? note.t - noteAt : null,
    seen: got,
    events: s.events.map((e) => e.meta.kind),
  };
  writeFileSync(join(dir, 'channel-drop.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

/** Channel mode on a throwaway world (production): handover, note, answer, stop, offline. */
async function channelCheck() {
  const w = loadWorld();
  const bin = resolve(opt('bin')!);
  const env: Record<string, string> = { ...spikeEnv(w), HIVENOD_HOME: join(dir, 'home') };
  const s = mcpSession(bin, env, ['mcp', '--channel', '--max-items', '2']);
  const init = await s.init();
  const until = async (f: () => boolean, ms: number) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) {
      if (f()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const kinds = (k: string) => s.events.filter((e) => e.meta.kind === k);
  const t0 = Date.now();
  await until(() => kinds('work').length >= 1, 30_000);
  const first = kinds('work')[0];
  const firstMs = first ? first.t - t0 : null;
  const { db, ctx } = await human(w);
  // A second item arrives while the first is held (max 2).
  const second = createItem(ctx, {
    project: { steps: w.steps },
    projectId: w.projectId,
    title: 'second',
    type: 'task',
  });
  const madeAt = Date.now();
  await applyPlan(db, second);
  await until(() => kinds('work').length >= 2, 30_000);
  const w2 = kinds('work')[1];
  // A note on the first; then Stop work on the second.
  const noteAt = Date.now();
  await applyPlan(
    db,
    postMessage(ctx, {
      projectId: w.projectId,
      itemId: first!.meta.item_id!,
      kind: 'note',
      text: 'Please hurry',
    }),
  );
  await until(() => kinds('note').length >= 1, 30_000);
  const note = kinds('note')[0];
  const ip = paths.item(w.workspaceId, w.projectId, second.itemId);
  const item = (await getDoc(doc(db, ip))).data()!;
  const run = (await getDoc(doc(db, paths.run(w.workspaceId, item.claim.runId)))).data()!;
  const stopAt = Date.now();
  await applyPlan(
    db,
    stopWork(ctx, {
      project: { steps: w.steps },
      projectId: w.projectId,
      itemId: second.itemId,
      item: item as never,
      mode: 'back',
      reason: 'Not now',
      run: { costEur: run.costEur ?? 0, endedAt: null },
    }),
  );
  await until(() => kinds('stop').length >= 1, 30_000);
  const stop = kinds('stop')[0];
  // The stopped item's tools refuse; the first goes on and completes.
  const refused = await s.tool('add_note', { itemId: second.itemId, text: 'late' });
  const done = await s.tool('complete', { itemId: first!.meta.item_id });
  await s.close();
  await new Promise((r) => setTimeout(r, 1500));
  const agent = (await getDoc(doc(db, paths.agent(w.workspaceId, w.agentUid)))).data()!;
  await terminate(db);
  const out = {
    instructionsForMax2: String(init.result?.instructions ?? '').includes('Up to 2 items'),
    capabilities: init.result?.capabilities,
    firstHandoverMs: firstMs,
    secondHandoverMs: w2 ? w2.t - madeAt : null,
    secondMeta: w2?.meta,
    noteLatencyMs: note ? note.t - noteAt : null,
    stopLatencyMs: stop ? stop.t - stopAt : null,
    stoppedToolRefused: !refused.ok && String(refused.out).includes('stopped the work'),
    completeOk: done.ok && (done.out as any).movedTo?.stepId === 'accept',
    offlineAfterExit:
      !!agent.signedOutAt && agent.signedOutAt.toMillis() >= (agent.lastSeenAt?.toMillis() ?? 0),
    events: s.events.map((e) => e.meta.kind),
  };
  const pass =
    out.instructionsForMax2 &&
    firstMs !== null &&
    out.secondHandoverMs !== null &&
    out.secondHandoverMs < 5000 &&
    out.noteLatencyMs !== null &&
    out.stopLatencyMs !== null &&
    out.stopLatencyMs < 5000 &&
    out.stoppedToolRefused &&
    out.completeOk &&
    out.offlineAfterExit;
  writeFileSync(join(dir, 'channel-check.json'), JSON.stringify({ ...out, pass }, null, 2));
  console.log(JSON.stringify({ ...out, pass }, null, 2));
  process.exitCode = pass ? 0 : 1;
}

// ---------- cleanup ----------

async function cleanup() {
  const w = loadWorld();
  try {
    const { db, ctx } = await human(w);
    const a = (await getDoc(doc(db, paths.agent(w.workspaceId, w.agentUid)))).data();
    if (a && !a.revokedAt) await applyPlan(db, revokeAgent(ctx, { agentUid: w.agentUid }));
    await terminate(db);
  } catch (e) {
    log(`revoke skipped: ${(e as Error).message}`);
  }
  const ad = admin(w);
  await ad.db.recursiveDelete(ad.db.doc(`workspaces/${w.workspaceId}`));
  // The notifier may still write its "notified" record for a gate a moment later: sweep again.
  await new Promise((r) => setTimeout(r, 15_000));
  await ad.db.recursiveDelete(ad.db.doc(`workspaces/${w.workspaceId}`));
  await ad.db
    .doc(`users/${w.humanUid}`)
    .delete()
    .catch(() => undefined);
  const paired = existsSync(join(dir, 'paired-uid'))
    ? readFileSync(join(dir, 'paired-uid'), 'utf8')
    : '';
  for (const uid of [w.agentUid, w.humanUid, paired].filter(Boolean))
    await ad.auth.deleteUser(uid).catch((e: Error) => log(`delete user: ${e.message}`));
  writeFileSync(secretFile(), '{}', { mode: 0o600 });
  log(`cleaned up workspace ${w.workspaceId} and its two users`);
}

const fns: Record<string, () => unknown> = {
  setup,
  'check-a': checkA,
  run: runSoak,
  report,
  'go-cli': goCli,
  'channel-drop': channelDrop,
  'channel-check': channelCheck,
  cleanup,
};
const fn = fns[cmd ?? ''];
if (!fn) {
  console.error('usage: driver setup|check-a|run|report|cleanup');
  process.exit(2);
}
Promise.resolve(fn()).then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
void buildStepIndex;
