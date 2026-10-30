/**
 * The frame every visual of the kit shares (item OE8FmrTaIxFVGcaeGG3N): a figure with its title
 * and caption, and a "Show data" toggle with the same data as a table or list.
 */
import { useId, useState, type ReactNode } from 'react';

// ---------- the frame: figure, caption, Show data ----------

export function Frame({
  title,
  caption,
  kind,
  data,
  children,
}: {
  title: string;
  caption: string;
  kind: string;
  /** The same data as a table or list (Show data). */
  data: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div
      data-visual={kind}
      className="flex min-w-0 flex-col rounded-card border border-line bg-surface p-3.5"
    >
      <figure className="m-0 min-w-0">
        <p className="text-14 font-semibold text-ink [overflow-wrap:anywhere]">{title}</p>
        <div className="mt-2.5 min-w-0">{children}</div>
        <figcaption className="mt-2 text-13 leading-relaxed text-text-2 [overflow-wrap:anywhere]">
          {caption}
        </figcaption>
      </figure>
      <div className="mt-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-8 items-center rounded-btn border border-line-strong px-2.5 text-13 font-medium text-ink hov:bg-canvas foc:outline-2 foc:outline-offset-2 foc:outline-focus"
        >
          {open ? 'Hide data' : 'Show data'}
        </button>
        <div id={id} data-visual-data="" hidden={!open} className="mt-2">
          {open ? data : null}
        </div>
      </div>
    </div>
  );
}
