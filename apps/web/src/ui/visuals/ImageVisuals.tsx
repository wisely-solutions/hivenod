/**
 * Image visuals (item OE8FmrTaIxFVGcaeGG3N, slice 4; design 5 "Images"): a screenshot (`image`)
 * and before/after screenshots (`image_pair`), from PNG, JPEG or WebP files the home agent
 * attached to this thread with thread_attach. The page shows only images it was handed for this
 * thread (`ThreadImages`, already checked); anything else is a quiet "not available" line. The
 * caption is the alt text; a click opens the image full size in the attachment viewer. A pair
 * sits side by side on desktop and stacked on phones; with both the same size a Compare toggle
 * lays one over the other with a slider.
 */
import type { Visual } from '@hive/shared';
import { Maximize2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AttachmentViewer } from '../../review/Viewers';
import { cn } from '../cn';
import { Icon } from '../icon';
import { Dialog } from '../overlay';
import { Frame } from './frame';

/** An image the page may show: its file name and its data URL. */
export interface ThreadImage {
  name: string;
  src: string;
}
/** The thread's images by attachment id. */
export type ThreadImages = ReadonlyMap<string, ThreadImage>;

type ImageVisual = Extract<Visual, { kind: 'image' }>;
type PairVisual = Extract<Visual, { kind: 'image_pair' }>;

/** The image full size, in the attachment viewer (zoom on desktop and phones). */
function FullSize({
  img,
  title,
  open,
  onOpenChange,
}: {
  img: ThreadImage;
  title: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} wide>
      <div className="h-[70dvh] overflow-hidden rounded-card border border-line">
        <AttachmentViewer
          attachment={{ kind: 'image', name: img.name, content: img.src, url: null }}
        />
      </div>
    </Dialog>
  );
}

function Missing({ what }: { what: string }) {
  return (
    <p
      data-image-missing=""
      className="grid min-h-24 place-items-center rounded-btn border border-dashed border-line px-3 py-4 text-center text-13 text-text-2"
    >
      {what} isn’t available on this thread.
    </p>
  );
}

/** One image as a button that opens it full size. */
function Shot({
  img,
  alt,
  label,
  onSize,
}: {
  img: ThreadImage;
  alt: string;
  label: string;
  onSize?: (w: number, h: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${label} full size`}
        className="group relative block w-full overflow-hidden rounded-btn border border-line bg-canvas foc:outline-2 foc:outline-offset-2 foc:outline-focus"
      >
        <img
          src={img.src}
          alt={alt}
          onLoad={(e) => onSize?.(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          className="mx-auto block h-auto max-h-80 w-auto max-w-full"
        />
        <span
          aria-hidden
          className="absolute right-1.5 top-1.5 grid size-7 place-items-center rounded-btn border border-line bg-surface/90 text-text-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <Icon icon={Maximize2} size={14} />
        </span>
      </button>
      <FullSize img={img} title={label} open={open} onOpenChange={setOpen} />
    </>
  );
}

function filesData(rows: Array<{ label: string; img: ThreadImage | undefined }>): ReactNode {
  return (
    <ul className="list-disc pl-5 text-13 text-ink">
      {rows.map((r, i) => (
        <li key={i} className="[overflow-wrap:anywhere]">
          {r.label}: {r.img ? r.img.name : 'not available'}
        </li>
      ))}
    </ul>
  );
}

export function ImageView({ v, images }: { v: ImageVisual; images: ThreadImages }) {
  const img = images.get(v.attachment);
  return (
    <Frame
      title={v.title}
      caption={v.caption}
      kind={v.kind}
      data={filesData([{ label: 'Image', img }])}
    >
      {img ? <Shot img={img} alt={v.caption} label={v.title} /> : <Missing what="This image" />}
    </Frame>
  );
}

/** The after image over the before one, cut at the slider (only when both are the same size). */
function Compare({
  before,
  after,
  labels,
  alt,
}: {
  before: ThreadImage;
  after: ThreadImage;
  labels: [string, string];
  alt: string;
}) {
  const [pos, setPos] = useState(50);
  return (
    <div data-compare="">
      <div className="relative overflow-hidden rounded-btn border border-line bg-canvas">
        <img src={before.src} alt={`${labels[0]}: ${alt}`} className="block h-auto w-full" />
        <img
          src={after.src}
          alt={`${labels[1]}: ${alt}`}
          className="absolute inset-0 block h-auto w-full"
          style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
        />
        <span
          aria-hidden
          className="absolute inset-y-0 w-0.5 bg-surface shadow-e2"
          style={{ left: `${pos}%` }}
        />
        <span className="absolute left-1.5 top-1.5 rounded-btn bg-surface/90 px-1.5 font-mono text-12 text-ink">
          {labels[0]}
        </span>
        <span className="absolute right-1.5 top-1.5 rounded-btn bg-surface/90 px-1.5 font-mono text-12 text-ink">
          {labels[1]}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        value={pos}
        onChange={(e) => setPos(Number(e.currentTarget.value))}
        aria-label={`Compare: show more of ${labels[0]} or ${labels[1]}`}
        aria-valuetext={`${100 - pos}% ${labels[1]}`}
        className="mt-2 w-full accent-[var(--agent)]"
      />
    </div>
  );
}

export function ImagePairView({ v, images }: { v: PairVisual; images: ThreadImages }) {
  const before = images.get(v.before);
  const after = images.get(v.after);
  const labels: [string, string] = v.labels ?? ['Before', 'After'];
  const [sizes, setSizes] = useState<Record<'b' | 'a', string>>({ b: '', a: '' });
  const [compare, setCompare] = useState(false);
  const same = !!before && !!after && sizes.b !== '' && sizes.b === sizes.a;
  const side = (key: 'b' | 'a', img: ThreadImage | undefined, label: string) => (
    <div className="min-w-0" data-side={key === 'b' ? 'before' : 'after'}>
      <p className="mb-1.5 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
        {label}
      </p>
      {img ? (
        <Shot
          img={img}
          alt={`${label}: ${v.caption}`}
          label={`${v.title}: ${label}`}
          onSize={(w, h) => setSizes((s) => ({ ...s, [key]: `${w}x${h}` }))}
        />
      ) : (
        <Missing what={`The ${label.toLowerCase()} image`} />
      )}
    </div>
  );
  return (
    <Frame
      title={v.title}
      caption={v.caption}
      kind={v.kind}
      data={filesData([
        { label: labels[0], img: before },
        { label: labels[1], img: after },
      ])}
    >
      {compare && same ? (
        <Compare before={before} after={after} labels={labels} alt={v.caption} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {side('b', before, labels[0])}
          {side('a', after, labels[1])}
        </div>
      )}
      {same ? (
        <button
          type="button"
          aria-pressed={compare}
          onClick={() => setCompare((c) => !c)}
          className={cn(
            'mt-2 inline-flex min-h-8 items-center rounded-btn border px-2.5 text-13 font-medium foc:outline-2 foc:outline-offset-2 foc:outline-focus',
            compare
              ? 'border-ink bg-ink text-surface'
              : 'border-line-strong text-ink hov:bg-canvas',
          )}
        >
          Compare
        </button>
      ) : null}
    </Frame>
  );
}
