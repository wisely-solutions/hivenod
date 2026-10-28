/**
 * Turns `hivenod item attach <file|url>` input into an attachment: type by extension, inlined up to
 * 900 KB (SPEC section 3), links for anything bigger. Nothing is sanitised here; the web viewer
 * sandboxes html. Files are read through safepath.ts: never from Hivenod's own folders.
 */
import { MAX_ATTACHMENT_BYTES, type AttachmentKind } from '@hive/shared';
import { basename, extname } from 'node:path';
import { HiveError } from './errors';
import { openGuarded } from './safepath';

export interface PreparedAttachment {
  kind: AttachmentKind;
  name: string;
  content?: string;
  url?: string;
}

const TYPES: Record<string, { kind: AttachmentKind; mime?: string }> = {
  '.html': { kind: 'html' },
  '.htm': { kind: 'html' },
  '.md': { kind: 'markdown' },
  '.markdown': { kind: 'markdown' },
  '.txt': { kind: 'text' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
};

export const isUrl = (s: string) => /^https?:\/\//i.test(s);

const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

export async function prepareAttachment(
  source: string,
  opts: {
    name?: string;
    /** Folders besides the credentials folder that files must not come from (see safepath.ts). */
    deny?: readonly string[];
  } = {},
): Promise<PreparedAttachment> {
  if (isUrl(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new HiveError(`"${source}" is not a valid URL`);
    }
    const last = url.pathname.split('/').filter(Boolean).pop();
    return { kind: 'link', name: (opts.name ?? last ?? url.hostname).slice(0, 200), url: source };
  }

  const type = TYPES[extname(source).toLowerCase()];
  if (!type) {
    throw new HiveError(
      `Cannot attach "${basename(source)}": use html, md, txt, png, jpg or pdf, or attach a URL instead.`,
    );
  }
  // Never the credentials folder, also not through symlinks or hard links (tester R80).
  const fh = await openGuarded(source, opts.deny);
  let size: number;
  let bytes: Buffer;
  try {
    size = (await fh.stat()).size;
    bytes = size > MAX_ATTACHMENT_BYTES ? Buffer.alloc(0) : await fh.readFile();
  } finally {
    await fh.close();
  }
  const tooBig = (what: string) =>
    new HiveError(
      `${basename(source)} is ${what}, over the ${kb(MAX_ATTACHMENT_BYTES)} limit for inline attachments. Host it somewhere and attach its URL instead: hivenod item attach <itemId> https://…`,
    );
  if (size > MAX_ATTACHMENT_BYTES) throw tooBig(kb(size));

  const name = (opts.name ?? basename(source)).slice(0, 200);
  if (type.mime) {
    // Images and PDFs are stored as data URLs; base64 adds a third, so check what is stored.
    const content = `data:${type.mime};base64,${bytes.toString('base64')}`;
    if (Buffer.byteLength(content) > MAX_ATTACHMENT_BYTES)
      throw tooBig(`${kb(size)} (${kb(Buffer.byteLength(content))} once encoded)`);
    return { kind: type.kind, name, content };
  }
  const content = bytes.toString('utf8');
  if (Buffer.byteLength(content) > MAX_ATTACHMENT_BYTES) throw tooBig(kb(size));
  return { kind: type.kind, name, content };
}
