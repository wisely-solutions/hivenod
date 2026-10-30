/**
 * Which CLI version understands which event (item N9EEnCa1MzIw5UYfe70N). A CLI older than an
 * event's row silently ignores that event, so the web app says so instead of looking stuck.
 *
 * `EVENT_MIN_VERSION` is the one table. Its generated copy for the Go CLI is
 * cli/internal/actions/cliversions.json (scripts/cli-versions.test.mjs;
 * UPDATE_GO_CONTRACT=1 pnpm test:scripts rewrites it). Add a row when a new event kind needs a
 * new CLI. Versions are the dotted numbers `hivenod --version` prints.
 */
export const EVENT_MIN_VERSION: Readonly<Record<string, string>> = {
  /** Inbox event: the member asked for changes to a proposed outcome (Ask for changes). */
  revise: '0.2.163',
  /**
   * Inbox plans (item qwFAWxZM5xkcE7PPjAzi): plan_propose, and carry_out sent per step only at
   * its turn. An older CLI sends carry_out for every approved step at once.
   */
  plan: '0.2.171',
  /** Inbox events: a Build it plan step's item is Done, or was stopped (item qwFAWxZM5xkcE7PPjAzi). */
  item_done: '0.2.174',
  item_stopped: '0.2.174',
  /** Inbox event: the member asked the home agent to re-check a thread (item bmNoIvvqKCdAorLSShE9). */
  recheck: '0.2.177',
  /**
   * Presence with a session and host id (item N0biXyXQN4TybBVUo5Lp): a restart on the same machine
   * takes over at once (info code takeover). An older CLI is told another session is live until
   * the old presence expires.
   */
  takeover: '0.2.180',
  /** Inbox event: the member asked the home agent something on a thread (item w6O2KOw4ys70TQv9I1xD). */
  instruct: '0.2.184',
  /**
   * Thread summaries (item OE8FmrTaIxFVGcaeGG3N): thread_summary and the inbox reason summarize.
   * An older CLI never writes a summary: the page says the agent's CLI is too old.
   */
  summary: '0.2.191',
  /**
   * Thread attachments (item OE8FmrTaIxFVGcaeGG3N, slice 4): thread_attach, and thread_summary
   * with image and image_pair visuals. An older CLI cannot attach screenshots.
   */
  attach: '0.2.194',
  /**
   * Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6): plan_propose template, plan_send_back,
   * and carry_out again (why sent_back) after a send back. An older CLI never redoes a step.
   */
  devplan: '0.2.206',
};

/** Dotted numbers compared part by part: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const y = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** Whether `have` is older than `latest` (an unknown version is never "older"). */
export function isOlder(have: string | null | undefined, latest: string | null | undefined) {
  return !!have && !!latest && compareVersions(have, latest) < 0;
}

/** The minimum CLI version for an event kind, or null when every CLI handles it. */
export function minVersionFor(kind: string): string | null {
  return Object.prototype.hasOwnProperty.call(EVENT_MIN_VERSION, kind)
    ? (EVENT_MIN_VERSION[kind] ?? null)
    : null;
}

/**
 * Can an agent on CLI version `have` handle an event of this kind?
 *  - 'ok': yes, or the kind needs no minimum.
 *  - 'old': it reported a version below the minimum.
 *  - 'unknown': it reports no version (a CLI from before reporting existed, which may or may not
 *    be new enough).
 */
export function cliSupports(
  kind: string,
  have: string | null | undefined,
): 'ok' | 'old' | 'unknown' {
  const min = minVersionFor(kind);
  if (!min) return 'ok';
  if (!have) return 'unknown';
  return compareVersions(have, min) >= 0 ? 'ok' : 'old';
}
