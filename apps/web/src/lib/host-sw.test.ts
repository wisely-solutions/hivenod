import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// public/host-sw.js is a classic script for the service worker: run it against a fake `self`.
const root = {} as {
  hivenodHost: { redirectTarget(h: string): string | null; appOrigin(o: string): string };
};
new Function('self', readFileSync('public/host-sw.js', 'utf8'))(root);
const { redirectTarget, appOrigin } = root.hivenodHost;

describe('service worker host redirect (card HHyedSAg)', () => {
  it('sends legacy hosts to hivenod.com, keeping path and query', () => {
    expect(redirectTarget('https://hivenod.web.app/agents?x=1')).toBe(
      'https://hivenod.com/agents?x=1',
    );
    expect(redirectTarget('https://hive-board-43be.web.app/')).toBe('https://hivenod.com/');
    expect(redirectTarget('https://hivenod.web.app/p/abc#c1')).toBe('https://hivenod.com/p/abc#c1');
  });
  it('leaves version.json, the CLI, the auth handler, previews and the public host alone', () => {
    expect(redirectTarget('https://hivenod.web.app/version.json')).toBeNull();
    expect(redirectTarget('https://hivenod.web.app/cli/hivenod-latest.tgz')).toBeNull();
    expect(redirectTarget('https://hivenod.web.app/__/auth/handler')).toBeNull();
    expect(redirectTarget('https://hivenod--pr-12-abc.web.app/agents')).toBeNull();
    expect(redirectTarget('https://hivenod.com/agents')).toBeNull();
    expect(redirectTarget('http://localhost:5173/agents')).toBeNull();
  });
  it('opens notifications on hivenod.com for legacy hosts only', () => {
    expect(appOrigin('https://hivenod.web.app')).toBe('https://hivenod.com');
    expect(appOrigin('https://hive-board-43be.web.app')).toBe('https://hivenod.com');
    expect(appOrigin('https://hivenod.com')).toBe('https://hivenod.com');
    expect(appOrigin('https://hivenod--x.web.app')).toBe('https://hivenod--x.web.app');
    expect(appOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });
});
