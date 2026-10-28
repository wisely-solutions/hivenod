import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// public/push-sw.js is a classic script for the service worker: run it against a fake `self`.
type Shown = { title: string; options: { body: string; data: { url: string } } };
function loadWorker() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const shown: Shown[] = [];
  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
    registration: {
      showNotification: async (title: string, options: Shown['options']) =>
        void shown.push({ title, options }),
    },
  } as Record<string, unknown>;
  new Function('self', readFileSync('public/push-sw.js', 'utf8'))(self);
  const push = async (payload: unknown) => {
    const waits: Promise<unknown>[] = [];
    handlers.push!({
      data: { json: () => payload, text: () => JSON.stringify(payload) },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    await Promise.all(waits);
  };
  return {
    shown,
    push,
    api: self.hivenodPush as { pushIsFresh(d: unknown, now: number): boolean; MAX_AGE_MS: number },
  };
}

describe('push service worker: pop-ups only live (item 3ENs)', () => {
  it('shows a fresh push and drops one older than 5 minutes', async () => {
    const w = loadWorker();
    const now = Date.now();
    await w.push({ title: 'Fresh', body: 'b', url: '/p/x?item=1', sentAt: now - 60_000 });
    await w.push({ title: 'Old', body: 'b', url: '/p/x?item=2', sentAt: now - 6 * 60_000 });
    await w.push({ title: 'Yesterday', body: 'b', url: '/', sentAt: now - 24 * 3600_000 });
    expect(w.shown.map((s) => s.title)).toEqual(['Fresh']);
    expect(w.shown[0]!.options.data.url).toBe('/p/x?item=1');
  });
  it('decides by the send time against a 5 minute limit', () => {
    const { api } = loadWorker();
    const now = 1_700_000_000_000;
    expect(api.MAX_AGE_MS).toBe(300_000);
    expect(api.pushIsFresh({ sentAt: now }, now)).toBe(true);
    expect(api.pushIsFresh({ sentAt: now - 300_000 }, now)).toBe(true);
    expect(api.pushIsFresh({ sentAt: now - 300_001 }, now)).toBe(false);
    // A device clock slightly behind the server still shows it.
    expect(api.pushIsFresh({ sentAt: now + 30_000 }, now)).toBe(true);
  });
  it('still shows a push without a send time (an older notifier)', async () => {
    const w = loadWorker();
    await w.push({ title: 'Legacy', body: 'b', url: '/' });
    expect(w.shown).toHaveLength(1);
  });
});
