/**
 * Firestore index rules: does `firestore.indexes.json` serve a query?
 *
 * The local emulator never checks indexes, so a query that needs a composite index production
 * lacks passes every test and fails only live. This module decides, conservatively, whether a
 * query is servable. "Conservative" means: when in doubt it asks for an index (a false alarm
 * costs one more index; a miss costs a broken screen in production).
 *
 * Rules applied (https://firebase.google.com/docs/firestore/query-data/index-overview):
 * - Equality-type filters are `==`, `in`, `array-contains`, `array-contains-any`; `<`, `<=`,
 *   `>`, `>=`, `!=`, `not-in` are inequalities (range filters).
 * - Firestore orders by every inequality field: explicit `orderBy`s first, then inequality fields
 *   that have no `orderBy`, in field-path order, in the direction of the last explicit `orderBy`
 *   (ascending when there is none). A range filter without `orderBy` therefore needs an
 *   ASCENDING index (the release-42 bug).
 * - Automatic single-field indexes exist only with COLLECTION scope (ascending, descending and
 *   array-contains), unless a `fieldOverrides` entry replaces them. Collection-group queries get
 *   single-field indexes only from `fieldOverrides`.
 * - Single-field indexes serve: only equality filters (merged, any number of fields), or one
 *   field that carries every filter and order. Anything else needs a composite index whose
 *   fields are the equality fields (any order; the array-contains field with arrayConfig
 *   CONTAINS) followed by the order fields in exactly the query's order and directions, with the
 *   same collection group and query scope.
 * - Not modelled (so they count as missing, never as servable): composite index merging,
 *   collection-group composite indexes serving collection queries, reversed index scans.
 */

const EQUALITY = new Set(['==', 'in', 'array-contains', 'array-contains-any']);
const INEQUALITY = new Set(['<', '<=', '>', '>=', '!=', 'not-in']);
const ARRAY = new Set(['array-contains', 'array-contains-any']);

/** @typedef {{ field: string, op: string }} Filter */
/** @typedef {{ field: string, dir: 'asc' | 'desc' }} Order */
/**
 * @typedef {{ group: string, scope: 'COLLECTION' | 'COLLECTION_GROUP',
 *   filters: Filter[], orders: Order[] }} QueryShape
 */

const dirName = (/** @type {'asc'|'desc'} */ d) => (d === 'desc' ? 'DESCENDING' : 'ASCENDING');

/**
 * The query as Firestore plans it: equality fields and the full ordering (explicit orders plus
 * the implicit ones for inequality fields). Throws on queries Firestore itself rejects or that
 * this module does not model.
 * @param {QueryShape} q
 */
export function plan(q) {
  for (const f of q.filters) {
    if (!EQUALITY.has(f.op) && !INEQUALITY.has(f.op)) throw new Error(`unknown operator '${f.op}'`);
  }
  if (q.filters.filter((f) => ARRAY.has(f.op)).length > 1) {
    throw new Error('Firestore allows at most one array-contains / array-contains-any filter');
  }
  /** @type {Map<string, string>} field -> op ('array' for array-contains*) */
  const eq = new Map();
  for (const f of q.filters) {
    if (!EQUALITY.has(f.op)) continue;
    const kind = ARRAY.has(f.op) ? 'array' : 'value';
    if (eq.has(f.field) && eq.get(f.field) !== kind) {
      throw new Error(
        `field '${f.field}' has both array and value equality filters (not modelled)`,
      );
    }
    eq.set(f.field, kind);
  }
  const ineq = [...new Set(q.filters.filter((f) => INEQUALITY.has(f.op)).map((f) => f.field))];
  for (const field of ineq) {
    if (eq.has(field))
      throw new Error(`field '${field}' has equality and range filters (not modelled)`);
  }
  for (const o of q.orders) {
    if (eq.has(o.field))
      throw new Error(`orderBy on equality-filtered field '${o.field}' (not modelled)`);
  }
  const orders = [...q.orders];
  const lastDir = orders.length ? orders[orders.length - 1].dir : 'asc';
  for (const field of [...ineq].sort()) {
    if (!orders.some((o) => o.field === field)) orders.push({ field, dir: lastDir });
  }
  // An explicit trailing __name__ order is what every index ends with anyway.
  while (orders.length > 0 && orders[orders.length - 1].field === '__name__') orders.pop();
  if (orders.some((o) => o.field === '__name__'))
    throw new Error('orderBy __name__ before other fields (not modelled)');
  return { eq, orders };
}

/**
 * Is there a single-field index for this field and kind ('ASCENDING' | 'DESCENDING' | 'CONTAINS')?
 * @param {any} config parsed firestore.indexes.json
 */
function singleField(config, group, scope, field, kind) {
  const override = (config.fieldOverrides ?? []).find(
    (o) => o.collectionGroup === group && o.fieldPath === field,
  );
  if (!override) return scope === 'COLLECTION';
  return (override.indexes ?? []).some(
    (i) =>
      (i.queryScope ?? 'COLLECTION') === scope &&
      (kind === 'CONTAINS' ? i.arrayConfig === 'CONTAINS' : i.order === kind),
  );
}

function indexMatches(index, group, scope, eq, orders) {
  if (index.collectionGroup !== group || (index.queryScope ?? 'COLLECTION') !== scope) return false;
  let fields = index.fields;
  if (fields.length > 0 && fields[fields.length - 1].fieldPath === '__name__') {
    const last = fields[fields.length - 1];
    const tail = orders.length ? dirName(orders[orders.length - 1].dir) : 'ASCENDING';
    if (last.order !== tail) return false;
    fields = fields.slice(0, -1);
  }
  if (fields.length !== eq.size + orders.length) return false;
  const head = fields.slice(0, eq.size);
  for (const f of head) {
    const kind = eq.get(f.fieldPath);
    if (!kind) return false;
    if (kind === 'array' ? f.arrayConfig !== 'CONTAINS' : !f.order) return false;
  }
  if (new Set(head.map((f) => f.fieldPath)).size !== eq.size) return false;
  return orders.every((o, i) => {
    const f = fields[eq.size + i];
    return f.fieldPath === o.field && f.order === dirName(o.dir);
  });
}

/**
 * Decide whether `config` serves query `q`.
 * @param {QueryShape} q
 * @param {any} config parsed firestore.indexes.json
 * @returns {{ ok: true, via: 'none' | 'single-field' | 'composite' }
 *   | { ok: false, missing: string, suggestion: any }}
 */
export function check(q, config) {
  const { eq, orders } = plan(q);
  const { group, scope } = q;
  if (eq.size === 0 && orders.length === 0) return { ok: true, via: 'none' };

  if (orders.length === 0) {
    const missing = [...eq].filter(
      ([field, kind]) =>
        !singleField(config, group, scope, field, kind === 'array' ? 'CONTAINS' : 'ASCENDING') &&
        !(kind !== 'array' && singleField(config, group, scope, field, 'DESCENDING')),
    );
    if (missing.length === 0) return { ok: true, via: 'single-field' };
  }
  if (eq.size === 0 && orders.length === 1) {
    const o = orders[0];
    if (singleField(config, group, scope, o.field, dirName(o.dir)))
      return { ok: true, via: 'single-field' };
  }
  if ((config.indexes ?? []).some((i) => indexMatches(i, group, scope, eq, orders))) {
    return { ok: true, via: 'composite' };
  }

  const fields = [
    ...[...eq].map(([fieldPath, kind]) =>
      kind === 'array' ? { fieldPath, arrayConfig: 'CONTAINS' } : { fieldPath, order: 'ASCENDING' },
    ),
    ...orders.map((o) => ({ fieldPath: o.field, order: dirName(o.dir) })),
  ];
  if (fields.length === 1) {
    const f = fields[0];
    return {
      ok: false,
      missing: `a ${scope} single-field index on ${group}.${f.fieldPath} (${f.arrayConfig ?? f.order})`,
      suggestion: {
        fieldOverrides: [
          {
            collectionGroup: group,
            fieldPath: f.fieldPath,
            indexes: [
              { order: 'ASCENDING', queryScope: 'COLLECTION' },
              { order: 'DESCENDING', queryScope: 'COLLECTION' },
              { arrayConfig: 'CONTAINS', queryScope: 'COLLECTION' },
              f.arrayConfig
                ? { arrayConfig: 'CONTAINS', queryScope: scope }
                : { order: f.order, queryScope: scope },
            ],
          },
        ],
      },
    };
  }
  return {
    ok: false,
    missing: `a ${scope} composite index on ${group} (${fields
      .map((f) => `${f.fieldPath} ${f.arrayConfig ?? f.order}`)
      .join(', ')})`,
    suggestion: { collectionGroup: group, queryScope: scope, fields },
  };
}

/** One-line description of a query shape, for messages. */
export function describeQuery(q) {
  const parts = [
    `${q.scope === 'COLLECTION_GROUP' ? 'collectionGroup' : 'collection'} '${q.group}'`,
    ...q.filters.map((f) => `where(${f.field} ${f.op})`),
    ...q.orders.map((o) => `orderBy(${o.field} ${o.dir})`),
  ];
  return parts.join(' ');
}
