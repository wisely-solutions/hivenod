import { describe, expect, it } from 'vitest';
import { makePushSender, newVapidKeys, retryable } from './push';

const keys = newVapidKeys();
const vapid = { ...keys, subject: 'mailto:a@b.co' };
const sub = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/x',
  keys: { p256dh: 'p', auth: 'a' },
  label: '',
  createdAt: 0,
};
const notice = { title: 't', body: 'b', url: '/' };
const err = (statusCode?: number) => Object.assign(new Error('boom'), { statusCode, body: 'bad' });

describe('push sender', () => {
  it('rejects a VAPID subject that is not mailto: or https', () => {
    expect(() => makePushSender({ ...vapid, subject: 'hive-agent@x.io' })).toThrow(/mailto/);
  });
  it('sends with a 5 minute TTL, high urgency and aes128gcm and reports the status', async () => {
    let opts: Record<string, unknown> = {};
    let body = '';
    const send = makePushSender(vapid, {
      send: async (_s, p, o) => {
        opts = o;
        body = p;
        return { statusCode: 201 };
      },
      now: () => 1_700_000_000_000,
    });
    expect(await send(sub, notice)).toEqual({ result: 'ok', status: 201, attempts: 1 });
    expect(opts).toMatchObject({ TTL: 300, urgency: 'high', contentEncoding: 'aes128gcm' });
    // The payload carries its send time, so the service worker can drop a late one.
    expect(JSON.parse(body)).toEqual({ ...notice, sentAt: 1_700_000_000_000 });
  });
  it('stamps each retry with its own send time', async () => {
    const stamps: number[] = [];
    let t = 1000;
    const send = makePushSender(vapid, {
      send: async (_s, p) => {
        stamps.push(JSON.parse(p).sentAt);
        if (stamps.length < 2) throw err(503);
        return { statusCode: 201 };
      },
      sleep: async (ms) => void (t += ms),
      now: () => t,
    });
    await send(sub, notice);
    expect(stamps).toEqual([1000, 2000]);
  });
  it('retries 5xx with backoff, then succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    const send = makePushSender(vapid, {
      send: async () => {
        if (++n < 3) throw err(503);
        return { statusCode: 201 };
      },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await send(sub, notice)).toMatchObject({ result: 'ok', attempts: 3 });
    expect(waits).toEqual([1000, 2000]);
  });
  it('returns the last status after 3 failed tries and does not retry a 403', async () => {
    let n = 0;
    const s1 = makePushSender(vapid, {
      send: async () => (n++, Promise.reject(err(429))),
      sleep: async () => {},
    });
    expect(await s1(sub, notice)).toMatchObject({
      result: 'error',
      status: 429,
      attempts: 3,
      detail: 'bad',
    });
    n = 0;
    const s2 = makePushSender(vapid, {
      send: async () => (n++, Promise.reject(err(403))),
      sleep: async () => {},
    });
    expect(await s2(sub, notice)).toMatchObject({ result: 'error', status: 403, attempts: 1 });
    expect(n).toBe(1);
  });
  it('reports gone on 404/410 and retries network errors', async () => {
    const gone = makePushSender(vapid, { send: async () => Promise.reject(err(410)) });
    expect((await gone(sub, notice)).result).toBe('gone');
    expect(retryable(undefined)).toBe(true);
    expect(retryable(400)).toBe(false);
  });
  it('keeps the payload under the size limit', async () => {
    let size = 0;
    const send = makePushSender(vapid, {
      send: async (_s, p) => ((size = Buffer.byteLength(p)), { statusCode: 201 }),
    });
    await send(sub, { ...notice, body: 'x'.repeat(10000) });
    expect(size).toBeLessThan(3600);
  });
});
