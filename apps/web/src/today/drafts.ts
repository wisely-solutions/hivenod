/**
 * What the member has typed into a proposal but not sent yet, per outcome and version: the edit
 * form's values, the open Ask for changes box, and the version on show. Kept outside the
 * component so a remount (the phone's bottom sheet opening or closing, the panel moving between
 * layouts) never drops an edit: Send then always sends exactly the text on screen.
 * Memory only, for this tab.
 */
type Values = Record<string, string | boolean>;

interface Draft {
  editing: boolean;
  values: Values;
}
export interface AskDraft {
  chips: string[];
  text: string;
}

const edits = new Map<string, Draft>();
const asks = new Map<string, AskDraft>();
const shown = new Map<string, number>();

export const editKey = (wid: string, oid: string, version: number) => `${wid}:${oid}:v${version}`;

export function getEdit(key: string): Draft | undefined {
  return edits.get(key);
}
export function setEdit(key: string, d: Draft | null) {
  if (d) edits.set(key, d);
  else edits.delete(key);
}

export function getAsk(key: string): AskDraft | undefined {
  return asks.get(key);
}
export function setAsk(key: string, d: AskDraft | null) {
  if (d) asks.set(key, d);
  else asks.delete(key);
}

/** The version on show, if the member picked an older one (absent: the latest). */
export function getShown(key: string): number | undefined {
  return shown.get(key);
}
export function setShown(key: string, n: number | null) {
  if (n === null) shown.delete(key);
  else shown.set(key, n);
}

/** Forget everything about an outcome (it was decided). */
export function forgetOutcome(wid: string, oid: string) {
  const prefix = `${wid}:${oid}`;
  for (const m of [edits, asks, shown] as Map<string, unknown>[])
    for (const k of [...m.keys()]) if (k === prefix || k.startsWith(`${prefix}:`)) m.delete(k);
}
