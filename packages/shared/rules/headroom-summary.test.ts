/**
 * Thread summaries (item OE8FmrTaIxFVGcaeGG3N): the expression budget of the three documents a
 * summary batch writes (the summary, its version copy, the thread's mirror), with the heaviest
 * summary the limits allow. Measured like headroom.test.ts: hrPad() (k units of about 5
 * expressions) goes in front of one statement, and a binary search finds the largest k with
 * which the write still succeeds.
 */
import { describe, expect, it } from 'vitest';
import { addInboxMessage, inboxPaths } from '../src/inbox';
import { writeSummary } from '../src/summary';
import { AGENTS, as, ok, reset, RULES, setRules, snap, useEmulator } from './harness';

useEmulator();

const MIN_UNITS = 20;
const BUDGET = /maximum of 1000 expressions/;
const TOP = 'match /databases/{database}/documents {';

function pad(k: number) {
  const chunks: string[] = [];
  for (let i = 0; i < k; i += 10)
    chunks.push(Array.from({ length: Math.min(10, k - i) }, () => '1 == 1').join(' && '));
  const fns = chunks.map((c, i) => `    function hrPad${i}() { return ${c}; }`).join('\n');
  const call = chunks.length ? chunks.map((_, i) => `hrPad${i}()`).join(' && ') : 'true';
  return `${fns}\n    function hrPad() { return ${call}; }`;
}

const STATEMENTS = {
  summary: 'allow create: if isActiveAgent(wid) && inboxSummaryOk(',
  version: 'allow create: if isActiveAgent(wid) && inboxSummaryVersionOk(',
  mirror: '&& inboxSummaryMirrored(wid, tid, request.resource.data, resource.data))',
} as const;
function instrument(k: number, at: keyof typeof STATEMENTS) {
  const s = STATEMENTS[at];
  if (!RULES.includes(s)) throw new Error(`statement ${at} not found`);
  const padded = s.startsWith('allow create: if ')
    ? s.replace('allow create: if ', 'allow create: if hrPad() && ')
    : `&& hrPad() ${s}`;
  return RULES.replace(TOP, `${TOP}\n${pad(k)}`).replace(s, padded);
}

const X = Array.from({ length: 24 }, (_, i) => `day ${i}`);
const BIG = {
  headline: 'h'.repeat(120),
  ask: 'a'.repeat(200),
  answer: 'b'.repeat(160),
  recommendation: { action: 'c'.repeat(40), why: 'd'.repeat(200) },
  confidence: 'medium',
  bullets: Array.from({ length: 5 }, (_, i) => ({
    text: `${i}`.repeat(160),
    refs: [0, 1, 2].map((j) => ({
      kind: 'link',
      id: `r${j}`,
      label: 'l',
      url: 'https://example.com/x',
    })),
  })),
  details: 'x'.repeat(6000),
  visuals: Array.from({ length: 4 }, (_, v) => ({
    kind: 'stacked_bar',
    title: 't'.repeat(80),
    caption: 'c'.repeat(200),
    unit: 'min',
    highlight: 23,
    better: 'down',
    x: X,
    series: [0, 1, 2, 3].map((j) => ({ name: `s${j}`, values: X.map((_, i) => i * j + v) })),
  })),
  noVisualWhy: 'w'.repeat(140),
  refs: Array.from({ length: 30 }, (_, i) => ({ kind: 'event', id: `e${i}`, label: 'E' })),
};

async function prepare() {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: 'im1',
        ref: 'r1',
        memberUid: 'alice',
        source: 'teams',
        sender: { name: 'Sam', handle: null },
        text: 'Hello',
        threadRef: 't1',
        messageId: 'm1',
        receivedAt: new Date(),
      }),
    ),
  );
  const thread = (await snap(inboxPaths.thread('w1', 'itr1'))) as never;
  const p = writeSummary(a.ctx, {
    threadId: 'itr1',
    thread,
    current: null,
    baseVersion: 0,
    summary: BIG,
    basis: { lastEventId: 'x'.repeat(128), planCursor: 7 },
  });
  return () => a.run(p);
}

async function headroom(at: keyof typeof STATEMENTS, hi = 200) {
  const tryWith = async (k: number) => {
    await reset();
    await setRules(RULES);
    const write = await prepare();
    await setRules(instrument(k, at));
    try {
      await write();
      return true;
    } catch (e) {
      const msg = String((e as Error).message);
      if (!BUDGET.test(msg))
        throw new Error(`Denied for another reason (k=${k}): ${msg}`, { cause: e });
      return false;
    }
  };
  try {
    if (!(await tryWith(0))) return 0;
    let lo = 0;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (await tryWith(mid)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  } finally {
    await setRules(RULES);
  }
}

describe('summary batch: expression headroom with the heaviest summary', () => {
  for (const at of Object.keys(STATEMENTS) as (keyof typeof STATEMENTS)[])
    it(`${at}: at least ${MIN_UNITS} pad units to spare`, { timeout: 120_000 }, async () => {
      expect(await headroom(at)).toBeGreaterThanOrEqual(MIN_UNITS);
    });
});
