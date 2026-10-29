import { Mail, MailQuestion, TriangleAlert } from 'lucide-react';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { motion, useReducedMotion } from '../ui/motion';
import { waitLabel } from '../inbox/logic';
import { LabelBadge } from '../threads/labels';
import type { NeedsEntry } from './logic';
import { WhoTag } from './WhoTag';

/** An Inbox thread waiting for the member: the agent asked them (Needs you) or proposed outcomes (Your call). */
export function ThreadRow({
  entry,
  now,
  selected,
  onOpen,
}: {
  entry: NeedsEntry;
  now: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const reduced = useReducedMotion();
  const t = entry.thread!.data;
  const asked = t.state === 'needsYou';
  const text = asked ? (t.question?.text ?? '') : 'Proposed outcomes wait for your call.';
  return (
    <motion.li
      layout={reduced ? false : 'position'}
      initial={false}
      exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      className="relative pb-2"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col gap-1.5 rounded-card border border-l-4 border-l-agent bg-surface p-3.5 text-left',
          'transition-colors duration-120 hov:bg-canvas foc:outline-2 foc:outline-offset-2 foc:outline-focus',
          selected ? 'border-ink' : 'border-line',
        )}
      >
        <span className="flex items-center gap-2 text-12 text-text-2">
          <Icon
            icon={asked ? MailQuestion : Mail}
            size={14}
            label={asked ? 'Inbox question' : 'Inbox outcomes'}
          />
          <span className="min-w-0 flex-1 truncate">
            Inbox · {asked ? 'Needs you' : 'Your call'}
          </span>
          <span className="shrink-0 tabular-nums">{waitLabel(entry.since, now)}</span>
        </span>
        <span className="text-15 font-semibold leading-snug text-ink">
          {t.title || 'Untitled thread'}
        </span>
        {text ? <span className="line-clamp-2 text-14 text-text-2">{text}</span> : null}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-text-2">
          <WhoTag who={entry.who} />
          {entry.label ? (
            <LabelBadge label={entry.label.label} suggested={entry.label.suggested} />
          ) : null}
          {entry.urgent ? (
            <Badge tone="sendback">
              <TriangleAlert size={10} aria-hidden /> Urgent
            </Badge>
          ) : null}
        </span>
      </button>
    </motion.li>
  );
}
