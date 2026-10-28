// The GitHub star count shown on the landing page (item g17GWUkfKRFh4mgn0ciQ). `pnpm release` asks
// GitHub once and writes apps/web/dist/stars.json, so visitors never call GitHub. Any failure gives
// null (the page then shows no count) and never fails a release.

export const STARS_REPO = 'wisely-solutions/hivenod';

/** The repository's star count, or null when GitHub can't say (rate limit, offline, odd reply). */
export async function fetchStars({ fetchImpl = fetch, token, repo = STARS_REPO } = {}) {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'hivenod-release',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const n = (await res.json())?.stargazers_count;
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** The body of dist/stars.json. */
export function starsJson(stars) {
  return JSON.stringify({ stars: stars ?? null }) + '\n';
}
