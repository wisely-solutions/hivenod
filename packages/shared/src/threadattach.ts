/**
 * Thread attachments (item OE8FmrTaIxFVGcaeGG3N, slice 4; design 5 "Images" and 6.4): the
 * thread's home agent attaches files to the thread with `thread_attach` (screenshots, drafts,
 * reports), the same kinds and the same 900 KB inline limit as item attachments. Files are kept
 * inline in Firestore (no file storage), one immutable document each:
 *
 *   workspaces/{wid}/inboxAttachments/{threadId}_{id}
 *
 * The id starts with the thread's id, so a summary's image visual can only name an attachment
 * of its own thread (the rules check the prefix; the tool checks that it exists and is an image;
 * the page shows only images of this thread). Images are PNG, JPEG or WebP data URLs, never SVG
 * or HTML; links are https only.
 */
import { z } from 'zod';
import {
  ActionError,
  nid,
  requireAgent,
  SERVER_TIME,
  type ActionContext,
  type ActionPlan,
} from './actions';
import { inboxPaths, inboxPlan, type ThreadStateOf } from './inbox';
import { attachmentKind, MAX_ATTACHMENT_BYTES, timestamp, type AttachmentKind } from './schema';

/** An image a thread may hold: a PNG, JPEG or WebP data URL (never SVG). */
export const THREAD_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
/** The part after `{threadId}_`. */
export const ATTACHMENT_SUFFIX_RE = /^[A-Za-z0-9]{1,40}$/;
/** An https link (thread attachments link only to https). */
const HTTPS_RE = /^https:\/\/\S+$/;

export const threadAttachmentPath = (w: string, aid: string) =>
  `workspaces/${w}/inboxAttachments/${aid}`;
/** The attachment's id: the thread's id, `_`, its own id. */
export const threadAttachmentId = (threadId: string, id: string) => `${threadId}_${id}`;
/** Whether `aid` names an attachment of thread `threadId`. */
export function isThreadAttachmentOf(aid: string, threadId: string): boolean {
  return (
    aid.startsWith(`${threadId}_`) && ATTACHMENT_SUFFIX_RE.test(aid.slice(threadId.length + 1))
  );
}

export const inboxAttachmentSchema = z.object({
  memberUid: z.string(),
  threadId: z.string(),
  kind: attachmentKind,
  name: z.string().min(1).max(200),
  content: z.string().max(MAX_ATTACHMENT_BYTES).nullable(),
  url: z.string().max(2048).nullable(),
  bytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  /** The agent that attached it (the thread's home agent). */
  by: z.string(),
  at: timestamp,
  lastEventId: z.string(),
});
export type InboxAttachment = z.infer<typeof inboxAttachmentSchema>;

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export interface ThreadAttachInput {
  threadId: string;
  thread: ThreadStateOf;
  /** Its own id (after `{threadId}_`); a new one when absent. */
  id?: string;
  kind: AttachmentKind;
  name: string;
  /** Inline content (images: a data URL); absent for a link. */
  content?: string | null;
  /** A link's https URL. */
  url?: string | null;
}

/**
 * The home agent attaches a file or a link to the thread (thread_attach). One batch: the
 * attachment and one `thread.attached` event. The thread itself is not touched.
 */
export function threadAttach(
  ctx: ActionContext,
  input: ThreadAttachInput,
): ActionPlan & { attachmentId: string } {
  requireAgent(ctx);
  const t = input.thread;
  if (t.fetchedBy !== ctx.actor.id)
    throw new ActionError(
      "Only the thread's home agent (the one that brought it in) attaches files to it.",
    );
  const own = input.id ?? nid(ctx);
  if (!ATTACHMENT_SUFFIX_RE.test(own)) throw new ActionError('id: 1 to 40 letters or digits');
  const attachmentId = threadAttachmentId(input.threadId, own);
  const name = (input.name ?? '').trim();
  if (!name || name.length > 200) throw new ActionError('name: 1 to 200 characters');
  if (!(attachmentKind.options as readonly string[]).includes(input.kind))
    throw new ActionError(`kind: one of ${attachmentKind.options.join(', ')}`);
  const isLink = input.kind === 'link';
  let content: string | null = null;
  let url: string | null = null;
  if (isLink) {
    url = (input.url ?? '').trim();
    if (!HTTPS_RE.test(url) || url.length > 2048)
      throw new ActionError('A link needs an https URL');
  } else {
    if (typeof input.content !== 'string') throw new ActionError('Attachment content missing');
    content = input.content;
    if (input.kind === 'image' && !THREAD_IMAGE_RE.test(content))
      throw new ActionError('An image is a PNG, JPEG or WebP file.');
  }
  const bytes = content === null ? 0 : utf8Bytes(content);
  if (bytes > MAX_ATTACHMENT_BYTES)
    throw new ActionError('Attachments over 900 KB must be attached as a link');
  const p = inboxPlan(
    ctx,
    'thread.attached',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { attachmentId, name, kind: input.kind },
    (eventId) => [
      {
        kind: 'set',
        path: threadAttachmentPath(ctx.workspaceId, attachmentId),
        data: {
          memberUid: t.memberUid,
          threadId: input.threadId,
          kind: input.kind,
          name,
          content,
          url,
          bytes,
          by: ctx.actor.id,
          at: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
  return { ...p, attachmentId };
}
