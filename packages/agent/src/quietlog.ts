/**
 * The Firestore SDK warns "BloomFilter error: Invalid hash count: 0" when the server sends an
 * empty existence filter on a listener resume. It is harmless (the client falls back to a full
 * re-read) but lands in the MCP log of a Claude session (card pqqOWE3s). Drop only that warning;
 * every other warning and error is passed through untouched.
 */
type Warn = (...args: unknown[]) => void;

export function isBloomFilterNoise(args: unknown[]): boolean {
  return args.some((a) => typeof a === 'string' && a.includes('BloomFilter error'));
}

/** Wraps console.warn once; returns a function that restores it. */
export function quietBloomFilterWarning(target: { warn: Warn } = console): () => void {
  const original = target.warn;
  target.warn = (...args: unknown[]) => {
    if (isBloomFilterNoise(args)) return;
    original.apply(target, args);
  };
  const mine = target.warn;
  return () => {
    if (target.warn === mine) target.warn = original;
  };
}
