// Firestore rules size: Google refuses to *release* a ruleset whose compiled executables are
// 256000 bytes or more (creating the ruleset still succeeds). Nothing in the API reports the
// compiled size of a ruleset that fits, so `measureRulesSize` creates a throwaway ruleset and
// a throwaway release (`releases/size-probe`), padded with unused functions until the release
// is refused, and reads the size from the 400 message. Everything it creates is deleted.
// See docs/DEPLOY.md "Rules size and compile time".

/** Google's limit: compiled executables must be smaller than this. */
export const RULES_COMPILED_LIMIT = 256000;
/**
 * Our budget for the compiled size. Lowered to about 15% above the rules after Projects were
 * removed (OE8Fm slice 11: 126660 bytes measured, 121065 estimated), so they cannot creep back
 * towards the limit.
 */
export const RULES_COMPILED_BUDGET = 145000;

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
  // One long string per pad: it adds compiled bytes but almost no compile time, so padding small
  // rules up to the limit stays within Google's ~6 s compile deadline (20 comparisons per pad did
  // not once the rules were about half the limit, OE8Fm slice 11).
  const filler = 'z'.repeat(400);
  let pad = '\n';
  for (let k = 0; k < n; k++) {
    pad += `  function zzSizePad${String(k).padStart(5, '0')}(x) { return x == '${String(k).padStart(5, '0')}${filler}'; }\n`;
  }
  return src.slice(0, j) + pad + src.slice(j);
}

/** Google also refuses a ruleset whose source files total this many bytes or more. */
export const RULES_SOURCE_LIMIT = 262144;
/**
 * A lower bound for what one pad function adds to the compiled size: its filler string literal is
 * kept as is (400 characters), so a pad costs at least this many bytes.
 */
export const PAD_MIN_COMPILED = 400;

/** True for Google's 400 on a ruleset whose source is too big ("Total size of sources must be smaller than 262144"). */
export function isSourcesTooBig(text) {
  return /total size of sources must be smaller than \d+/i.test(String(text ?? ''));
}

/** Thrown by an upload that Google refused for the source size (not the compiled size). */
export class SourcesTooBigError extends Error {
  constructor(message = 'rules size probe: sources too big') {
    super(message);
    this.name = 'SourcesTooBigError';
  }
}

/**
 * The rules without comments, indentation and blank lines. Compiled size ignores them, so the
 * probe uploads this form: the rules then leave room under the source limit for the padding.
 */
export function compactRules(src) {
  return stripRulesComments(src)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Source bytes one pad function adds. */
function padBytes(source) {
  return padRules(source, 1).length - source.length;
}

/**
 * The compiled size of `source`. `tryRelease(source)` uploads the ruleset and tries a throwaway
 * release, cleans up, and returns the compiled size when Google refused it for size, or null
 * when the release fit (it may throw SourcesTooBigError when the source alone is too big).
 * The source is compacted first. Unpadded; when it fits, pad with n functions (doubling from 40,
 * never past Google's source limit) until refused, then once more with 20 pads fewer or more to
 * learn the exact cost per pad function.
 * When the padding cannot get past the compiled limit within the source limit, the rules do
 * fit: the result then has no exact size, only `atMost`, an upper bound from the pads that fit.
 * @returns {Promise<{size: number, exact: true} | {size: null, exact: false, atMost: number, pads: number}>}
 */
export async function measureCompiledSize(source, tryRelease, { maxPad = 1280 } = {}) {
  const base = compactRules(source);
  const direct = await tryRelease(base);
  if (direct != null) return { size: direct, exact: true };
  const per = padBytes(base);
  // Leave 20 pads for the second try and a little for the pad block's own newline.
  const nMax = Math.min(maxPad, Math.floor((RULES_SOURCE_LIMIT - 1 - base.length) / per) - 20);
  const unmeasured = (pads) => ({
    size: null,
    exact: false,
    atMost: RULES_COMPILED_LIMIT - pads * PAD_MIN_COMPILED,
    pads,
  });
  const attempt = async (n) => {
    try {
      return { m: await tryRelease(padRules(base, n)) };
    } catch (e) {
      if (e instanceof SourcesTooBigError) return { tooBig: true };
      throw e;
    }
  };
  let n = Math.min(40, nMax);
  let m1 = null;
  let fitted = 0;
  while (n >= 1) {
    const r = await attempt(n);
    if (r.tooBig) return unmeasured(fitted);
    if (r.m != null) {
      m1 = r.m;
      break;
    }
    fitted = n;
    if (n >= nMax) return unmeasured(fitted);
    n = Math.min(n * 2, nMax);
  }
  if (m1 == null) return unmeasured(fitted);
  const r2 = await attempt(n + 20);
  if (r2.tooBig || r2.m == null)
    throw new Error('rules size probe: a bigger pad fit where a smaller one did not');
  const perPad = (r2.m - m1) / 20;
  return { size: Math.round(m1 - n * perPad), exact: true };
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

/**
 * One-line verdict for the deploy log, for a measurement from measureCompiledSize or a plain size.
 * An unmeasured result is a pass: the padding never reached the limit within Google's source limit.
 */
export function rulesSizeVerdict(size, limit = RULES_COMPILED_LIMIT) {
  if (size != null && typeof size === 'object') {
    return size.exact
      ? rulesSizeVerdict(size.size, limit)
      : `rules fit: compiled size is at most ${size.atMost} of ${limit} bytes (${size.pads} pad functions still fit; the probe reached Google's source limit of ${RULES_SOURCE_LIMIT} bytes before the compiled limit, so the exact size is not measured)`;
  }
  return size >= limit
    ? `rules too big: ${size} of ${limit} bytes (Google refuses the release; see docs/DEPLOY.md "Rules size and compile time")`
    : `rules compiled size: ${size} of ${limit} bytes (${Math.round((100 * (limit - size)) / limit)}% headroom)`;
}

/**
 * What a deploy or the CLI does with a measurement: `pass` false means stop (Google would refuse
 * the release), `size` is the exact compiled size or null when only a bound is known.
 */
export function rulesSizeOutcome(m, limit = RULES_COMPILED_LIMIT) {
  const size = m.exact ? m.size : null;
  return {
    pass: m.exact ? m.size < limit : true,
    size,
    message: rulesSizeVerdict(m, limit),
  };
}
