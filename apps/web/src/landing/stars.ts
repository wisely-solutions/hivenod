/** Below this the landing page shows no star count, only "Star on GitHub". */
export const MIN_STARS = 50;

/** The count as shown on the page ("1.2k"), or null to show none. */
export function formatStars(n: number | null | undefined): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < MIN_STARS) return null;
  if (n < 1000) return String(Math.floor(n));
  const k = n / 1000;
  return `${k < 10 ? Number(k.toFixed(1)) : Math.round(k)}k`;
}

/** Reads /stars.json, written by `pnpm release` (absent in dev and e2e builds). */
export async function loadStars(): Promise<number | null> {
  try {
    const res = await fetch('/stars.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const body = (await res.json()) as { stars?: unknown };
    return typeof body.stars === 'number' ? body.stars : null;
  } catch {
    return null;
  }
}
