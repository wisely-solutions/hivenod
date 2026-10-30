import type { Attachment } from '@hive/shared';
import { ExternalLink, Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '../ui/markdown';
import { IconButton } from '../ui/button';
import { Icon } from '../ui/icon';
import { clampZoom, dataUrlToBlobUrl, hostOf } from './logic';
import { SandboxedHtml } from './SandboxedHtml';

function Note({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-14 text-text-2">{children}</p>;
}

/** An image you can zoom: buttons, ctrl/trackpad wheel and two-finger pinch. It scrolls when zoomed in. */
function ImageViewer({ src, name }: { src: string; name: string }) {
  const [zoom, setZoom] = useState(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ dist: number; zoom: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const dist = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * Math.exp(-e.deltaY / 200)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <div className="relative flex h-full flex-col">
      <div
        ref={box}
        data-testid="image-scroller"
        className="min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto bg-canvas"
        onPointerDown={(e) => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) start.current = { dist: dist(), zoom };
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId)) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2 && start.current && start.current.dist > 0)
            setZoom(clampZoom((start.current.zoom * dist()) / start.current.dist));
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          start.current = null;
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          start.current = null;
        }}
      >
        <img
          src={src}
          alt={name}
          draggable={false}
          style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
          className="mx-auto block h-auto select-none"
        />
      </div>
      <div
        role="group"
        aria-label="Zoom"
        className="absolute left-3 top-3 flex items-center gap-1 rounded-btn border border-line bg-surface/95 p-1 shadow-e2"
      >
        <IconButton
          label="Zoom out"
          variant="ghost"
          onClick={() => setZoom((z) => clampZoom(z - 0.25))}
        >
          <Icon icon={Minus} />
        </IconButton>
        <button
          type="button"
          className="min-h-11 min-w-14 rounded-btn px-2 text-13 font-medium tabular-nums hov:bg-ink/6 foc:outline-2 foc:outline-focus"
          aria-label="Fit to screen"
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconButton
          label="Zoom in"
          variant="ghost"
          onClick={() => setZoom((z) => clampZoom(z + 0.25))}
        >
          <Icon icon={Plus} />
        </IconButton>
      </div>
    </div>
  );
}

function PdfViewer({ dataUrl, name }: { dataUrl: string; name: string }) {
  const url = useMemo(() => dataUrlToBlobUrl(dataUrl), [dataUrl]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  if (!url) return <Note>This PDF cannot be shown.</Note>;
  return (
    <div className="flex h-full flex-col">
      <iframe title={name} src={url} className="min-h-0 w-full flex-1 border-0 bg-white" />
      <p className="border-t border-line bg-surface px-4 py-2 text-13 text-text-2">
        Phone not showing the PDF?{' '}
        <a href={url} download={name} className="font-medium text-ink underline underline-offset-4">
          Download {name}
        </a>
      </p>
    </div>
  );
}

function LinkCard({ url, name }: { url: string; name: string }) {
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-3 p-6">
      <div className="rounded-panel border border-line bg-surface p-5 shadow-e1">
        <p className="font-mono text-12 uppercase tracking-[0.08em] text-text-3">Link</p>
        <h2 className="mt-1 text-20 font-semibold text-ink">{name}</h2>
        <p className="mt-1 break-all text-14 text-text-2">{hostOf(url)}</p>
        <p className="mt-0.5 break-all text-13 text-text-3">{url}</p>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-btn bg-ink px-4 text-14 font-medium text-surface"
        >
          Open link <Icon icon={ExternalLink} size={16} />
        </a>
      </div>
    </div>
  );
}

/** What a viewer needs of an attachment (an item's, or a thread's: slice 4). */
export type ViewableAttachment = Pick<Attachment, 'kind' | 'name' | 'content' | 'url'>;

/** The one place that decides how each kind of attachment is shown full page. */
export function AttachmentViewer({ attachment: a }: { attachment: ViewableAttachment }) {
  if (a.kind === 'html') {
    return (
      <SandboxedHtml
        title={`Document: ${a.name}`}
        html={a.content ?? ''}
        className="block h-full w-full border-0 bg-white"
      />
    );
  }
  if (a.kind === 'markdown') {
    return (
      <div className="h-full overflow-auto bg-surface">
        <div className="mx-auto max-w-3xl p-5 sm:p-8">
          <Markdown source={a.content ?? ''} />
        </div>
      </div>
    );
  }
  if (a.kind === 'text') {
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap bg-surface p-5 font-mono text-13 sm:p-8">
        {a.content}
      </pre>
    );
  }
  if (a.kind === 'image' && a.content?.startsWith('data:image/'))
    return <ImageViewer src={a.content} name={a.name} />;
  if (a.kind === 'pdf' && a.content?.startsWith('data:application/pdf'))
    return <PdfViewer dataUrl={a.content} name={a.name} />;
  if (a.kind === 'link' && a.url && /^https?:\/\//.test(a.url))
    return <LinkCard url={a.url} name={a.name} />;
  return <Note>No preview for this file.</Note>;
}
