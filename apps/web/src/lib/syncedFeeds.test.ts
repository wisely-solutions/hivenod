import { beforeEach, describe, expect, it } from 'vitest';
import { clearSyncedFeeds, markSynced, wasSynced } from './syncedFeeds';

describe('synced feeds memory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('remembers a feed the server answered, per person', () => {
    expect(wasSynced('u1', 'items:w:p1')).toBe(false);
    markSynced('u1', 'items:w:p1');
    expect(wasSynced('u1', 'items:w:p1')).toBe(true);
    // Another person on the same browser has their own Firestore cache.
    expect(wasSynced('u2', 'items:w:p1')).toBe(false);
  });

  it('is forgotten on sign-out (the cache is cleared then too)', () => {
    markSynced('u1', 'items:w:p1');
    clearSyncedFeeds();
    expect(wasSynced('u1', 'items:w:p1')).toBe(false);
  });

  it('stays bounded, keeping the newest keys', () => {
    for (let i = 0; i < 600; i++) markSynced('u1', `k${i}`);
    expect(wasSynced('u1', 'k599')).toBe(true);
    expect(wasSynced('u1', 'k0')).toBe(false);
    expect(localStorage.getItem('hive-synced')!.length).toBeLessThan(20_000);
  });

  it('survives broken storage', () => {
    localStorage.setItem('hive-synced', '{not json');
    expect(wasSynced('u1', 'x')).toBe(false);
    markSynced('u1', 'x');
    expect(wasSynced('u1', 'x')).toBe(true);
  });
});
