// One-off repair of Inbox thread states (item OE8FmrTaIxFVGcaeGG3N). Before this fix a thread
// stayed at Your call while an approved outcome, or an approved agent step at its plan's cursor,
// waited for the agent to carry it out: nothing waited for the member. The actions now write
// `waiting` on the agent; this script moves the threads written before that. DRY RUN BY DEFAULT:
// nothing is written unless `apply: true`. Idempotent: a repaired thread is no longer at Your call.
// It reads workspaces/*/inboxThreads (state yourCall), their plans and outcomes, and writes only
// `state` and `waiting` of the threads it repairs (with the read's update time as precondition).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OUTCOMES = JSON.parse(
  readFileSync(join(import.meta.dirname, '../cli/internal/actions/outcomes.json'), 'utf8'),
);
/** Outcome types an agent carries out (not a person step, not a wait-until or an immediate one). */
const byAgent = (type) => {
  const t = OUTCOMES[type];
  return !!t && t.executor === 'agent' && (t.kind ?? 'agent') !== 'human';
};
const LIVE = ['proposed', 'active', 'blocked'];

/** A plain object from Firestore REST fields (only what this script needs). */
export function plain(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(plain);
  if ('mapValue' in v) return fields(v.mapValue.fields);
  return undefined;
}
const fields = (f = {}) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, plain(v)]));

/**
 * Whether a thread at Your call should wait on the agent instead: its live plan's step at the
 * cursor is approved and carried out by an agent; or, with no live plan, no proposal of it is open
 * and one of its single outcomes is approved for the agent. Pure; `outcomes` are the thread's.
 * @param {{ state: string, question?: { answer: unknown } | null }} thread
 * @param {Array<{ steps: string[], cursor: number, state: string, createdAt?: string }>} plans
 * @param {Record<string, { type: string, state: string, planId?: string | null }>} outcomes
 */
export function needsRepair(thread, plans, outcomes) {
  if (thread.state !== 'yourCall') return false;
  if (thread.question && thread.question.answer == null) return false;
  const live = plans
    .filter((p) => LIVE.includes(p.state))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
  if (live) {
    if (live.state === 'blocked') return false;
    const o = outcomes[live.steps[live.cursor]];
    return !!o && o.state === 'approved' && byAgent(o.type);
  }
  const all = Object.values(outcomes);
  if (all.some((o) => o.state === 'proposed' || o.state === 'revising')) return false;
  return all.some((o) => !o.planId && o.state === 'approved' && byAgent(o.type));
}

const PAGE = 300;

/**
 * @param {{ project: string, token: string, apply?: boolean, fetchFn?: typeof fetch, base?: string }} o
 * @returns {Promise<{ scanned: number, repair: string[], repaired: number }>}
 */
export async function fixThreadStates({
  project,
  token,
  apply = false,
  fetchFn = fetch,
  base = 'https://firestore.googleapis.com',
}) {
  const root = `${base}/v1/projects/${project}/databases/(default)/documents`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function query(parent, collectionId, field, value) {
    const out = [];
    let after = null;
    for (;;) {
      const structuredQuery = {
        from: [{ collectionId }],
        where: {
          fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } },
        },
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: PAGE,
      };
      if (after) structuredQuery.startAt = { values: [{ referenceValue: after }], before: false };
      const res = await fetchFn(`${parent}:runQuery`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ structuredQuery }),
      });
      if (!res.ok) throw new Error(`${collectionId} query failed: ${res.status}`);
      const docs = (await res.json()).map((r) => r.document).filter(Boolean);
      out.push(...docs);
      if (docs.length < PAGE) break;
      after = docs[docs.length - 1].name;
    }
    return out;
  }

  const wids = [];
  for (let pageToken = ''; ;) {
    const res = await fetchFn(
      `${root}/workspaces?pageSize=${PAGE}&mask.fieldPaths=name${pageToken ? `&pageToken=${pageToken}` : ''}`,
      { headers },
    );
    if (!res.ok) throw new Error(`workspaces list failed: ${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) wids.push(d.name.split('/').pop());
    if (!body.nextPageToken) break;
    pageToken = encodeURIComponent(body.nextPageToken);
  }

  let scanned = 0;
  const repair = [];
  const updateTimes = new Map();
  for (const wid of wids) {
    const ws = `${root}/workspaces/${encodeURIComponent(wid)}`;
    for (const t of await query(ws, 'inboxThreads', 'state', 'yourCall')) {
      scanned++;
      const tid = t.name.split('/').pop();
      const plans = (await query(ws, 'inboxPlans', 'threadId', tid)).map((d) => fields(d.fields));
      const outcomes = Object.fromEntries(
        (await query(ws, 'inboxOutcomes', 'threadId', tid)).map((d) => [
          d.name.split('/').pop(),
          fields(d.fields),
        ]),
      );
      if (needsRepair(fields(t.fields), plans, outcomes)) {
        repair.push(t.name.split('/documents/')[1]);
        updateTimes.set(t.name, t.updateTime);
      }
    }
  }

  let repaired = 0;
  if (apply) {
    for (const [name, updateTime] of updateTimes) {
      const url =
        `${base}/v1/${name}?updateMask.fieldPaths=state&updateMask.fieldPaths=waiting` +
        `&currentDocument.updateTime=${encodeURIComponent(updateTime)}`;
      const res = await fetchFn(url, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          fields: {
            state: { stringValue: 'waiting' },
            waiting: {
              mapValue: {
                fields: { on: { stringValue: 'agent' }, until: { nullValue: null } },
              },
            },
          },
        }),
      });
      // A thread changed since the read (precondition failed) is left for the next run.
      if (res.ok) repaired++;
    }
  }
  return { scanned, repair, repaired };
}
