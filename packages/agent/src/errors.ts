/** Errors the agent client shows to people and agents: one clear sentence, no stack traces. */
export class HiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HiveError';
  }
}

export const GATE_MESSAGE = 'This item is at a human gate. Only people can move it.';
export const REVOKED_MESSAGE =
  'This agent cannot use Hivenod: it was revoked, rotated, or is not allowed in this organization. Ask an admin for a new token.';

/** Firebase errors carry a `code`; this reads it without importing the SDK. */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/** Firebase answering "slow down" (QUOTA_EXCEEDED, too many requests): not a rejected token. */
export function isRateLimited(err: unknown): boolean {
  const code = errorCode(err);
  if (
    code === 'auth/too-many-requests' ||
    code === 'auth/quota-exceeded' ||
    code === 'resource-exhausted'
  )
    return true;
  // HiveClient.connect wraps a sign-in rate limit into a HiveError with this message.
  if (messageOf(err) === RATE_LIMIT_MESSAGE) return true;
  return /QUOTA_EXCEEDED|TOO_MANY_ATTEMPTS|quota-exceeded|too-many-requests/i.test(messageOf(err));
}

export const RATE_LIMIT_MESSAGE =
  'Firebase is limiting requests for a moment (rate limit, not a problem with your token). Wait a minute and try again.';

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A person pressed Stop work on this item in Hivenod (card BrK0r2FE). */
export const STOPPED_PREFIX = 'People stopped this work in Hivenod';
export function stoppedMessage(run: { summary?: string | null } | null): string {
  return `${STOPPED_PREFIX}${run?.summary ? ` (${run.summary})` : ''}. Stop working on this item; it is not yours any more.`;
}
export function isStoppedMessage(err: unknown): boolean {
  return messageOf(err).startsWith(STOPPED_PREFIX);
}

export const ON_HOLD_MESSAGE =
  'People stopped the work on this item and put it on hold in Hivenod. No agent can claim it until someone presses Resume. Pick another item (hivenod work list).';
