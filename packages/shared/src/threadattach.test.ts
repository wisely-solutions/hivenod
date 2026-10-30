/**
 * Thread attachments (item OE8FmrTaIxFVGcaeGG3N, slice 4): thread_attach's batch, ids that name
 * their thread, images only PNG/JPEG/WebP, https links, the 900 KB limit, home agent only.
 */
import { describe, expect, it } from 'vitest';
import { ActionError, SERVER_TIME, type ActionContext } from './actions';
import type { ThreadStateOf } from './inbox';
import {
  inboxAttachmentSchema,
  isThreadAttachmentOf,
  threadAttach,
  THREAD_IMAGE_RE,
} from './threadattach';

const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Hive' },
  newId: () => 'n1',
};
const other: ActionContext = { ...agent, actor: { type: 'agent', id: 'agentB', name: 'Bee' } };
const joao: ActionContext = { ...agent, actor: { type: 'human', id: 'joao', name: 'João' } };
const TH: ThreadStateOf = {
  memberUid: 'joao',
  subjectId: 's1',
  state: 'yourCall',
  fetchedBy: 'agentA',
  refs: ['r1'],
};
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof ActionError) return e.message;
    throw e;
  }
  return null;
};

describe('threadAttach', () => {
  it('writes the attachment under {threadId}_{id} and one event', () => {
    const p = threadAttach(agent, {
      threadId: 't1',
      thread: TH,
      id: 'shot1',
      kind: 'image',
      name: ' before.png ',
      content: PNG,
    });
    expect(p.attachmentId).toBe('t1_shot1');
    expect(p.ops.map((o) => [o.kind, o.path])).toEqual([
      ['set', 'workspaces/w1/inboxAttachments/t1_shot1'],
      ['set', 'workspaces/w1/inboxEvents/n1'],
    ]);
    expect(p.ops[0]!.data).toEqual({
      memberUid: 'joao',
      threadId: 't1',
      kind: 'image',
      name: 'before.png',
      content: PNG,
      url: null,
      bytes: PNG.length,
      by: 'agentA',
      at: SERVER_TIME,
      lastEventId: 'n1',
    });
    expect(p.ops[1]!.data).toMatchObject({
      type: 'thread.attached',
      threadId: 't1',
      memberUid: 'joao',
      data: { attachmentId: 't1_shot1', name: 'before.png', kind: 'image' },
    });
    expect(inboxAttachmentSchema.omit({ at: true }).parse(p.ops[0]!.data)).toBeTruthy();
    // A new id when none is given.
    expect(
      threadAttach(agent, { threadId: 't1', thread: TH, kind: 'text', name: 'n', content: 'x' })
        .attachmentId,
    ).toBe('t1_n1');
  });

  it('takes links (https only)', () => {
    const p = threadAttach(agent, {
      threadId: 't1',
      thread: TH,
      kind: 'link',
      name: 'PR',
      url: 'https://github.com/x/y/pull/1',
    });
    expect(p.ops[0]!.data).toMatchObject({
      content: null,
      url: 'https://github.com/x/y/pull/1',
      bytes: 0,
    });
    expect(
      err(() =>
        threadAttach(agent, {
          threadId: 't1',
          thread: TH,
          kind: 'link',
          name: 'x',
          url: 'http://a.b',
        }),
      ),
    ).toBe('A link needs an https URL');
  });

  it.each([
    ['data:image/svg+xml;base64,PHN2Zz4=', 'An image is a PNG, JPEG or WebP file.'],
    ['data:text/html;base64,PGI+', 'An image is a PNG, JPEG or WebP file.'],
    ['https://example.com/a.png', 'An image is a PNG, JPEG or WebP file.'],
    ['data:image/png;base64,<script>', 'An image is a PNG, JPEG or WebP file.'],
  ])('refuses the image %s', (content, msg) => {
    expect(
      err(() =>
        threadAttach(agent, { threadId: 't1', thread: TH, kind: 'image', name: 'x', content }),
      ),
    ).toBe(msg);
  });

  it('refuses another agent, a person, too big, a bad id or name', () => {
    const base = { threadId: 't1', thread: TH, kind: 'text' as const, name: 'n', content: 'x' };
    expect(err(() => threadAttach(other, base))).toBe(
      "Only the thread's home agent (the one that brought it in) attaches files to it.",
    );
    expect(err(() => threadAttach(joao, base))).toBe('Only agents can do this');
    expect(err(() => threadAttach(agent, { ...base, content: 'x'.repeat(900 * 1024 + 1) }))).toBe(
      'Attachments over 900 KB must be attached as a link',
    );
    expect(err(() => threadAttach(agent, { ...base, id: 'a_b' }))).toBe(
      'id: 1 to 40 letters or digits',
    );
    expect(err(() => threadAttach(agent, { ...base, name: '  ' }))).toBe(
      'name: 1 to 200 characters',
    );
    expect(err(() => threadAttach(agent, { ...base, content: undefined }))).toBe(
      'Attachment content missing',
    );
  });

  it('ids name their thread', () => {
    expect(isThreadAttachmentOf('t1_abc', 't1')).toBe(true);
    expect(isThreadAttachmentOf('t12_abc', 't1')).toBe(false);
    expect(isThreadAttachmentOf('t1_a_b', 't1')).toBe(false);
    expect(isThreadAttachmentOf('t1_', 't1')).toBe(false);
    expect(THREAD_IMAGE_RE.test('data:image/webp;base64,UklGRg==')).toBe(true);
    expect(THREAD_IMAGE_RE.test('data:image/jpeg;base64,/9j/4AAQ')).toBe(true);
  });
});
