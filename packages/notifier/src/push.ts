import webpush from 'web-push';
import type { Notice, PushSub } from '@hive/shared';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** What one push send came to. `status` is the push service's HTTP code, absent on a network error. */
export interface PushOutcome {
  result: 'ok' | 'gone' | 'error';
  status?: number;
  /** Short reason on failure (the service's body, or the network error). Never holds keys. */
  detail?: string;
  attempts: number;
}

export interface PushDeps {
  send?: (
    sub: { endpoint: string; keys: PushSub['keys'] },
    payload: string,
    options: Record<string, unknown>,
  ) => Promise<{ statusCode: number }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const PUSH_TRIES = 3;
export const PUSH_BACKOFF_MS = 1000;
/**
 * Pop-ups are live only (item 3ENs): a push the push service could not deliver within this time
 * is dropped by it, and the service worker drops one stamped older than PUSH_MAX_AGE_MS. What was
 * missed is in the bell (users/{uid}/notifications), not replayed as pop-ups.
 */
export const PUSH_TTL_S = 5 * 60;
/** Push services reject payloads over about 4 KB; we stay well under. */
export const PUSH_MAX_BYTES = 3500;

/** 429, 5xx and network errors (no status) are worth another try; other 4xx will not change. */
export function retryable(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

function clipPayload(notice: Notice, sentAt: number): string {
  let n: Notice = { ...notice, sentAt };
  let s = JSON.stringify(n);
  while (Buffer.byteLength(s) > PUSH_MAX_BYTES && n.body.length > 20) {
    n = { ...n, body: n.body.slice(0, Math.floor(n.body.length / 2)) };
    s = JSON.stringify(n);
  }
  return s;
}

export function makePushSender(vapid: VapidKeys, deps: PushDeps = {}) {
  if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(vapid.subject)) {
    throw new Error(
      `VAPID_SUBJECT must be a mailto: address or an https URL, got "${vapid.subject}"`,
    );
  }
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  const send =
    deps.send ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (sub: PushSub, notice: Notice): Promise<PushOutcome> => {
    let last: PushOutcome = { result: 'error', attempts: 0 };
    for (let attempt = 1; attempt <= PUSH_TRIES; attempt++) {
      try {
        // Stamped per try, so a retry after a backoff still carries its real send time.
        const payload = clipPayload(notice, now());
        const res = await send({ endpoint: sub.endpoint, keys: sub.keys }, payload, {
          TTL: PUSH_TTL_S,
          urgency: 'high',
          contentEncoding: 'aes128gcm',
        });
        return { result: 'ok', status: res.statusCode, attempts: attempt };
      } catch (e) {
        const err = e as { statusCode?: number; body?: unknown; message?: string };
        const status = err.statusCode;
        if (status === 404 || status === 410) return { result: 'gone', status, attempts: attempt };
        const detail = String(err.body || err.message || e)
          .replace(/\s+/g, ' ')
          .slice(0, 160);
        last = { result: 'error', status, detail, attempts: attempt };
        if (!retryable(status) || attempt === PUSH_TRIES) return last;
        await sleep(PUSH_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    return last;
  };
}

export function newVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
