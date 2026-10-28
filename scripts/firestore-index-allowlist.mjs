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
    file: 'apps/web/src/board/eraseItem.ts',
    text: 'query(collection(db, col), limit(max))',
    reason:
      'Item delete walks its subcollections (log lines, messages, files) in batches: a plain collection read with only limit(), no where/orderBy, so it needs no composite index.',
  },
  {
    file: 'packages/agent/src/inbox.ts',
    text: 'query(collection(this.d.db, `workspaces/${w}/inboxThreads`), where(field, op, value))',
    reason:
      'Inbox agent tools (item 4PEHr): exactly one where() (==, in or array-contains) and no orderBy, which single-field indexes always serve; results are sorted in memory.',
  },
  {
    file: 'packages/agent/src/inbox.ts',
    text: 'query(collection(this.d.db, `workspaces/${w}/inboxSubjects`), where(field, op, value))',
    reason:
      'Inbox agent tools (item 4PEHr): exactly one where() (==, in or array-contains) and no orderBy, which single-field indexes always serve; results are sorted in memory.',
  },
  {
    file: 'packages/agent/src/inbox.ts',
    text: 'query(collection(this.d.db, `workspaces/${w}/inboxMessages`), where(field, op, value))',
    reason:
      'Inbox agent tools (item 4PEHr): exactly one where() (==, in or array-contains) and no orderBy, which single-field indexes always serve; results are sorted in memory.',
  },
  {
    file: 'packages/agent/src/inbox.ts',
    text: 'query(collection(this.d.db, `workspaces/${w}/inboxOutcomes`), where(field, op, value))',
    reason:
      'Inbox agent tools (item 4PEHr): exactly one where() (==, in or array-contains) and no orderBy, which single-field indexes always serve; results are sorted in memory.',
  },
  {
    file: 'packages/agent/src/inbox.ts',
    text: 'query(collection(this.d.db, `workspaces/${w}/inboxEvents`), where(field, op, value))',
    reason:
      'Inbox agent tools (item 4PEHr): exactly one where() (==, in or array-contains) and no orderBy, which single-field indexes always serve; results are sorted in memory.',
  },
];
