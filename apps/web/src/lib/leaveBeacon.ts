import { DELETE_FIELD, SERVER_TIME, type WriteOp } from '@hive/shared';

/**
 * Card 6OVGEySr. A tab that is closing cannot finish a Firestore SDK write (it needs IndexedDB
 * and an open stream first), so as the page is left the pending plans are also sent as ONE
 * `fetch(..., { keepalive: true })` to the Firestore REST `:commit` endpoint, which the browser
 * delivers even after the page is gone. If both the SDK write and this one land, the second fails
 * on the create-only event document; `run` treats that as saved (see SessionCore).
 */

type Field = Record<string, unknown>;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype;

function encode(v: unknown, path: string[] = [], transforms: Field[] = []): Field | undefined {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => encode(x) ?? {}) } };
  if (isPlain(v)) return { mapValue: { fields: encodeMap(v, path, transforms) } };
  return undefined;
}

const seg = (s: string) =>
  /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) ? s : `\`${s.replace(/[`\\]/g, '\\$&')}\``;

/** Encodes a map; sentinels are left out and reported to `onSentinel` with their field path. */
function encodeMap(
  m: Record<string, unknown>,
  path: string[],
  transforms: Field[],
  masks: string[] = [],
): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const [k, v] of Object.entries(m)) {
    const p = [...path, seg(k)];
    const fp = p.join('.');
    if (v === SERVER_TIME) transforms.push({ fieldPath: fp, setToServerValue: 'REQUEST_TIME' });
    else if (v === DELETE_FIELD) masks.push(fp);
    else if (isPlain(v) && (v as { __hive?: string }).__hive === 'arrayUnion')
      transforms.push({
        fieldPath: fp,
        appendMissingElements: {
          values: ((v as { values: unknown[] }).values ?? []).map((x) => encode(x)),
        },
      });
    else if (isPlain(v) && (v as { __hive?: string }).__hive === 'increment')
      transforms.push({ fieldPath: fp, increment: encode((v as { by: number }).by) });
    else {
      const e = encode(v, p, transforms);
      if (e) out[k] = e;
    }
  }
  return out;
}

/** Nests dotted update keys: { 'a.b': 1 } -> { a: { b: 1 } }, mask paths per key. */
function nest(data: Record<string, unknown>) {
  const root: Record<string, unknown> = {};
  const masks: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    const parts = k.split('.');
    masks.push(parts.map(seg).join('.'));
    let cur = root;
    parts.slice(0, -1).forEach((p) => {
      const next = cur[p];
      cur = isPlain(next) ? next : ((cur[p] = {}) as Record<string, unknown>);
    });
    cur[parts[parts.length - 1]!] = v;
  }
  return { root, masks };
}

export function toRestWrites(base: string, ops: WriteOp[]): Field[] {
  return ops.map((op) => {
    const name = `${base}/${op.path}`;
    if (op.kind === 'delete') return { delete: name };
    const transforms: Field[] = [];
    if (op.kind === 'set') {
      const fields = encodeMap(op.data ?? {}, [], transforms);
      return {
        update: { name, fields },
        ...(transforms.length && { updateTransforms: transforms }),
      };
    }
    const { root, masks } = nest(op.data ?? {});
    const fields = encodeMap(root, [], transforms);
    // Sentinels (server time etc.) are not part of the mask: they ride in the transforms.
    const live = masks.filter((m) => !transforms.some((t) => t.fieldPath === m));
    return {
      update: { name, fields },
      updateMask: { fieldPaths: live },
      currentDocument: { exists: true },
      ...(transforms.length && { updateTransforms: transforms }),
    };
  });
}

/** Where to send, set by the signed-in shell; `getToken` is the Firebase ID token (cached by the SDK). */
let target: { commitUrl: string; db: string; getToken: () => Promise<string> } | null = null;
let token: string | null = null;

/** Fetches a fresh token ahead of time: the leave handler cannot await anything. */
export function warmToken(): void {
  target?.getToken().then(
    (t) => (token = t),
    () => undefined,
  );
}
export function configureBeacon(t: NonNullable<typeof target>): void {
  target = t;
  warmToken();
}

/** One keepalive commit per plan (each plan is atomic on its own, as with the SDK). Fire and forget. */
export function sendKeepalive(plans: WriteOp[][]): void {
  if (!target || !token) return;
  for (const ops of plans) {
    try {
      void fetch(target.commitUrl, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ writes: toRestWrites(`${target.db}/documents`, ops) }),
      }).catch(() => undefined);
    } catch {
      // Never let the leave handler throw.
    }
  }
}
