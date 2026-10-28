/**
 * Counts the documents Firestore delivers from the server (what the free quota bills), per page
 * load, so the audit can report reads per screen. Exposed as `window.__hiveReads`.
 */
type Counted = { metadata: { fromCache: boolean }; docChanges?: () => unknown[] };

export function countReads(snap: Counted): void {
  if (snap.metadata.fromCache) return;
  const n = snap.docChanges ? snap.docChanges().length : 1;
  const w = window as unknown as { __hiveReads?: number };
  w.__hiveReads = (w.__hiveReads ?? 0) + n;
}
