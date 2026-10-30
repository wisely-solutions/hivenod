/**
 * The decision page's layers under the top card (item OE8FmrTaIxFVGcaeGG3N, slice 2; design 3.1):
 * the short version (bullets, then the visual slot), and the folds: More detail (the summary's
 * details through the safe Markdown renderer, plus what the agent checked), Plan (phones) and
 * Everything (the conversation, steps, files and links, related subjects).
 */
import type {
  InboxAttachment,
  InboxMessage,
  InboxOutcome,
  InboxPlan,
  InboxThread,
  SummaryRef,
} from '@hive/shared';
import { Check, ChevronDown, ChevronRight, ExternalLink, Paperclip } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { Row } from '../lib/live';
import { Pill } from '../ui/badge';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { Markdown, parseBlocks } from '../ui/markdown';
import { Dialog } from '../ui/overlay';
import type { ThreadImages } from '../ui/visuals/ImageVisuals';
import { VisualNotShown, VisualView } from '../ui/visuals/Visual';
import { AttachmentViewer } from '../review/Viewers';
import { Conversation } from './Conversation';
import { THREAD_IMAGE_RE } from '@hive/shared';
import { excerpt, safeHttps, type ShownSummary, type TopTone } from './decision';
import type { TimelineEntry } from './logic';
import { OutcomeCard } from './OutcomeCard';
import { stepTitle } from './plan';
import { RelatedSubjects } from './RelatedSubjects';

const EYEBROW = 'font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3';
const CARD = 'rounded-panel border border-line bg-surface shadow-e1';

// ---------- a fold ----------

export function Fold({
  id,
  title,
  hint,
  open,
  onToggle,
  children,
  anchor,
}: {
  id: string;
  /** An anchor other pages link to (#plan). */
  anchor?: string;
  title: string;
  hint: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section
      id={anchor}
      aria-labelledby={`${id}-h`}
      data-fold={id}
      className={cn('mt-3 scroll-mt-20', CARD)}
    >
      <h2 id={`${id}-h`} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={onToggle}
          className="flex min-h-14 w-full items-center gap-3 rounded-panel px-4 text-left foc:outline-2 foc:-outline-offset-2 foc:outline-focus hov:bg-canvas/60 sm:px-5"
        >
          <span className="shrink-0 text-15 font-semibold text-ink">{title}</span>
          <span className="ml-auto flex min-w-0 items-center justify-end gap-1.5 truncate text-13 text-text-2">
            {hint}
          </span>
          <Icon
            icon={open ? ChevronDown : ChevronRight}
            size={16}
            className="shrink-0 text-text-3"
          />
        </button>
      </h2>
      <div id={`${id}-body`} hidden={!open} className="border-t border-line px-4 pb-4 pt-3 sm:px-5">
        {open ? children : null}
      </div>
    </section>
  );
}

const TONE_PILL: Record<TopTone, 'gate' | 'agent' | 'sendback' | 'approve' | 'neutral'> = {
  gate: 'gate',
  agent: 'agent',
  sendback: 'sendback',
  approve: 'approve',
  neutral: 'neutral',
};
export function HintPills({ parts }: { parts: Array<{ text: string; tone: TopTone }> }) {
  return (
    <>
      {parts.map((p) => (
        <Pill key={p.text} tone={TONE_PILL[p.tone]}>
          {p.text}
        </Pill>
      ))}
    </>
  );
}

// ---------- the short version ----------

function RefLink({ r, onInside }: { r: SummaryRef; onInside: () => void }) {
  const href = safeHttps(r.url);
  const cls =
    'inline-flex items-center gap-0.5 text-13 font-medium text-agent hov:underline foc:outline-2 foc:outline-focus';
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" data-ref={r.id} className={cls}>
      {r.label}
      <Icon icon={ExternalLink} size={12} />
    </a>
  ) : (
    <button type="button" data-ref={r.id} onClick={onInside} className={cls}>
      {r.label} ›
    </button>
  );
}

export function ShortVersion({
  summary,
  images,
  asks,
  firstMessage,
  why,
  onOpenEverything,
}: {
  summary: ShownSummary | null;
  /** The thread's images the image visuals may show (threadImages). */
  images: ThreadImages;
  /** A person step waits (the visual rule: a visual, or the agent's reason for none). */
  asks: boolean;
  firstMessage: string;
  why: string | null;
  onOpenEverything: () => void;
}) {
  const visuals = summary?.visuals ?? [];
  return (
    <section aria-labelledby="short-h" data-short="" className={cn('mt-3 p-4 sm:p-5', CARD)}>
      <h2 id="short-h" className={EYEBROW}>
        The short version
      </h2>
      {summary ? (
        <>
          <ul aria-label="Summary" className="mt-2.5 flex list-disc flex-col gap-1.5 pl-5">
            {summary.bullets.map((b, i) => (
              <li key={i} className="text-15 leading-relaxed text-ink [overflow-wrap:anywhere]">
                {b.text}
                {b.refs.map((r) => (
                  <span key={`${r.kind}:${r.id}`} className="ml-2 inline-block">
                    <RefLink r={r} onInside={onOpenEverything} />
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {visuals.length ? (
            <div
              data-visuals=""
              className={cn('mt-4 grid gap-3', visuals.length > 1 && 'md:grid-cols-2')}
            >
              {visuals.map((v, i) => (
                <div
                  key={i}
                  className={cn(
                    'min-w-0',
                    visuals.length > 1 &&
                      visuals.length % 2 === 1 &&
                      i === visuals.length - 1 &&
                      'md:col-span-2',
                  )}
                >
                  {v.ok ? (
                    <VisualView v={v.visual} images={images} />
                  ) : (
                    <VisualNotShown kind={v.kind} />
                  )}
                </div>
              ))}
            </div>
          ) : asks && summary.noVisualWhy ? (
            <p data-no-visual="" className="mt-3 text-13 text-text-2 [overflow-wrap:anywhere]">
              No picture: {summary.noVisualWhy}
            </p>
          ) : null}
        </>
      ) : (
        <div data-no-summary="" className="mt-2.5">
          <p className="text-15 font-medium text-ink">No summary yet</p>
          {firstMessage ? (
            <p className="mt-1 text-14 text-text-2 [overflow-wrap:anywhere]">
              <span className="sr-only">The first message: </span>“{excerpt(firstMessage, 240)}”
            </p>
          ) : null}
          {why ? <p className="mt-1 text-13 text-text-2">{why}</p> : null}
        </div>
      )}
    </section>
  );
}

// ---------- more detail ----------

/** More detail's fold label: the details' headings (up to 3), and how many checks. */
export function detailHint(details: string | null, checks: number): string {
  const heads = details
    ? parseBlocks(details)
        .filter((b) => b.t === 'h')
        .map((b) => (b as { text: string }).text.toLowerCase())
        .slice(0, 3)
    : [];
  const parts = heads.length ? heads : details ? ['details'] : [];
  if (checks) parts.push(`${checks} ${checks === 1 ? 'check' : 'checks'}`);
  return parts.join(' · ') || 'nothing more yet';
}

export function MoreDetail({
  details,
  checks,
  agent,
}: {
  details: string | null;
  checks: string[];
  agent: string;
}) {
  if (!details && !checks.length)
    return <p className="text-14 text-text-2">{agent} has written nothing more yet.</p>;
  return (
    <div className="flex flex-col gap-4">
      {details ? (
        <div data-details="">
          <Markdown source={details} />
        </div>
      ) : null}
      {checks.length ? (
        <div>
          <h3 className={cn(EYEBROW, 'mb-2')}>What {agent} checked</h3>
          <ul aria-label="What the agent checked" className="flex flex-col gap-1.5">
            {checks.map((c, i) => (
              <li key={i} className="flex gap-2 text-14 text-ink">
                <Icon icon={Check} size={15} className="mt-0.5 shrink-0 text-approve-text" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{c}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------- everything ----------

const FILTERS = ['Messages', 'Steps', 'Files', 'Links'] as const;
type Filter = (typeof FILTERS)[number];

export interface EverythingProps {
  wid: string;
  uid: string;
  thread: Row<InboxThread>;
  entries: readonly TimelineEntry[];
  messages: InboxMessage[];
  decided: Row<InboxOutcome>[];
  /** Plan steps that ran (their results), from every plan of the thread. */
  plans: Row<InboxPlan>[];
  outcomes: Row<InboxOutcome>[];
  refs: SummaryRef[];
  /** Files the home agent attached to the thread (slice 4). */
  attachments: Row<InboxAttachment>[];
  now: number;
  agentName: (id: string) => string;
  /** Older plans, drawn by the caller (the plan panel). */
  pastPlans: ReactNode;
}

/** Links in Everything: the summary's refs with an https url, then the messages' links. */
export function everythingLinks(refs: SummaryRef[], messages: InboxMessage[]) {
  const out: Array<{ label: string; url: string }> = [];
  for (const r of refs) {
    const u = safeHttps(r.url);
    if (u) out.push({ label: r.label, url: u });
  }
  messages.forEach((m) => {
    const u = safeHttps(m.permalink);
    if (u) out.push({ label: `${m.sender.name} on ${m.source}`, url: u });
  });
  return out;
}

export function Everything(p: EverythingProps) {
  const [on, setOn] = useState<Filter[]>([]);
  const shows = (f: Filter) => on.length === 0 || on.includes(f);
  const t = p.thread.data;
  const files = p.messages.flatMap((m) =>
    m.attachments.map((a) => ({ ...a, url: safeHttps(a.url), from: m.sender.name })),
  );
  const links = everythingLinks(p.refs, p.messages);
  const ran = p.plans.flatMap((pl) =>
    pl.data.steps
      .map((id, i) => ({ i, o: p.outcomes.find((o) => o.id === id) }))
      .filter((s) => s.o && (s.o.data.state === 'done' || s.o.data.state === 'failed'))
      .map((s) => ({ plan: pl.id, n: s.i + 1, row: s.o! })),
  );
  return (
    <div data-everything="" className="flex flex-col gap-4">
      <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={on.includes(f)}
            onClick={() =>
              setOn((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]))
            }
            className={cn(
              'inline-flex min-h-9 items-center rounded-full border px-3 text-13 font-medium foc:outline-2 foc:outline-offset-2 foc:outline-focus',
              on.includes(f)
                ? 'border-ink bg-ink text-surface'
                : 'border-line-strong bg-surface text-ink hov:bg-canvas',
            )}
          >
            {f}
          </button>
        ))}
      </div>
      {shows('Messages') ? <Conversation entries={p.entries} now={p.now} /> : null}
      {shows('Steps') && (ran.length || p.decided.length) ? (
        <section aria-label="Steps and outcomes">
          <h3 className={cn(EYEBROW, 'mb-2')}>Steps and outcomes</h3>
          <ul className="flex flex-col gap-2">
            {ran.map((s) => (
              <li
                key={`${s.plan}:${s.row.id}`}
                data-ran={s.row.id}
                className="rounded-card border border-line bg-surface-2 px-3.5 py-2.5 text-14 text-ink"
              >
                <span className="font-medium">
                  Step {s.n} · {stepTitle(s.row.data.type, s.row.data.fields)}
                </span>
                <span className="text-text-2">
                  {' · '}
                  {s.row.data.state === 'done' ? 'done' : 'failed'}
                </span>
                {s.row.data.result?.error ? (
                  <span className="block text-13 text-sendback [overflow-wrap:anywhere]">
                    {s.row.data.result.error}
                  </span>
                ) : null}
                {s.row.data.result?.text ? (
                  <span className="block whitespace-pre-wrap text-13 text-text-2 [overflow-wrap:anywhere]">
                    {excerpt(s.row.data.result.text, 400)}
                  </span>
                ) : null}
                {safeHttps(s.row.data.result?.permalink) ? (
                  <a
                    href={safeHttps(s.row.data.result?.permalink)!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-13 font-medium text-agent hov:underline"
                  >
                    Open the result
                    <Icon icon={ExternalLink} size={12} />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
          {p.decided.length ? (
            <div className="mt-2 flex flex-col gap-3">
              {p.decided.map((o) => (
                <OutcomeCard
                  key={o.id}
                  wid={p.wid}
                  oid={o.id}
                  outcome={o.data}
                  thread={t}
                  othersPending={false}
                  agentName={p.agentName}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {shows('Steps') ? p.pastPlans : null}
      {shows('Files') && p.attachments.length ? (
        <ThreadFiles rows={p.attachments} agent={p.agentName(t.fetchedBy ?? '')} />
      ) : null}
      {shows('Files') && files.length ? (
        <section aria-label="Files">
          <h3 className={cn(EYEBROW, 'mb-2')}>Files</h3>
          <ul className="flex flex-col gap-1.5">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-2 text-14 text-ink">
                <Icon icon={Paperclip} size={14} className="shrink-0 text-text-3" />
                {f.url ? (
                  <a
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate font-medium text-agent hov:underline"
                  >
                    {f.name}
                  </a>
                ) : (
                  <span className="min-w-0 truncate">{f.name}</span>
                )}
                <span className="shrink-0 text-13 text-text-2">from {f.from}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {shows('Links') && links.length ? (
        <section aria-label="Links">
          <h3 className={cn(EYEBROW, 'mb-2')}>Links</h3>
          <ul className="flex flex-col gap-1.5">
            {links.map((l, i) => (
              <li key={i}>
                <a
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1 text-14 font-medium text-agent hov:underline"
                >
                  <span className="truncate">{l.label}</span>
                  <Icon icon={ExternalLink} size={12} className="shrink-0" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {t.subjectId && on.length === 0 ? (
        <div className="[&>section]:mt-0">
          <RelatedSubjects wid={p.wid} sid={t.subjectId} uid={p.uid} />
        </div>
      ) : null}
    </div>
  );
}

// ---------- the thread's files (slice 4) ----------

/** One attached file: images inline, everything else opens in the attachment viewer. */
function ThreadFile({ a }: { a: InboxAttachment }) {
  const [open, setOpen] = useState(false);
  const isImage = a.kind === 'image' && THREAD_IMAGE_RE.test(a.content ?? '');
  const link = a.kind === 'link' ? safeHttps(a.url) : null;
  if (a.kind === 'link')
    return link ? (
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-full items-center gap-1 text-14 font-medium text-agent hov:underline"
      >
        <span className="truncate">{a.name}</span>
        <Icon icon={ExternalLink} size={12} className="shrink-0" />
      </a>
    ) : (
      <span className="text-14 text-ink">{a.name}</span>
    );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full min-w-0 flex-col items-start gap-1.5 rounded-card text-left foc:outline-2 foc:outline-offset-2 foc:outline-focus"
      >
        <span className="flex min-w-0 max-w-full items-center gap-2 text-14 font-medium text-agent hov:underline">
          <Icon icon={Paperclip} size={14} className="shrink-0 text-text-3" />
          <span className="truncate">{a.name}</span>
        </span>
        {isImage ? (
          <img
            src={a.content ?? ''}
            alt={a.name}
            className="max-h-40 max-w-full rounded-btn border border-line"
          />
        ) : null}
      </button>
      <Dialog open={open} onOpenChange={setOpen} title={a.name} wide>
        <div className="h-[70dvh] overflow-hidden rounded-card border border-line">
          <AttachmentViewer
            attachment={{
              kind: a.kind,
              name: a.name,
              content: a.kind === 'image' && !isImage ? null : a.content,
              url: null,
            }}
          />
        </div>
      </Dialog>
    </>
  );
}

export function ThreadFiles({ rows, agent }: { rows: Row<InboxAttachment>[]; agent: string }) {
  const sorted = [...rows].sort(
    (x, y) => (y.data.at?.toMillis() ?? 0) - (x.data.at?.toMillis() ?? 0),
  );
  return (
    <section aria-label={`Files from ${agent}`} data-thread-files="">
      <h3 className={cn(EYEBROW, 'mb-2')}>Files from {agent}</h3>
      <ul className="flex flex-col gap-3">
        {sorted.map((r) => (
          <li key={r.id} data-attachment={r.id}>
            <ThreadFile a={r.data} />
          </li>
        ))}
      </ul>
    </section>
  );
}
