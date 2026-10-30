// Firestore rules compile time: Google's Rules API compiles a ruleset within a backend deadline
// of about 6 s and answers 503 "The service is currently unavailable" when it runs out, on
// `:test`, `rulesets.create` and the release alike. firebase-tools then retries a 503 that will
// never pass. `probeCompile` times `POST projects/<p>:test` with the source only (it creates
// nothing) and tells our slow rules apart from a Google outage (a tiny ruleset fails too).
// See docs/DEPLOY.md "Rules size and compile time".

/** Google gives up compiling after about this long. */
export const RULES_COMPILE_DEADLINE_MS = 6000;

/** Above this (median of the tries) a release still goes out, with a warning to trim the rules. */
export const RULES_COMPILE_BUDGET_MS = 4500;

/** A ruleset that compiles in well under a second whenever the API is healthy. */
export const TINY_RULES =
  "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /x/{y} { allow read: if false; }\n  }\n}\n";

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const compiled = (r) => r.status === 200;

/**
 * @param {{ours: {status:number, ms:number, errors?:number, message?:string}[], tiny?: typeof ours}} probe
 * @returns {{verdict: 'ok'|'borderline'|'too-slow'|'outage'|'invalid', message: string, ms?: number}}
 */
export function compileVerdict({ ours, tiny = [] }) {
  const bad = ours.find((r) => compiled(r) && (r.errors ?? 0) > 0);
  if (bad) {
    return {
      verdict: 'invalid',
      message: `rules do not compile: ${String(bad.message ?? '').slice(0, 300)}`,
    };
  }
  const good = ours.filter(compiled);
  const deadline = `(Google times out ~${RULES_COMPILE_DEADLINE_MS / 1000} s)`;
  if (good.length === ours.length) {
    const ms = median(good.map((r) => r.ms));
    if (ms > RULES_COMPILE_BUDGET_MS) {
      return {
        verdict: 'borderline',
        ms,
        message: `rules compile in ${ms} ms, over the budget of ${RULES_COMPILE_BUDGET_MS} ms ${deadline}: trim the rules soon`,
      };
    }
    return { verdict: 'ok', ms, message: `rules compile in ${ms} ms ${deadline}` };
  }
  if (good.length > 0) {
    const ms = median(good.map((r) => r.ms));
    return {
      verdict: 'borderline',
      ms,
      message: `rules compile in ${ms} ms, but ${ours.length - good.length} of ${ours.length} tries timed out ${deadline}: trim the rules soon`,
    };
  }
  if (tiny.some(compiled)) {
    const ms = ours[0]?.ms;
    return { verdict: 'too-slow', ms, message: `rules compile too slow: ${ms} ms ${deadline}` };
  }
  return {
    verdict: 'outage',
    message: `Google's rules API is unavailable (a tiny ruleset fails too: ${tiny[0]?.status ?? ours[0]?.status}); try again later`,
  };
}

/**
 * Compile `source` `tries` times with `compile(source)` (one `:test` call, returns
 * {status, ms, errors, message}); when none compiles, compile TINY_RULES once to tell slow rules
 * from an outage. A thrown error (the network) counts as a try that did not compile.
 */
export async function probeCompile({ source, compile, tries = 3 }) {
  const once = async (s) => {
    try {
      return await compile(s);
    } catch (e) {
      return { status: 0, ms: 0, errors: 0, message: String(e?.message ?? e) };
    }
  };
  const ours = [];
  for (let i = 0; i < tries; i++) ours.push(await once(source));
  const tiny = ours.some(compiled) ? [] : [await once(TINY_RULES)];
  return { ...compileVerdict({ ours, tiny }), ours, tiny };
}
