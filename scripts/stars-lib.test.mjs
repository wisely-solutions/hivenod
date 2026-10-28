// The GitHub star count that `pnpm release` writes to dist/stars.json (item g17GWUkfKRFh4mgn0ciQ).
import { describe, expect, it } from 'vitest';
import { fetchStars, starsJson, STARS_REPO } from './stars-lib.mjs';

const reply = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('fetchStars', () => {
  it('reads stargazers_count of the public repository', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return reply(200, { stargazers_count: 1234 })();
    };
    expect(await fetchStars({ fetchImpl, token: 't0k' })).toBe(1234);
    expect(seen.url).toBe(`https://api.github.com/repos/${STARS_REPO}`);
    expect(seen.init.headers.authorization).toBe('Bearer t0k');
  });

  it('works without a token (public repo)', async () => {
    let headers;
    const fetchImpl = async (_url, init) => {
      headers = init.headers;
      return reply(200, { stargazers_count: 7 })();
    };
    expect(await fetchStars({ fetchImpl })).toBe(7);
    expect(headers.authorization).toBeUndefined();
  });

  it('is null on any failure, so a release never fails over it', async () => {
    expect(await fetchStars({ fetchImpl: reply(403, { message: 'rate limited' }) })).toBeNull();
    expect(await fetchStars({ fetchImpl: reply(200, { nope: 1 }) })).toBeNull();
    expect(await fetchStars({ fetchImpl: reply(200, { stargazers_count: -3 }) })).toBeNull();
    expect(
      await fetchStars({
        fetchImpl: async () => {
          throw new Error('offline');
        },
      }),
    ).toBeNull();
  });
});

describe('starsJson', () => {
  it('writes the count, or null when unknown', () => {
    expect(JSON.parse(starsJson(52))).toEqual({ stars: 52 });
    expect(JSON.parse(starsJson(null))).toEqual({ stars: null });
  });
});
