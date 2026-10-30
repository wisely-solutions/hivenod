/**
 * Firestore query sites the index guard cannot analyse statically, each with the reason it is
 * still safe. An entry matches by file and the exact call text (whitespace collapsed); an entry
 * that no longer matches anything fails the guard, so this list cannot rot.
 */
export const ALLOWLIST = [
  {
    file: 'apps/web/src/activity/data.ts',
    text: 'query(col, ...rest)',
    reason:
      'Activity feed: filters come from feedConstraints(); every filter combination is checked against firestore.indexes.json in apps/web/src/activity/indexes.test.ts.',
  },
  {
    file: 'apps/web/src/activity/data.ts',
    text: 'where(f, op, v)',
    reason: 'Activity feed filters (feedConstraints), see the entry above.',
  },
  {
    file: 'apps/web/src/activity/data.ts',
    text: "orderBy('at', 'desc')",
    reason: 'Activity feed order, see the entries above.',
  },
  {
    file: 'apps/web/src/orgs/deleteOrg.ts',
    text: 'query(collection(db, col), limit(max))',
    reason:
      'Org delete walks every subcollection in batches: a plain collection read with only limit(), no where/orderBy, so it needs no composite index.',
  },
  {
    file: 'apps/web/src/orgs/exportOrg.ts',
    text: 'query(base, orderBy(documentId()), startAfter(afterId), limit(max))',
    reason:
      'Org export pages one collection at a time by document id: a single orderBy on __name__ with startAfter and limit, no where, so the automatic index serves it.',
  },
  {
    file: 'apps/web/src/orgs/exportOrg.ts',
    text: 'query(base, orderBy(documentId()), limit(max))',
    reason: 'First page of the org export, see the entry above.',
  },
  {
    file: 'cli/internal/hive/inbox.go',
    text: 'c.DB.Collection(model.Paths.InboxCollection(c.WorkspaceID, coll)).Where(field, op, value)',
    reason:
      'listInbox is the generic inbox helper: it always applies exactly one Where() on one field and no OrderBy, which automatic single-field indexes serve whatever the field and operator. The helper cannot add a second filter or an order, so no call site can need a composite index.',
  },
];
