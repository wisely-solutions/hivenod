// Migration of a project's open items to Inbox threads (Inbox item OE8Fm, slice 8, design
// "Migration of the live Hive project"). Talks to Firestore through the REST API with admin rights
// (no rules apply), so every document it writes is built by the shared actions
// (packages/shared/src/inbox.ts: createMemberThread, finishOutcome, approveOutcome, threadAttach,
// addInboxMessage, proposePlan, assignSubject), replayed in memory, and then checked against the
// shared zod schemas before anything is sent.
//
// Mapping (mapItem):
//   item waiting at a person step named Approve…  → thread, Development plan at 2 Approve idea
//   item waiting at a person step named Accept…   → thread, steps 1-5 done, at 6 Accept on live
//   open finding (status suggested) ≤ 30 days old → thread (source finding) with a proposed dev plan
//   item at an agent step                         → skipped: nothing is migrated mid-flight
//   done, stopped, archived, older findings       → skipped (they are in the export)
//
// Idempotent: thread, plan, step, message and attachment ids are derived from the item; each item
// is one atomic commit (plus attachment commits when large), and the item gets `migratedTo` last,
// so a rerun skips migrated items and finishes a half-written one. Nothing is deleted.
import { createHash } from 'node:crypto';
import { ActionError } from '../packages/shared/src/actions.ts';
import {
  addInboxMessage,
  approveOutcome,
  assignSubject,
  createMemberThread,
  digest24,
  finishOutcome,
  INBOX_LIMITS,
  inboxEventSchema,
  inboxMessageKey,
  inboxMessageSchema,
  inboxOutcomeSchema,
  inboxPaths,
  inboxSubjectSchema,
  inboxThreadKey,
  inboxThreadSchema,
  proposePlan,
} from '../packages/shared/src/inbox.ts';
import { inboxPlanSchema } from '../packages/shared/src/plans.ts';
import { PLAN_TEMPLATES } from '../packages/shared/src/planTemplates.ts';
import { inboxAttachmentSchema, threadAttach } from '../packages/shared/src/threadattach.ts';

export const FINDING_DAYS = 30;
export const DEFAULT_SUBJECT = 'Hivenod development';
export const DEFAULT_FINDINGS_SUBJECT = 'Hive findings';
export const FINDING_SOURCE = 'finding';
export const MIGRATED_BY = 'scripts/migrate-project-to-threads';
/** The Development template's step labels, in order. */
export const DEV_LABELS = PLAN_TEMPLATES.dev.steps.map(
  (s) =>
    s.fields.what ??
    (s.type === 'keepgreen' ? 'Keep green' : s.type[0].toUpperCase() + s.type.slice(1)),
);
/** Where Approve idea and Accept on live sit in the template (Keep green, slice 6c, moved the latter). */
const DEV_APPROVE = DEV_LABELS.indexOf('Approve idea');
const DEV_ACCEPT = DEV_LABELS.indexOf('Accept on live');
const DAY = 86_400_000;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------- time ----------

/** A Firestore Timestamp look-alike (what the shared schemas and actions take). */
export class Ts {
  constructor(ms) {
    this.seconds = Math.floor(ms / 1000);
    this.nanoseconds = Math.round((ms - this.seconds * 1000) * 1e6);
  }
  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }
  toDate() {
    return new Date(this.toMillis());
  }
}
const msOf = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);

// ---------- mapping ----------

/**
 * Where an item goes: {kind: 'thread', cursor} (the Development step it waits at), {kind:
 * 'finding'}, or {kind: 'skip', why}.
 */
export function mapItem(item, steps, now = new Date()) {
  const skip = (why) => ({ kind: 'skip', why });
  if (item.erasing) return skip('being deleted');
  if (item.archivedAt) return skip('archived');
  if (item.status === 'suggested') {
    const at = msOf(item.updatedAt) ?? 0;
    if (at < now.getTime() - FINDING_DAYS * DAY)
      return skip(`finding older than ${FINDING_DAYS} days`);
    return { kind: 'finding' };
  }
  if (item.status === 'done' || item.status === 'stopped') return skip(item.status);
  const step = steps.find((s) => s.id === item.stepId);
  if (!step) return skip(`unknown step ${item.stepId}`);
  if (step.kind !== 'human')
    return skip(`at agent step ${step.name}: not migrated mid-flight (finish it first, rerun)`);
  const n = step.name.toLowerCase();
  if (n.includes('accept')) return { kind: 'thread', cursor: DEV_ACCEPT };
  if (n.includes('approv')) return { kind: 'thread', cursor: DEV_APPROVE };
  return skip(`person step ${step.name} has no Development step`);
}

/** The table's "to" column for a mapping. */
export function mappingLabel(m) {
  if (m.kind === 'thread')
    return `${m.cursor + 1} ${DEV_LABELS[m.cursor]} (of ${DEV_LABELS.length})`;
  if (m.kind === 'finding') return 'finding: dev plan proposed';
  return `skip: ${m.why}`;
}

/** PR links, the latest release number and live commit named in the texts. */
export function findRefs(texts) {
  const prs = [];
  let release = null;
  let commit = null;
  for (const t of texts) {
    for (const m of t.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g))
      if (!prs.includes(m[0])) prs.push(m[0]);
    for (const m of t.matchAll(/\brelease[- ]?#?(\d{1,5})\b/gi)) release = Number(m[1]);
    for (const m of t.matchAll(/\b(?:live commit|commit|sha)\W{0,3}([0-9a-f]{7,40})\b/gi))
      commit = m[1];
  }
  return { prs, release, commit };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (t) => {
  const ms = msOf(t);
  return ms === null ? '?' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
};

/**
 * The thread's first message: the item's description, a link back, its notes (oldest first; the
 * oldest dropped when over the limit) and its decisions.
 */
export function itemText({ item, itemId, url, stepName, messages, decisions, nameOf }) {
  const head =
    `${item.summary?.trim() || '(no description)'}\n\n---\n` +
    `Migrated from the Hive project: "${item.title}" (item ${itemId}, ${item.type}, at ${stepName}).\n` +
    `${url}\n`;
  const notes = messages
    .slice()
    .sort((a, b) => (msOf(a.at) ?? 0) - (msOf(b.at) ?? 0))
    .map((m) => `[${day(m.at)}] ${nameOf(m.by)} (${m.kind}): ${clip(m.text.trim(), 4000)}`);
  const decs = decisions
    .slice()
    .sort((a, b) => (msOf(a.at) ?? 0) - (msOf(b.at) ?? 0))
    .map(
      (d) =>
        `[${day(d.at)}] ${nameOf({ type: 'human', id: d.byUid })} ${d.outcome} at ${d.stepId}` +
        (d.rationale?.trim() ? `: ${clip(d.rationale.trim(), 1000)}` : ''),
    );
  const decText = decs.length ? `\nDecisions (${decs.length}):\n${decs.join('\n')}\n` : '';
  const room = INBOX_LIMITS.text - head.length - decText.length - 200;
  let kept = notes;
  while (kept.length && kept.join('\n').length > room) kept = kept.slice(1);
  const dropped = notes.length - kept.length;
  const noteText = notes.length
    ? `\nNotes (${notes.length}${dropped ? `, the ${dropped} oldest are in the export` : ''}):\n${kept.join('\n')}\n`
    : '';
  return clip(`${head}${noteText}${decText}`, INBOX_LIMITS.text);
}

// ---------- in-memory replay ----------

const isHive = (v, k) => typeof v === 'object' && v !== null && v.__hive === k;

/** Applies ActionPlan ops to plain documents, as Firestore would. */
export class Store {
  constructor() {
    this.docs = new Map();
  }
  get(path) {
    return this.docs.get(path) ?? null;
  }
  resolve(v, ts) {
    if (isHive(v, 'serverTime')) return ts;
    if (v instanceof Date) return new Ts(v.getTime());
    if (Array.isArray(v)) return v.map((x) => this.resolve(x, ts));
    if (v === null || typeof v !== 'object' || v instanceof Ts) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.resolve(x, ts)]));
  }
  apply(ops, ts) {
    for (const op of ops) {
      if (op.kind === 'delete') {
        this.docs.delete(op.path);
        continue;
      }
      if (op.kind === 'set') {
        this.docs.set(op.path, this.resolve(op.data ?? {}, ts));
        continue;
      }
      const doc = this.docs.get(op.path);
      if (!doc) throw new Error(`update of a missing document ${op.path}`);
      for (const [key, raw] of Object.entries(op.data ?? {})) {
        const parts = key.split('.');
        let o = doc;
        for (const p of parts.slice(0, -1)) o = o[p] ??= {};
        const last = parts.at(-1);
        if (isHive(raw, 'deleteField')) delete o[last];
        else if (isHive(raw, 'arrayUnion'))
          o[last] = [...(o[last] ?? []), ...raw.values.filter((x) => !(o[last] ?? []).includes(x))];
        else if (isHive(raw, 'increment')) o[last] = (o[last] ?? 0) + raw.by;
        else o[last] = this.resolve(raw, ts);
      }
    }
  }
}

const SCHEMAS = {
  inboxThreads: inboxThreadSchema,
  inboxMessages: inboxMessageSchema,
  inboxOutcomes: inboxOutcomeSchema,
  inboxPlans: inboxPlanSchema,
  inboxEvents: inboxEventSchema,
  inboxSubjects: inboxSubjectSchema,
  inboxAttachments: inboxAttachmentSchema,
};

/** Checks a document against its shared schema (and refuses fields the schema does not know). */
export function validateDoc(path, data) {
  const col = path.split('/').at(-2);
  const schema = SCHEMAS[col];
  if (!schema) throw new Error(`No schema for ${path}`);
  const r = schema.safeParse(data);
  if (!r.success)
    throw new Error(
      `${path} fails its schema: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const extra = Object.keys(data).filter((k) => !(k in schema.shape));
  if (extra.length) throw new Error(`${path} has fields its schema lacks: ${extra.join(', ')}`);
}

/** Deterministic ids for one item. */
export function threadIdFor(wid, pid, iid) {
  return `mg${digest24(sha(`${wid}\u0000${pid}\u0000${iid}`))}`;
}
export function findingRefs(member, iid) {
  const threadRef = `hivenod:item:${iid}`;
  const ref = digest24(sha(inboxThreadKey(member, FINDING_SOURCE, threadRef)));
  const messageDocId = `im${digest24(sha(inboxMessageKey(member, FINDING_SOURCE, threadRef, iid)))}`;
  return { threadRef, ref, messageDocId, threadId: `it${ref}` };
}
export function subjectIdFor(wid, member, name) {
  return `sj${digest24(sha(`${wid}\u0000${member}\u0000${name.toLowerCase()}`))}`;
}

/**
 * Builds every document one item becomes, by replaying the shared actions. Returns the groups of
 * writes ({paths}: the main one first, then one per attachment), the final docs and warnings.
 *
 * @param {{ wid: string, pid: string, itemId: string, item: object, mapping: object,
 *   member: {uid: string, name: string}, agent: {uid: string, name: string},
 *   subject: {id: string, name: string, exists: boolean}, text: string, url: string,
 *   refs: {prs: string[], release: number|null, commit: string|null},
 *   attachments: {id: string, data: object}[], raisedBy?: string, now: Date }} o
 */
export function buildItemMigration(o) {
  const { wid, member, agent, mapping } = o;
  const store = new Store();
  let clock = o.now.getTime();
  const groups = [];
  const warnings = [];
  const finding = mapping.kind === 'finding';
  const fr = finding ? findingRefs(member.uid, o.itemId) : null;
  const threadId = finding ? fr.threadId : threadIdFor(wid, o.pid, o.itemId);
  const planId = `${threadId}p`;
  const stepIds = PLAN_TEMPLATES.dev.steps.map((_, i) => `${threadId}s${i}`);
  const idGen = (label, first = []) => {
    const queue = [...first];
    let n = 0;
    return () => queue.shift() ?? sha(`${threadId}:${label}:${n++}`).slice(0, 20);
  };
  const human = (label) => ({
    workspaceId: wid,
    actor: { type: 'human', id: member.uid, name: member.name },
    newId: idGen(label),
  });
  const bot = (label, first) => ({
    workspaceId: wid,
    actor: { type: 'agent', id: agent.uid, name: agent.name },
    newId: idGen(label, first),
  });
  const run = (plan, group) => {
    const before = new Set(store.docs.keys());
    store.apply(plan.ops, new Ts(clock++));
    const paths = new Set(plan.ops.map((op) => op.path));
    for (const p of store.docs.keys()) if (!before.has(p)) paths.add(p);
    if (group === 'main') {
      if (!groups[0]) groups[0] = { kind: 'main', paths: new Set() };
      for (const p of paths) groups[0].paths.add(p);
    } else groups.push({ kind: 'attachment', name: group, paths });
    return plan;
  };
  const tPath = inboxPaths.thread(wid, threadId);
  const thread = () => store.get(tPath);
  const planInput = () => ({
    planId,
    plan: store.get(inboxPaths.plan(wid, planId)),
    outcomes: Object.fromEntries(stepIds.map((id) => [id, store.get(inboxPaths.outcome(wid, id))])),
  });
  const file = () =>
    run(
      assignSubject(
        bot('file', o.subject.exists ? [] : [o.subject.id]),
        o.subject.exists
          ? { threadId, thread: thread(), subjectId: o.subject.id }
          : { threadId, thread: thread(), newName: o.subject.name },
      ),
      'main',
    );

  if (finding) {
    run(
      addInboxMessage(bot('add'), {
        messageDocId: fr.messageDocId,
        ref: fr.ref,
        memberUid: member.uid,
        source: FINDING_SOURCE,
        sender: { name: o.raisedBy || agent.name },
        text: o.text,
        threadRef: fr.threadRef,
        messageId: o.itemId,
        permalink: o.url,
        receivedAt: new Date(msOf(o.item.updatedAt) ?? o.now.getTime()),
        title: o.item.title.slice(0, INBOX_LIMITS.title),
      }),
      'main',
    );
    file();
    run(
      proposePlan(bot('plan'), {
        threadId,
        thread: thread(),
        template: 'dev',
        steps: [{ type: 'shape', fields: { idea: o.text.slice(0, 20_000) } }],
        note: `Raised as a finding in the Hive project (item ${o.itemId}). Approve the plan to have it shaped and built; reject it to drop it.`,
        planId,
        stepIds,
      }),
      'main',
    );
  } else {
    run(
      createMemberThread(human('create'), {
        title: o.item.title.slice(0, INBOX_LIMITS.title),
        text: o.text,
        agentUid: agent.uid,
        template: 'dev',
        threadId,
        planId,
        stepIds,
      }),
      'main',
    );
    // The link back to the old item on the first message.
    for (const [p, d] of store.docs)
      if (p.includes('/inboxMessages/') && d.threadId === threadId) d.permalink = o.url;
    file();
    const pr = o.refs.prs.at(-1) ?? null;
    // Each agent step's result, by its type (the template's order may change).
    const byType = {
      shape: { text: `Shaped in the Hive project (item ${o.itemId}).`, permalink: o.url },
      build: {
        text: pr
          ? `Built in the Hive project: ${o.refs.prs.join(', ')}.`
          : 'Built in the Hive project.',
        permalink: pr ?? o.url,
      },
      keepgreen: { text: 'Kept green in the Hive project.', permalink: pr ?? o.url },
      release: {
        text:
          o.refs.release !== null
            ? `Released in the Hive project: release ${o.refs.release}${o.refs.commit ? `, live commit ${o.refs.commit}` : ''}.`
            : 'Released in the Hive project.',
        permalink: o.url,
      },
    };
    for (let i = 0; i < mapping.cursor; i++) {
      const id = stepIds[i];
      const outcome = store.get(inboxPaths.outcome(wid, id));
      if (outcome.type === 'approval')
        run(
          approveOutcome(human(`gate${i}`), {
            outcomeId: id,
            outcome,
            thread: thread(),
            plan: planInput(),
          }),
          'main',
        );
      else
        run(
          finishOutcome(bot(`step${i}`), {
            outcomeId: id,
            outcome,
            thread: thread(),
            status: 'done',
            result: byType[outcome.type] ?? null,
            plan: planInput(),
          }),
          'main',
        );
    }
  }

  for (const a of o.attachments) {
    const d = a.data;
    let kind = d.kind;
    let content = d.content ?? null;
    let url = d.url ?? null;
    if (kind !== 'link' && content === null && url) kind = 'link';
    try {
      run(
        threadAttach(bot(`att:${a.id}`), {
          threadId,
          thread: thread(),
          id: sha(`att:${a.id}`).slice(0, 20),
          kind,
          name: d.name,
          ...(kind === 'link' ? { url } : { content }),
        }),
        `attachment ${d.name}`,
      );
    } catch (e) {
      if (!(e instanceof ActionError)) throw e;
      warnings.push(`attachment "${d.name}" not copied: ${e.message}`);
    }
  }

  for (const g of groups) for (const p of g.paths) if (store.get(p)) validateDoc(p, store.get(p));
  const t = thread();
  return {
    threadId,
    planId,
    store,
    groups,
    warnings,
    state: t.state,
    cursor: store.get(inboxPaths.plan(wid, planId))?.cursor ?? null,
  };
}

// ---------- Firestore REST ----------

export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Ts) return { timestampValue: v.toDate().toISOString() };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  throw new Error(`Cannot encode ${typeof v}`);
}
export function encodeFields(o) {
  return Object.fromEntries(
    Object.entries(o)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => [k, encodeValue(x)]),
  );
}
export function decodeValue(v) {
  if (!v || 'nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return new Ts(Date.parse(v.timestampValue));
  if ('stringValue' in v) return v.stringValue;
  if ('bytesValue' in v) return v.bytesValue;
  if ('referenceValue' in v) return v.referenceValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  return null;
}
export function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([k, x]) => [k, decodeValue(x)]));
}

/** A small Firestore REST client (admin: a service-account token, or "owner" on the emulator). */
export function restClient({
  project,
  token,
  base = 'https://firestore.googleapis.com',
  fetchFn = fetch,
}) {
  const dbPath = `projects/${project}/databases/(default)`;
  const root = `${base}/v1/${dbPath}/documents`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const idOf = (name) => name.slice(name.lastIndexOf('/') + 1);
  async function call(url, init) {
    const res = await fetchFn(url, { headers, ...init });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Firestore ${res.status} for ${url.replace(root, '')}: ${body.slice(0, 500)}`,
      );
    }
    return res.json();
  }
  return {
    docName: (path) => `${dbPath}/documents/${path}`,
    async get(path) {
      const d = await call(`${root}/${enc(path)}`);
      return d ? decodeFields(d.fields) : null;
    },
    async list(colPath) {
      const out = [];
      let pageToken;
      for (;;) {
        const qs = new URLSearchParams({ pageSize: '300' });
        if (pageToken) qs.set('pageToken', pageToken);
        const body = await call(`${root}/${enc(colPath)}?${qs}`);
        for (const d of body?.documents ?? [])
          out.push({ id: idOf(d.name), data: decodeFields(d.fields) });
        pageToken = body?.nextPageToken;
        if (!pageToken) return out;
      }
    },
    /** Documents of `collection` under `parent` where `field` == `value`. */
    async where(parent, collection, field, value) {
      const rows = await call(`${root}/${enc(parent)}:runQuery`, {
        method: 'POST',
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: collection }],
            where: {
              fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: encodeValue(value) },
            },
          },
        }),
      });
      return (rows ?? [])
        .filter((r) => r.document)
        .map((r) => ({ id: idOf(r.document.name), data: decodeFields(r.document.fields) }));
    },
    async commit(writes) {
      await call(`${root}:commit`, { method: 'POST', body: JSON.stringify({ writes }) });
    },
  };
}

const COMMIT_BYTES = 6_000_000;
const COMMIT_WRITES = 400;

/** The commits of one item: new docs (create-only), in chunks; the item's marker in the last one. */
function itemCommits(rest, built, docsToWrite, marker) {
  const commits = [];
  let cur = [];
  let size = 0;
  const push = (w) => {
    const n = JSON.stringify(w).length;
    if (cur.length && (size + n > COMMIT_BYTES || cur.length >= COMMIT_WRITES)) {
      commits.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(w);
    size += n;
  };
  for (const g of docsToWrite) {
    // A group stays in one commit (an attachment with its event; the main docs together).
    const ws = [...g.paths]
      .filter((p) => built.store.get(p))
      .map((p) => ({
        update: { name: rest.docName(p), fields: encodeFields(built.store.get(p)) },
        currentDocument: { exists: false },
      }));
    if (g.kind === 'main') {
      if (cur.length) commits.push(cur);
      commits.push(ws);
      cur = [];
      size = 0;
    } else for (const w of ws) push(w);
  }
  if (cur.length) commits.push(cur);
  if (commits.length === 0) commits.push([]);
  commits.at(-1).push(marker);
  return commits;
}

/**
 * Migrates (or, with dryRun, only plans and checks) one project's open items.
 *
 * @param {{ rest: ReturnType<typeof restClient>, wid: string, pid: string, memberUid: string,
 *   agentUid: string, dryRun: boolean, now?: Date, appUrl?: string, subjectName?: string,
 *   findingsSubjectName?: string, log?: (s: string) => void }} o
 */
export async function migrateProject(o) {
  const { rest, wid, pid } = o;
  const now = o.now ?? new Date();
  const appUrl = (o.appUrl ?? 'https://hivenod.com').replace(/\/$/, '');
  const log = o.log ?? (() => {});
  const W = `workspaces/${wid}`;
  const ws = await rest.get(W);
  if (!ws) throw new Error(`Organization ${wid} not found`);
  if (!ws.memberRoles?.[o.memberUid])
    throw new Error(`${o.memberUid} is not a member of organization ${wid}`);
  const agentDoc = await rest.get(`${W}/agents/${o.agentUid}`);
  if (!agentDoc) throw new Error(`Agent ${o.agentUid} not found in organization ${wid}`);
  if (agentDoc.revokedAt) throw new Error(`Agent ${o.agentUid} is revoked`);
  const profile = await rest.get(`${W}/members/${o.memberUid}`);
  const member = { uid: o.memberUid, name: profile?.name?.trim() || 'Member' };
  const agent = { uid: o.agentUid, name: agentDoc.name };
  const project = await rest.get(`${W}/projects/${pid}`);
  if (!project) throw new Error(`Project ${pid} not found in organization ${wid}`);
  const P = `${W}/projects/${pid}`;
  const items = await rest.list(`${P}/items`);
  const decisions = await rest.list(`${P}/decisions`);
  const agentNames = new Map((await rest.list(`${W}/agents`)).map((a) => [a.id, a.data.name]));
  const memberNames = new Map(
    (await rest.list(`${W}/members`)).map((m) => [m.id, m.data.name?.trim() || 'Member']),
  );
  const nameOf = (by) =>
    (by?.type === 'agent' ? agentNames.get(by.id) : memberNames.get(by?.id)) ?? by?.id ?? '?';
  const subjects = await rest.where(W, 'inboxSubjects', 'memberUid', member.uid);
  const subjectFor = (name) => {
    const hit = subjects.find((s) => s.data.name.toLowerCase() === name.toLowerCase());
    if (hit) return { id: hit.id, name: hit.data.name, exists: true };
    return { id: subjectIdFor(wid, member.uid, name), name, exists: false };
  };
  const created = new Set();
  const subjectName = o.subjectName ?? DEFAULT_SUBJECT;
  const findingsName = o.findingsSubjectName ?? DEFAULT_FINDINGS_SUBJECT;

  const order = { thread: 0, finding: 1, skip: 2 };
  const mapped = items
    .map((it) => ({ ...it, mapping: mapItem(it.data, project.steps, now) }))
    .sort(
      (a, b) =>
        order[a.mapping.kind] - order[b.mapping.kind] ||
        (b.mapping.cursor ?? 0) - (a.mapping.cursor ?? 0) ||
        a.data.title.localeCompare(b.data.title),
    );
  const rows = [];
  let writes = 0;
  for (const it of mapped) {
    const step = project.steps.find((s) => s.id === it.data.stepId);
    const row = {
      itemId: it.id,
      title: it.data.title,
      from: `${step?.name ?? it.data.stepId} · ${it.data.status}`,
      to: mappingLabel(it.mapping),
      threadId: null,
      action: 'skip',
      attachments: '',
      notes: '',
      warnings: [],
    };
    rows.push(row);
    if (it.mapping.kind === 'skip') continue;
    const I = `${P}/items/${it.id}`;
    const messages = (await rest.list(`${I}/messages`)).map((m) => m.data);
    const attachments = await rest.list(`${I}/attachments`);
    const url = `${appUrl}/p/${pid}?item=${encodeURIComponent(it.id)}`;
    const text = itemText({
      item: it.data,
      itemId: it.id,
      url,
      stepName: step?.name ?? it.data.stepId,
      messages,
      decisions: decisions.filter((d) => d.data.itemId === it.id).map((d) => d.data),
      nameOf,
    });
    const refs = findRefs([
      it.data.summary ?? '',
      ...messages.map((m) => m.text),
      ...attachments.map((a) => `${a.data.name} ${a.data.url ?? ''}`),
    ]);
    const sName = it.mapping.kind === 'finding' ? findingsName : subjectName;
    const subject = subjectFor(sName);
    if (created.has(subject.id)) subject.exists = true;
    const built = buildItemMigration({
      wid,
      pid,
      itemId: it.id,
      item: it.data,
      mapping: it.mapping,
      member,
      agent,
      subject,
      text,
      url,
      refs,
      attachments,
      raisedBy: it.data.createdBy ? nameOf(it.data.createdBy) : undefined,
      now,
    });
    const nAtt = built.groups.filter((g) => g.kind === 'attachment').length;
    row.threadId = built.threadId;
    row.attachments = `${nAtt}/${attachments.length}`;
    row.notes = String(messages.length);
    row.warnings = built.warnings;
    const exists = (await rest.get(inboxPaths.thread(wid, built.threadId))) !== null;
    if (it.data.migratedTo) {
      row.action = exists ? 'already migrated' : 'marked, thread missing: check by hand';
      continue;
    }
    // A half-written item (its thread exists, no marker yet): only the missing attachments.
    let todo = built.groups;
    if (exists) {
      todo = [];
      for (const g of built.groups.filter((x) => x.kind === 'attachment')) {
        const missing = new Set();
        for (const p of g.paths) if ((await rest.get(p)) === null) missing.add(p);
        if (missing.size) todo.push({ ...g, paths: missing });
      }
    }
    row.action = exists ? 'resume' : 'create';
    if (!exists && !subject.exists) created.add(subject.id);
    if (o.dryRun) continue;
    const marker = {
      update: {
        name: rest.docName(I),
        fields: encodeFields({
          migratedTo: {
            threadId: built.threadId,
            planId: built.planId,
            at: new Ts(now.getTime()),
            by: MIGRATED_BY,
          },
        }),
      },
      updateMask: { fieldPaths: ['migratedTo'] },
      currentDocument: { exists: true },
    };
    for (const c of itemCommits(rest, built, todo, marker)) {
      await rest.commit(c);
      writes += c.length;
    }
    log(`${it.id} → ${built.threadId} (${row.to})`);
  }
  return { rows, writes };
}

/** The dry-run / result table, plain text. */
export function formatTable(rows) {
  const cols = [
    ['item', (r) => r.itemId.slice(0, 8)],
    ['title', (r) => clip(r.title, 40)],
    ['now', (r) => r.from],
    ['becomes', (r) => r.to],
    ['att', (r) => r.attachments],
    ['notes', (r) => r.notes],
    ['action', (r) => r.action],
    ['thread', (r) => r.threadId ?? ''],
  ];
  const cells = rows.map((r) => cols.map(([, f]) => f(r)));
  const width = cols.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) =>
    c
      .map((x, i) => x.padEnd(width[i]))
      .join('  ')
      .trimEnd();
  const out = [
    line(cols.map(([h]) => h)),
    line(width.map((w) => '-'.repeat(w))),
    ...cells.map(line),
  ];
  for (const r of rows) for (const w of r.warnings) out.push(`! ${r.itemId}: ${w}`);
  return out.join('\n');
}
