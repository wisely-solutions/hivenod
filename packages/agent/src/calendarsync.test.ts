import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFeed, saveSyncState } from './calendar';

describe('calendar sync feed and state (item fJnu6)', () => {
  it('reads a Google events list or an array; refuses anything else', () => {
    expect(
      parseFeed('{"kind":"calendar#events","items":[{"id":"a"}],"nextSyncToken":"tok"}', 'x.json'),
    ).toEqual({ items: [{ id: 'a' }], nextSyncToken: 'tok' });
    expect(parseFeed('[{"id":"a"},{"id":"b"}]', 'x.json').items).toHaveLength(2);
    for (const bad of ['nope', '{"events":[]}', '42'])
      expect(() => parseFeed(bad, 'x.json')).toThrow(/^x\.json: /);
  });
  it('keeps only the token, mode 600, and nothing without one', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'sync-')), 'state.json');
    saveSyncState(f, { source: 'google', member: 'u1', nextSyncToken: null });
    expect(existsSync(f)).toBe(false);
    saveSyncState(f, { source: 'google', member: 'u1', nextSyncToken: 'tok-9' });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toMatchObject({ syncToken: 'tok-9', member: 'u1' });
  });
});
