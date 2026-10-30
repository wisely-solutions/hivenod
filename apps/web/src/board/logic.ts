// Projects were removed from the web app (item OE8FmrTaIxFVGcaeGG3N, slice 10). Only what the
// Activity feed still uses is left here; it moves with the slice 9 activity rework.

/** An attachment counts as new for this long after the run produced it. */
export const NEW_ATTACHMENT_MS = 10 * 60_000;

export function isNewAttachment(at: number, now: number): boolean {
  return now - at >= 0 && now - at < NEW_ATTACHMENT_MS;
}
