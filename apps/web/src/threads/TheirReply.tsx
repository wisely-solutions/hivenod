/**
 * A Their reply step on the decision page and the plan rail (packages/shared/src/theirreply.ts):
 * who it waits on and what for, the message in hand (to approve, being sent, or the last one
 * sent), their latest reply quoted, and the member's buttons: Approve (maybe edited) and Mark
 * done anyway. Nothing is sent before the member approves it.
 */
import { EXT_ASK_LABEL, theirReplyView, type InboxOutcome } from '@hive/shared';
import { Check, Quote } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import type { Countdown } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';

const dayFmt = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(
    new Date(ms),
  );

/** The step's pill text while it waits on them ("waiting on Ana · 2 d"), else null. */
export function theirReplyPill(o: InboxOutcome, now: number): string | null {
  return theirReplyView(o, now)?.pill ?? null;
}

/** Their latest reply, quoted under the step row (also when the step is closed). */
export function TheirReplyQuote({ o, now }: { o: InboxOutcome; now: number }) {
  const v = theirReplyView(o, now);
  if (!v?.quote) return null;
  return (
    <p
      data-their-quote=""
      className="mt-1 flex items-start gap-1.5 text-13 text-text-2 [overflow-wrap:anywhere]"
    >
      <Icon icon={Quote} size={13} className="mt-0.5 shrink-0 text-external" />
      <span className="min-w-0">
        {v.who} replied: “{v.quote}”
      </span>
    </p>
  );
}

export function TheirReplyBody(props: {
  o: InboxOutcome;
  now: number;
  live: boolean;
  atCursor: boolean;
  agent: string;
  counting: Countdown | undefined;
  onApprove: (label: string, text?: string) => void;
  onMarkDone: () => void;
}) {
  const { o, now, live, atCursor, agent } = props;
  const v = theirReplyView(o, now);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  if (!v) return null;
  const label = v.ask ? (EXT_ASK_LABEL[v.ask.kind] ?? 'Message') : 'Ask';
  const canDecide = live && atCursor && o.state !== 'done';
  const sent = o.ext?.sent ?? 0;
  return (
    <div data-their-reply={v.phase} className="flex flex-col gap-2.5">
      <p className="text-14 text-ink [overflow-wrap:anywhere]">
        <span className="font-semibold">
          {v.who}
          {v.org ? ` (${v.org})` : ''}
        </span>{' '}
        · {v.need}
      </p>
      <p className="text-13 text-text-2 [overflow-wrap:anywhere]">
        By {v.channel}
        {typeof o.fields.address === 'string' ? ` to ${o.fields.address}` : ''}
        {sent ? ` · ${sent} ${sent === 1 ? 'message' : 'messages'} sent` : ''}
      </p>
      {v.phase === 'waiting' && v.remindAtMs ? (
        <p data-their-remind="" className="text-13 text-text-2">
          Waiting {v.days ?? 0} {v.days === 1 ? 'day' : 'days'} so far. With no reply, one reminder
          is drafted for you on {dayFmt(v.remindAtMs)}.
        </p>
      ) : null}
      {v.phase === 'ready' && o.state !== 'done' ? (
        <p className="text-13 text-text-2">
          {agent} drafts the message to {v.who}: it waits for your approval before anything is sent.
        </p>
      ) : null}
      {v.quote ? (
        <blockquote
          data-their-quote-full=""
          className="border-l-2 border-external pl-3 text-14 text-ink [overflow-wrap:anywhere]"
        >
          <span className="block text-12 font-semibold uppercase tracking-[0.06em] text-external">
            {v.who} replied
          </span>
          “{v.quote}”
        </blockquote>
      ) : null}
      {v.ask && o.state !== 'done' ? (
        <div className="rounded-btn border border-line bg-surface p-3">
          <p className="text-12 font-semibold uppercase tracking-[0.06em] text-text-3">
            {label}
            {v.phase === 'approve'
              ? ` drafted by ${agent}: waits for you`
              : v.phase === 'sending'
                ? `: approved, ${agent} sends it`
                : ': sent'}
          </p>
          {editing ? (
            <Textarea
              label={`${label} to ${v.who}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="mt-2"
            />
          ) : (
            <p
              data-their-ask=""
              className="mt-1.5 whitespace-pre-wrap text-14 text-ink [overflow-wrap:anywhere]"
            >
              {v.ask.text}
            </p>
          )}
        </div>
      ) : null}
      {canDecide && (v.phase === 'approve' || v.phase === 'waiting') ? (
        <div className="flex flex-wrap gap-2">
          {props.counting ? (
            <UndoButton countdown={props.counting} variant="approve" />
          ) : (
            <>
              {v.phase === 'approve' ? (
                <>
                  <Button
                    variant="approve"
                    data-their-approve=""
                    onClick={() => {
                      props.onApprove(label, editing ? text : undefined);
                      setEditing(false);
                    }}
                    leading={<Icon icon={Check} size={16} />}
                  >
                    Approve {label.toLowerCase()}
                  </Button>
                  {!editing ? (
                    <Button
                      variant="secondary"
                      data-their-edit=""
                      onClick={() => {
                        setText(v.ask?.text ?? '');
                        setEditing(true);
                      }}
                    >
                      Edit
                    </Button>
                  ) : null}
                </>
              ) : null}
              <Button variant="secondary" data-their-done="" onClick={props.onMarkDone}>
                Mark done anyway
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
