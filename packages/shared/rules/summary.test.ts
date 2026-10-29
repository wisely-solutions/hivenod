/**
 * Thread summaries (item OE8FmrTaIxFVGcaeGG3N): only the thread's home agent writes the summary,
 * version by version, with its version doc, the thread's mirror and one summary.written event;
 * shapes, counts and the visual rule at person steps are checked; members read, never write; 20
 * versions are kept.
 */
import { doc, getDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import type { WriteOp } from '../src/actions';
import { addInboxMessage, inboxPaths } from '../src/inbox';
import { summaryPaths, writeSummary, type WriteSummaryInput } from '../src/summary';
import { AGENTS, as, denied, ok, put, snap, useEmulator, W, type As } from './harness';

useEmulator();

const TID = 'itr1';
const T = inboxPaths.thread(W, TID);
const S = summaryPaths.summary(W, TID);

async function brought() {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: 'im1',
        ref: 'r1',
        memberUid: 'alice',
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Can we move the review to Thursday?',
        threadRef: 'thread-1',
        messageId: 'm-1',
        receivedAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ),
  );
  return a;
}

const bar = (over: Record<string, unknown> = {}) => ({
  kind: 'bar',
  title: 'Check time',
  caption: 'Down to 10 minutes',
  x: ['r173', 'r174', 'r175'],
  series: [{ name: 'minutes', values: [14, 12, 10] }],
  highlight: 2,
  ...over,
});
const CONTENT = {
  headline: 'Move the review to Thursday?',
  ask: 'Accept Thursday 10:00?',
  answer: 'You are free Thursday morning',
  recommendation: { action: 'Approve', why: 'Free slot, nothing moves' },
  confidence: 'high',
  bullets: [
    'Sam asked to move it',
    { text: 'Thursday 10:00 is free', refs: [{ kind: 'message', id: 'im1', label: 'message' }] },
  ],
  details: '## Context\nNothing else.',
  visuals: [
    bar(),
    {
      kind: 'flow',
      title: 'Plan',
      caption: 'Reply, then book',
      nodes: [
        { id: 'a', label: 'Reply', who: 'agent', state: 'next' },
        { id: 'b', label: 'Approve', who: 'person', state: 'now' },
      ],
    },
    {
      kind: 'before_after',
      title: 'Date',
      caption: 'Tuesday becomes Thursday',
      before: { lines: ['Tue 10:00'] },
      after: { lines: ['Thu 10:00'] },
    },
    {
      kind: 'timeline',
      title: 'When',
      caption: 'Two days',
      events: [
        { at: '2026-10-28', label: 'Asked' },
        { at: '2026-10-30T10:00Z', label: 'Review', state: 'next' },
      ],
    },
  ],
  refs: [{ kind: 'link', id: 'cal', label: 'Calendar', url: 'https://example.com/cal' }],
};

async function current(): Promise<{ version: number } | null> {
  const s = await snap(S);
  return typeof s.version === 'number' ? { version: s.version } : null;
}
let n = 0;
async function write(who: As, over: Partial<WriteSummaryInput> = {}) {
  const t = (await snap(T)) as unknown as WriteSummaryInput['thread'];
  const cur = await current();
  const ctx = { ...who.ctx, newId: () => `sev${++n}` };
  return writeSummary(ctx, {
    threadId: TID,
    thread: { ...t, fetchedBy: who.ctx.actor.id },
    current: cur,
    baseVersion: cur?.version ?? 0,
    summary: CONTENT,
    basis: { lastEventId: 'x', planCursor: null },
    ...over,
  });
}
const forge = (ops: WriteOp[], path: string, over: Record<string, unknown>) =>
  ops.map((op) => (op.path === path ? { ...op, data: { ...op.data, ...over } } : op));
const forgeSummary = (ops: WriteOp[], over: Record<string, unknown>) =>
  forge(forge(ops, S, over), summaryPaths.version(W, TID, ops[0]!.data!.version as number), over);
const without = (ops: WriteOp[], part: string) => ops.filter((o) => !o.path.includes(part));

describe('summaries: the home agent writes', () => {
  it('v1 then v2: summary, version doc, mirror; the member reads them', async () => {
    const a = await brought();
    await ok(a.run(await write(a)));
    await ok(a.run(await write(a, { summary: { ...CONTENT, headline: 'Thursday it is' } })));
    expect(await snap(S)).toMatchObject({ version: 2, headline: 'Thursday it is', by: AGENTS.a });
    expect(await snap(summaryPaths.version(W, TID, 1))).toMatchObject({ version: 1 });
    expect((await snap(T))!.summary).toMatchObject({
      version: 2,
      headline: 'Thursday it is',
      recAction: 'Approve',
    });
    const alice = as('alice');
    await ok(getDoc(doc(alice.db, S)));
    await ok(getDoc(doc(alice.db, summaryPaths.version(W, TID, 1))));
    await denied(getDoc(doc(as('bob').db, S)));
  });

  it('not another agent, not the member, not a revoked agent', async () => {
    await brought();
    const b = as(AGENTS.star);
    await denied(b.run(await write(b)));
    const alice = as('alice');
    const p = await write(as(AGENTS.a));
    await denied(
      alice.run({
        ...p,
        ops: p.ops.map((o) =>
          o.path.includes('/inboxEvents/')
            ? { ...o, data: { ...o.data, actor: { type: 'human', id: 'alice', name: 'Alice' } } }
            : o,
        ),
      }),
    );
    await denied(alice.run(p));
    const r = as(AGENTS.revoked);
    await denied(r.run(await write(r)));
  });

  it('versions go one by one; the same batch writes all three', async () => {
    const a = await brought();
    const p = await write(a);
    await denied(a.run(forgeSummary(p.ops, { version: 2 })));
    await denied(a.run(without(p.ops, '/inboxSummaryVersions/')));
    await denied(a.run(without(p.ops, '/inboxThreads/')));
    await denied(a.run(without(p.ops, '/inboxSummaries/')));
    await ok(a.run(p));
    // The same version again (a lost update) is refused.
    await denied(a.run(p.ops));
    // A whole batch that skips a version (v3 after v1) is refused.
    await denied(a.run(await write(a, { current: { version: 2 }, baseVersion: 2 })));
    await ok(a.run(await write(a)));
  });

  it('the mirror equals the summary', async () => {
    const a = await brought();
    const p = await write(a);
    const m = p.ops.find((o) => o.path === T)!.data!.summary as Record<string, unknown>;
    for (const over of [
      { headline: 'Other' },
      { ask: null },
      { recAction: 'Reject' },
      { version: 2 },
      { confidence: 'low' },
    ])
      await denied(a.run(forge(p.ops, T, { summary: { ...m, ...over } })));
    // A version doc whose top fields differ from the summary.
    for (const over of [
      { headline: 'Other' },
      { ask: 'Other?' },
      { recommendation: null },
      { details: null },
    ])
      await denied(a.run(forge(p.ops, summaryPaths.version(W, TID, 1), over)));
    // The version doc under another id, alone or as an extra copy.
    const v = p.ops.find((o) => o.path.includes('/inboxSummaryVersions/'))!;
    await denied(
      a.run(p.ops.map((o) => (o === v ? { ...o, path: summaryPaths.version(W, TID, 7) } : o))),
    );
    await denied(a.run([{ ...v, path: summaryPaths.version(W, TID, 7) }, ...p.ops]));
    await ok(a.run(p));
  });

  // The rules check shapes at the level one document's expression budget allows (kinds, counts,
  // plain titles and captions); per-label texts and values per point are checkSummary's.
  it('shapes: bullets, visuals, sizes, kinds, plain titles', async () => {
    const a = await brought();
    const p = await write(a);
    const v0 = (p.ops[0]!.data!.visuals as Record<string, unknown>[])[0]!;
    const flow = (p.ops[0]!.data!.visuals as Record<string, unknown>[])[1]!;
    const bullets = p.ops[0]!.data!.bullets as unknown[];
    const bad: Record<string, unknown>[] = [
      { bullets: [...bullets, ...bullets, ...bullets] },
      { bullets: [] },
      { bullets: [{ text: 'x'.repeat(161), refs: [] }] },
      { visuals: [v0, v0, v0, v0, v0] },
      { visuals: [{ ...v0, kind: 'pie' }] },
      { visuals: [{ ...v0, kind: 'image', attachment: 'a1' }] },
      { visuals: [{ ...v0, x: Array.from({ length: 25 }, (_, i) => `d${i}`) }] },
      { visuals: [{ kind: 'image', title: 'T', caption: 'C', events: [{}, {}] }] },
      {
        visuals: [
          { ...v0, series: Array.from({ length: 5 }, () => ({ name: 'm', values: [1, 2, 3] })) },
        ],
      },
      { visuals: [{ ...v0, title: '<b>x</b>' }] },
      { visuals: [{ ...v0, caption: 'line\n<script>x</script>' }] },
      { visuals: [{ ...flow, nodes: [{ id: 'a', label: 'A', who: null, state: null }] }] },
      { visuals: [{ ...v0, kind: 'flow' }] },
      { visuals: [{ ...v0, kind: 'stacked_bar' }] },
      {
        visuals: [
          {
            ...flow,
            nodes: Array.from({ length: 9 }, (_, i) => ({
              id: `n${i}`,
              label: 'N',
              who: null,
              state: null,
            })),
          },
        ],
      },
      { visuals: [], noVisualWhy: null },
      { headline: '' },
      { confidence: 'sure' },
      {
        refs: Array.from({ length: 31 }, () => ({ kind: 'event', id: 'e', label: 'E', url: null })),
      },
      { extra: true },
      { by: AGENTS.star },
    ];
    for (const over of bad) await denied(a.run(forgeSummary(p.ops, over)));
    // At a person step a reason is enough; without ask nothing is needed.
    await ok(a.run(forgeSummary(p.ops, { visuals: [], noVisualWhy: 'Nothing to chart' })));
    const q = await write(a, { summary: { ...CONTENT, ask: null, visuals: [] } });
    await ok(a.run(q));
  });

  it('keeps 20 versions: the writer deletes the one 20 back, nothing newer', async () => {
    const a = await brought();
    await ok(a.run(await write(a)));
    // Jump to v20 (seeded), then v21 deletes v1.
    const doc = (await snap(S))!;
    const seeded: Record<string, Record<string, unknown>> = {
      [S]: { ...doc, version: 20 },
      [T]: {
        ...(await snap(T))!,
        summary: { ...((await snap(T))!.summary as object), version: 20 },
      },
    };
    await put(seeded);
    const p = await write(a);
    expect(p.version).toBe(21);
    expect(p.ops.some((o) => o.kind === 'delete' && o.path.endsWith('/itr1_1'))).toBe(true);
    // Deleting a newer one is refused.
    await denied(
      a.run(
        p.ops.map((o) =>
          o.kind === 'delete'
            ? { ...o, path: summaryPaths.version(W, TID, 1).replace('_1', '_2') }
            : o,
        ),
      ),
    );
    await put({ [summaryPaths.version(W, TID, 2)]: { ...doc, version: 2 } });
    await denied(
      a.run(
        p.ops.map((o) =>
          o.kind === 'delete' ? { ...o, path: summaryPaths.version(W, TID, 2) } : o,
        ),
      ),
    );
    await ok(a.run(p));
    expect(await snap(summaryPaths.version(W, TID, 1))).toEqual({});
    // Members never delete versions.
    await denied(as('alice').run([{ kind: 'delete', path: summaryPaths.version(W, TID, 21) }]));
  });
});
