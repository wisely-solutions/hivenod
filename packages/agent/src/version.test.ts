import { describe, expect, it } from 'vitest';
import { updateNeeded } from './version';

const site = (body: unknown, ok = true) =>
  (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe('CLI protocol check (card st5INNZj)', () => {
  it('asks to update when the site expects a newer CLI protocol', async () => {
    const msg = await updateNeeded('https://h.example', site({ cliProtocol: 3 }), 2);
    expect(msg).toMatch(/too old/);
    expect(msg).toContain('npm install -g https://h.example/cli/hivenod-latest.tgz');
  });
  it('carries on when the site is the same or older, says nothing, or cannot be read', async () => {
    expect(await updateNeeded('https://h', site({ cliProtocol: 2 }), 2)).toBeNull();
    expect(await updateNeeded('https://h', site({ commit: 'abc' }), 2)).toBeNull();
    expect(await updateNeeded('https://h', site({}, false), 2)).toBeNull();
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await updateNeeded('https://h', down, 2)).toBeNull();
  });
});
