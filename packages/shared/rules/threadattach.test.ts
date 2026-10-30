/**
 * Thread attachments and image visuals (item OE8FmrTaIxFVGcaeGG3N, slice 4): only the thread's
 * home agent attaches, under {threadId}_{id}, with one thread.attached event; images are PNG,
 * JPEG or WebP data URLs, links https; immutable; the member reads them, other members don't.
 * A summary's image visuals name attachments of the same thread, never a URL or another
 * thread's attachment.
 */
import { doc, getDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import type { WriteOp } from '../src/actions';
import { addInboxMessage, inboxPaths } from '../src/inbox';
import { summaryPaths, writeSummary } from '../src/summary';
import { threadAttach, threadAttachmentPath, type ThreadAttachInput } from '../src/threadattach';
import { AGENTS, as, denied, ok, snap, useEmulator, W, type As } from './harness';

useEmulator();

const TID = 'itr1';
const T = inboxPaths.thread(W, TID);
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function brought(ref = 'r1', mid = 'im1') {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: mid,
        ref,
        memberUid: 'alice',
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Can you change the board card?',
        threadRef: `thread-${ref}`,
        messageId: `m-${ref}`,
        receivedAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ),
  );
  return a;
}

let n = 0;
async function attach(who: As, over: Partial<ThreadAttachInput> = {}, tid = TID) {
  const t = (await snap(inboxPaths.thread(W, tid))) as unknown as ThreadAttachInput['thread'];
  const ctx = { ...who.ctx, newId: () => `aev${++n}` };
  return threadAttach(ctx, {
    threadId: tid,
    thread: { ...t, fetchedBy: who.ctx.actor.id },
    id: `img${n}`,
    kind: 'image',
    name: 'before.png',
    content: PNG,
    ...over,
  });
}
const forge = (ops: WriteOp[], over: Record<string, unknown>, path?: string) =>
  ops.map((op) =>
    op.path.includes('/inboxAttachments/')
      ? { ...op, path: path ?? op.path, data: { ...op.data, ...over } }
      : op,
  );

describe('thread attachments', () => {
  it('the home agent attaches; the member reads; others do not', async () => {
    const a = await brought();
    const p = await attach(a);
    await ok(a.run(p));
    const path = threadAttachmentPath(W, p.attachmentId);
    expect(await snap(path)).toMatchObject({ threadId: TID, memberUid: 'alice', kind: 'image' });
    await ok(getDoc(doc(as('alice').db, path)));
    await denied(getDoc(doc(as('bob').db, path)));
    // Immutable.
    await denied(updateDoc(doc(a.db, path), { name: 'other.png' }));
    await denied(deleteDoc(doc(a.db, path)));
    await denied(deleteDoc(doc(as('alice').db, path)));
  });

  it('not another agent, not the member, not without its event', async () => {
    await brought();
    const b = as(AGENTS.star);
    await denied(b.run(await attach(b)));
    const alice = as('alice');
    const p = await attach(as(AGENTS.a));
    await denied(alice.run(p));
    await denied(as(AGENTS.a).run(p.ops.filter((o) => !o.path.includes('/inboxEvents/'))));
  });

  it('images only PNG, JPEG or WebP; links https; ids name the thread', async () => {
    const a = await brought();
    await brought('r2', 'im2');
    const other = 'itr2';
    const p = await attach(a);
    for (const over of [
      { content: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { content: 'data:text/html;base64,PGI+' },
      { content: 'data:image/png;base64,<script>' },
      { kind: 'svg' },
      { kind: 'link', content: null, url: 'http://example.com' },
      { kind: 'link', content: null, url: 'javascript:alert(1)' },
      { kind: 'html', content: '<b>x</b>', url: 'https://example.com' },
      { by: AGENTS.star },
      { name: '' },
      { extra: 1 },
    ])
      await denied(a.run(forge(p.ops, over)));
    // For another member (the event too).
    await denied(
      a.run(
        forge(p.ops, { memberUid: 'bob' }).map((o) =>
          o.path.includes('/inboxEvents/') ? { ...o, data: { ...o.data, memberUid: 'bob' } } : o,
        ),
      ),
    );
    // Under another thread's id, or with no thread prefix.
    await denied(a.run(forge(p.ops, {}, threadAttachmentPath(W, `${other}_x1`))));
    await denied(a.run(forge(p.ops, {}, threadAttachmentPath(W, 'x1'))));
    await denied(a.run(forge(p.ops, {}, threadAttachmentPath(W, `${TID}_a_b`))));
    await ok(a.run(p));
    await ok(
      a.run(await attach(a, { kind: 'link', content: null, url: 'https://example.com/pr/1' })),
    );
    await ok(a.run(await attach(a, { kind: 'html', content: '<h1>Draft</h1>', name: 'd.html' })));
    await ok(a.run(await attach(a, { content: 'data:image/webp;base64,UklGRg==' })));
  });
});

describe('image visuals in summaries', () => {
  const pair = (before: string, after: string) => ({
    kind: 'image_pair',
    title: 'Board card',
    caption: 'The card shows the summary line',
    before,
    after,
  });
  async function summary(a: As, visuals: unknown[], atts: Record<string, string>) {
    const t = (await snap(T)) as unknown as Parameters<typeof writeSummary>[1]['thread'];
    return writeSummary(
      { ...a.ctx, newId: () => `sev${++n}` },
      {
        threadId: TID,
        thread: t,
        current: null,
        baseVersion: 0,
        summary: { headline: 'Ship the card?', ask: 'Ship it?', bullets: ['Green'], visuals },
        basis: { lastEventId: null, planCursor: null },
        attachments: atts,
      },
    );
  }
  const withVisual = (ops: WriteOp[], v: Record<string, unknown>) =>
    ops.map((o) =>
      o.path.includes('/inboxSummar') ? { ...o, data: { ...o.data, visuals: [v] } } : o,
    );

  it('an image pair of this thread passes; a URL or another thread is refused', async () => {
    const a = await brought();
    const b4 = await attach(a);
    await ok(a.run(b4));
    const af = await attach(a, { name: 'after.png' });
    await ok(a.run(af));
    const p = await summary(a, [pair(b4.attachmentId, af.attachmentId)], {
      [b4.attachmentId]: 'image',
      [af.attachmentId]: 'image',
    });
    for (const v of [
      pair(b4.attachmentId, 'https://example.com/a.png'),
      pair('itr2_x1', af.attachmentId),
      { kind: 'image', title: 'Shot', caption: 'New', attachment: 'itr2_x1' },
      { kind: 'image', title: 'Shot', caption: 'New', attachment: 'data:image/png;base64,AA==' },
      { kind: 'image', title: 'Shot', caption: '<b>New</b>', attachment: b4.attachmentId },
    ])
      await denied(a.run(withVisual(p.ops, v)));
    await ok(a.run(p));
    expect((await snap(summaryPaths.summary(W, TID))).visuals).toEqual([
      { ...pair(b4.attachmentId, af.attachmentId), labels: null },
    ]);
  });
});
