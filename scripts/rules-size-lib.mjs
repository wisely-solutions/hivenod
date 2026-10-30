// Firestore rules size: Google refuses to *release* a ruleset whose compiled executables are
// 256000 bytes or more (creating the ruleset still succeeds). Nothing in the API reports the
// compiled size of a ruleset that fits, so `measureRulesSize` creates a throwaway ruleset and
// a throwaway release (`releases/size-probe`), padded with unused functions until the release
// is refused, and reads the size from the 400 message. Everything it creates is deleted.
// See docs/DEPLOY.md "Rules size".

/** Google's limit: compiled executables must be smaller than this. */
export const RULES_COMPILED_LIMIT = 256000;
/** Our budget for the compiled size (about 8% headroom under the limit). */
export const RULES_COMPILED_BUDGET = 235000;

/** The compiled size from Google's 400 message, or null. */
export function parseCompiledSize(text) {
  const m = /compiled executables must be smaller than \d+ bytes \(actual: (\d+) bytes\)/i.exec(
    String(text ?? ''),
  );
  return m ? Number(m[1]) : null;
}

/**
 * `src` with `n` unused pad functions inside the `service cloud.firestore` block. Every pad
 * function has the same shape and a fixed-width name, so each one adds the same compiled size.
 */
export function padRules(src, n) {
  if (n <= 0) return src;
  const at = src.indexOf('service cloud.firestore {');
  if (at < 0) throw new Error('padRules: no "service cloud.firestore {" block');
  const j = src.indexOf('{', at) + 1;
  const terms = Array.from({ length: 20 }, (_, i) => `x == ${i}`).join(' || ');
  let pad = '\n';
  for (let k = 0; k < n; k++) {
    pad += `  function zzSizePad${String(k).padStart(5, '0')}(x) { return ${terms}; }\n`;
  }
  return src.slice(0, j) + pad + src.slice(j);
}

/**
 * The compiled size of `source`. `tryRelease(source)` uploads the ruleset and tries a throwaway
 * release, cleans up, and returns the compiled size when Google refused it for size, or null
 * when the release fit. Unpadded first; when it fits, pad with n functions (doubling from 40)
 * until refused, then once more with n + 20 to learn the exact cost per pad function.
 * @returns {Promise<number>}
 */
export async function measureCompiledSize(source, tryRelease, { maxPad = 1280 } = {}) {
  const direct = await tryRelease(source);
  if (direct != null) return direct;
  let n = 40;
  let m1 = null;
  while (n <= maxPad) {
    m1 = await tryRelease(padRules(source, n));
    if (m1 != null) break;
    n *= 2;
  }
  if (m1 == null) throw new Error(`rules size probe: still under the limit with ${maxPad} pads`);
  const m2 = await tryRelease(padRules(source, n + 20));
  if (m2 == null) throw new Error('rules size probe: a bigger pad fit where a smaller one did not');
  const perPad = (m2 - m1) / 20;
  return Math.round(m1 - n * perPad);
}

/** The rules without comments. */
export function stripRulesComments(src) {
  return String(src)
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

/**
 * Tokens of the rules source (comments dropped): `words` are identifiers, strings and numbers,
 * `chars` their total length, `tokens` everything including operators and brackets.
 */
export function rulesTokenStats(src) {
  const toks =
    stripRulesComments(src).match(
      /[A-Za-z_][A-Za-z0-9_]*|'[^']*'|\d+(?:\.\d+)?|==|!=|<=|>=|&&|\|\||[^\sA-Za-z0-9_]/g,
    ) ?? [];
  const words = toks.filter((t) => /^[A-Za-z_'0-9]/.test(t));
  return {
    tokens: toks.length,
    words: words.length,
    chars: words.reduce((n, t) => n + t.length, 0),
  };
}

/**
 * Offline estimate of the compiled size: Google's compiled size grows with the number of tokens
 * (AST nodes) and the length of names and strings; comments and whitespace cost nothing.
 * Calibrated by least squares on eight measured rulesets (release-150 to this change): within
 * about 1500 bytes of the measured size. Recalibrate with scripts/rules-size.mjs if it drifts.
 */
export function estimateCompiledSize(src) {
  const { tokens, chars } = rulesTokenStats(src);
  return Math.round(4.4727 * tokens + 0.9526 * chars - 10837);
}

/** One-line verdict for the deploy log. */
export function rulesSizeVerdict(size, limit = RULES_COMPILED_LIMIT) {
  return size >= limit
    ? `rules too big: ${size} of ${limit} bytes (Google refuses the release; see docs/DEPLOY.md "Rules size")`
    : `rules compiled size: ${size} of ${limit} bytes (${Math.round((100 * (limit - size)) / limit)}% headroom)`;
}
