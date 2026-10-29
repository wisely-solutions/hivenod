/**
 * A thread's conversation (item kt3E7u9EliL3q2veDDI0, design 2.3): the messages in time order as
 * bubbles (sender, channel, time, the original link), the agents' notes and the decisions as
 * small inline lines, with day separators. The full timeline sits in a disclosure at the bottom.
 */
import type { InboxEvent, InboxEventType, InboxMessage } from '@hive/shared';
import { Bot, ChevronDown, ChevronRight, Paperclip, User } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Icon } from '../ui/icon';
import { SenderAvatar } from '../today/parts';
import { eventText, type TimelineEntry } from './logic';
import { SourceTag, when } from './parts';

/** Events drawn inline between the messages: notes and decisions. The rest is in Timeline. */
const INLINE: ReadonlySet<InboxEventType> = new Set<InboxEventType>([
  'thread.note',
  'thread.asked',
  'thread.answered',
  'thread.due',
  'thread.flagged',
  'outcome.proposed',
  'outcome.approved',
  'outcome.rejected',
  'outcome.done',
  'outcome.failed',
  'thread.itemMade',
  'thread.instructed',
  'thread.instruction_answered',
]);

const DAY = 86_400_000;
function dayName(ms: number, now: number): string {
  const d = new Date(ms);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (ms >= start.getTime()) return 'Today';
  if (ms >= start.getTime() - DAY) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
const time = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function Conversation({ entries, now }: { entries: readonly TimelineEntry[]; now: number }) {
  const [open, setOpen] = useState(false);
  const shown = entries.filter((e) => e.kind === 'message' || INLINE.has(e.event.type));
  const days = shown.map((e) => dayName(e.at, now));
  return (
    <section aria-label="Conversation" className="mt-5">
      {shown.length === 0 ? (
        <p className="text-14 text-text-2">No messages yet.</p>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Messages and notes">
          {shown.map((e, i) => {
            const day = days[i]!;
            const sep = i === 0 || day !== days[i - 1];
            return (
              <Fragment key={e.id}>
                {sep ? (
                  <li aria-hidden className="flex items-center gap-3 py-1 text-12 text-text-3">
                    <span className="h-px flex-1 bg-line" />
                    {day}
                    <span className="h-px flex-1 bg-line" />
                  </li>
                ) : null}
                {e.kind === 'message' ? (
                  <li>
                    <Bubble m={e.message} />
                  </li>
                ) : (
                  <li data-event={e.event.type}>
                    <EventLine e={e.event} at={e.at} />
                  </li>
                )}
              </Fragment>
            );
          })}
        </ol>
      )}
      <div className="mt-6 border-t border-line pt-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-btn text-14 font-medium text-text-2 hov:text-ink foc:outline-2 foc:outline-focus"
        >
          <Icon icon={open ? ChevronDown : ChevronRight} size={16} />
          Timeline
          <span className="text-text-3">({entries.length})</span>
        </button>
        {/* Rendered only when open: the same lines must not be on the page twice. */}
        {open ? (
          <ol className="mt-2 flex flex-col gap-2" aria-label="Timeline">
            {entries.map((e) => (
              <li key={e.id} className="flex gap-3 text-13 text-text-2">
                <span className="w-28 shrink-0 tabular-nums">{when(e.at)}</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {e.kind === 'message'
                    ? `${e.message.direction === 'out' ? 'You' : e.message.sender.name} wrote on ${e.message.source}`
                    : eventText(e.event)}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

function Bubble({ m }: { m: InboxMessage }) {
  const mine = m.direction === 'out';
  const at = m.receivedAt.toMillis();
  return (
    <article data-message="" className="flex gap-3">
      {mine ? (
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-surface"
        >
          <Icon icon={User} size={15} />
        </span>
      ) : (
        <SenderAvatar name={m.sender.name} size="sm" />
      )}
      <div className="min-w-0 flex-1">
        <header className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-14 font-semibold text-ink">{mine ? 'You' : m.sender.name}</span>
          {m.sender.handle && !mine ? (
            <span className="text-13 text-text-2 [overflow-wrap:anywhere] max-sm:hidden">
              {m.sender.handle}
            </span>
          ) : null}
          <SourceTag source={m.source} />
          <span className="text-13 text-text-2" title={new Date(at).toLocaleString()}>
            {time(at)}
          </span>
        </header>
        <div
          className={
            mine
              ? 'rounded-card rounded-tl-sm border border-line bg-canvas px-3.5 py-2.5'
              : 'rounded-card rounded-tl-sm border border-line bg-surface px-3.5 py-2.5 shadow-e1'
          }
        >
          <p className="whitespace-pre-wrap text-14 leading-relaxed text-ink [overflow-wrap:anywhere]">
            {m.text}
          </p>
          {m.attachments.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <li key={a.url}>
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-9 items-center gap-1 rounded-btn border border-line px-2 text-13 text-ink hov:bg-canvas"
                  >
                    <Icon icon={Paperclip} size={14} />
                    {a.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {m.permalink ? (
          <a
            href={m.permalink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-9 items-center text-13 font-medium text-agent hov:underline"
          >
            Open the original
          </a>
        ) : null}
      </div>
    </article>
  );
}

function EventLine({ e, at }: { e: InboxEvent; at: number }) {
  const agent = e.actor.type === 'agent';
  return (
    <p className="flex items-start gap-2 pl-11 text-13 text-text-2">
      <Icon
        icon={agent ? Bot : User}
        size={14}
        className={agent ? 'mt-0.5 shrink-0 text-agent' : 'mt-0.5 shrink-0 text-text-3'}
      />
      <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
        {eventText(e)}
        <span className="text-text-3"> · {time(at)}</span>
      </span>
    </p>
  );
}
