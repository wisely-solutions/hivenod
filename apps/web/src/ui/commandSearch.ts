/**
 * Palette search (card O2Ehb9CG). Exact and prefix matches first, then word starts, then any
 * substring: no fuzzy matching, so "Faster" no longer lists "Forge". Items also match their
 * description, and a few words narrow the result: "waiting on me", a type ("bug"), a project name.
 */
export interface Searchable {
  id: string;
  label: string;
  group: string;
  /** Longer text the query may match (an item's description). Ranks below the label. */
  body?: string;
  /** Narrowing words: the project name, the type, the status; and "waiting on me". */
  tags?: readonly string[];
  /** An item's type: a query word equal to it ranks the item above title matches. */
  type?: string;
}

export const WAITING_ON_ME = 'waiting on me';

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const words = (s: string) =>
  fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Score of one token in a text: 0 no match, higher is better. */
function tokenScore(token: string, text: string): number {
  const t = fold(text);
  if (t === token) return 100;
  if (t.startsWith(token)) return 80;
  if (words(text).some((w) => w.startsWith(token))) return 60;
  return t.includes(token) ? 30 : 0;
}

/** Group order when two matches score the same: what a person most likely means. */
const GROUP_BIAS: Record<string, number> = { Items: 3, Projects: 2, Actions: 1 };

export function scoreCommand(item: Searchable, query: string): number {
  let q = fold(query).trim();
  if (!q) return 1;
  const mine = q.includes(WAITING_ON_ME);
  if (mine) {
    if (!item.tags?.includes(WAITING_ON_ME)) return 0;
    q = q.replace(WAITING_ON_ME, ' ').trim();
  }
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 50;
  // The whole phrase as the title is the best match there can be.
  const whole = tokens.join(' ');
  let total = 0;
  for (const tok of tokens) {
    const inLabel = tokenScore(tok, item.label);
    const inTag = Math.max(
      0,
      ...(item.tags ?? []).map((t) => (tokenScore(tok, t) ? 25 : 0)),
      item.type && fold(item.type) === tok ? 90 : 0,
    );
    const inBody = item.body && fold(item.body).includes(tok) ? 15 : 0;
    const s = Math.max(inLabel, inTag, inBody);
    if (s === 0) return 0;
    total += s;
  }
  let score = total / tokens.length;
  if (tokens.length > 1 && fold(item.label) === whole) score = 100;
  else if (tokens.length > 1 && fold(item.label).startsWith(whole)) score = Math.max(score, 80);
  return score + (GROUP_BIAS[item.group] ?? 0) / 10;
}

/** Matching commands, best first; with no query, everything in its given order. */
export function searchCommands<T extends Searchable>(items: readonly T[], query: string): T[] {
  if (!query.trim()) return [...items];
  return items
    .map((it, i) => ({ it, i, s: scoreCommand(it, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it);
}

/** Why an item matched, for the small label in the palette: its type, title, project, status or description. */
export function matchReason(item: Searchable, query: string): string | null {
  const tokens = fold(query).replace(WAITING_ON_ME, ' ').split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || item.group !== 'Items') return null;
  if (tokens.some((t) => item.type && fold(item.type) === t)) return `type: ${item.type}`;
  if (tokens.every((t) => tokenScore(t, item.label) > 0)) return null;
  if (tokens.some((t) => (item.tags ?? []).some((g) => tokenScore(t, g) > 0)))
    return 'project or status';
  if (item.body && tokens.some((t) => fold(item.body ?? '').includes(t))) return 'description';
  return null;
}
