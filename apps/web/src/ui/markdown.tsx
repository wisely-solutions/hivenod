import { Fragment, type ReactNode } from 'react';

/**
 * A small, safe Markdown renderer for step instructions: headings, paragraphs, bullet and numbered
 * lists, fenced and inline code, bold, italic and http(s) links. It builds React elements (never
 * HTML strings), so nothing in the text can inject markup.
 */
export type Block =
  | { t: 'h'; level: 1 | 2 | 3; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'code'; text: string };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ t: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ t: 'h', level: h[1]!.length as 1 | 2 | 3, text: h[2]! });
      continue;
    }
    const li = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const kind = li[1] ? 'ul' : 'ol';
      const last = out[out.length - 1];
      if (last && last.t === kind) last.items.push(li[3]!);
      else out.push({ t: kind, items: [li[3]!] });
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line.trim());
  }
  flush();
  return out;
}

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

export function safeUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (!part) return null;
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`'))
      return (
        <code key={i} className="rounded-[4px] bg-canvas px-1 font-mono text-[0.9em]">
          {part.slice(1, -1)}
        </code>
      );
    if (part.startsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const href = safeUrl(link[2]!);
      return href ? (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          {link[1]}
        </a>
      ) : (
        <Fragment key={i}>{link[1]}</Fragment>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) return <p className="text-14 text-text-2">Nothing to preview yet.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2 text-14 leading-relaxed text-ink [overflow-wrap:anywhere]">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h':
            return (
              <p key={i} className={b.level === 1 ? 'text-16 font-semibold' : 'font-semibold'}>
                {inline(b.text)}
              </p>
            );
          case 'ul':
            return (
              <ul key={i} className="list-disc pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="list-decimal pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ol>
            );
          case 'code':
            return (
              <pre key={i} className="overflow-x-auto rounded-btn bg-canvas p-3 font-mono text-13">
                {b.text}
              </pre>
            );
          default:
            return <p key={i}>{inline(b.text)}</p>;
        }
      })}
    </div>
  );
}
