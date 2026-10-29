/**
 * An organization's colour (item kt3E7u9EliL3q2veDDI0, design 3.6): computed in the browser,
 * never stored. The member's organizations sorted by name, then id; the index picks one of 8
 * colour tokens, so two of one member's organizations share a colour only beyond 8.
 */
export const ORG_COLORS = 8;

export function orgColorIndex(
  wid: string,
  orgs: ReadonlyArray<{ wid: string; name: string }>,
): number {
  const sorted = [...orgs].sort((a, b) =>
    a.name === b.name ? (a.wid < b.wid ? -1 : a.wid > b.wid ? 1 : 0) : a.name < b.name ? -1 : 1,
  );
  const i = sorted.findIndex((o) => o.wid === wid);
  return (Math.max(0, i) % ORG_COLORS) + 1;
}

/** The CSS colour of an organization (its dot, its chip's dot). */
export function orgColor(wid: string, orgs: ReadonlyArray<{ wid: string; name: string }>): string {
  return `var(--agent-${orgColorIndex(wid, orgs)})`;
}

/**
 * The member's own Personal organization (item icVly): named "Personal", made by them, and only
 * them in it. It gets a person mark and the line "Just you · your assistant".
 */
export function isPersonalOrg(
  org: { name: string; ownerUid: string; members: number },
  uid: string,
): boolean {
  return org.ownerUid === uid && org.members === 1 && org.name.trim().toLowerCase() === 'personal';
}
