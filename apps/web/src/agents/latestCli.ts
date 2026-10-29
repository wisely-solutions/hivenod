import { useEffect, useState } from 'react';

/** The newest published CLI version, from the site's own /cli/bin/latest.json (item N9EEn). */
let cached: Promise<string | null> | null = null;

export function fetchLatestCli(): Promise<string | null> {
  cached ??= fetch('/cli/bin/latest.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { version?: unknown } | null) =>
      typeof j?.version === 'string' && /^\d+(\.\d+)*$/.test(j.version) ? j.version : null,
    )
    .catch(() => null);
  return cached;
}

/** Test hook: forget the answer so the next hook run fetches again. */
export function resetLatestCli() {
  cached = null;
}

/** null until known, or when the site does not say. */
export function useLatestCli(): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void fetchLatestCli().then((x) => live && setV(x));
    return () => {
      live = false;
    };
  }, []);
  return v;
}
