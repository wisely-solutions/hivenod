import { ownGet } from '@hive/shared';
import { Check, ListPlus, MessageCircleQuestion, RotateCcw, Route, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { AgentAvatar } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { motion, useReducedMotion } from '../ui/motion';
import { haptic } from '../lib/mobile';
import { gateWaitNote } from '../notify/note';
import { useReminderMap } from '../notify/reminders';
import { formatEur } from '../shell/logic';
import { approvalLine, isStuckHold, swipeAction, waitLabel, type InboxEntry } from './logic';

export interface RowAgent {
  name: string;
  color: number;
  live: boolean;
}

const KIND_LABEL = {
  approval: 'Approval',
  question: 'Question',
  finding: 'Finding',
  path: 'Path change',
  proposal: 'New step',
} as const;
const KIND_ICON = {
  approval: Check,
  question: MessageCircleQuestion,
  finding: Sparkles,
  path: Route,
  proposal: ListPlus,
} as const;

const buzz = () => haptic('tick');

/** One inbox card. On a phone it swipes: right approves, left iterates; a long press opens quick actions. */
export function InboxRow({
  entry,
  selected,
  now,
  uid,
  names,
  agent,
  summary,
  swipeable,
  select,
  onOpen,
  onSwipe,
  onLongPress,
}: {
  entry: InboxEntry;
  selected: boolean;
  now: number;
  uid: string;
  names: Record<string, string>;
  agent: RowAgent | null;
  summary: string;
  swipeable: boolean;
  /** Approve and Accept rows can be selected; `show` draws the checkbox (always on desktop, while selecting on phones). */
  select?: { show: boolean; checked: boolean; onToggle: (shift: boolean) => void };
  onOpen: () => void;
  onSwipe: (action: 'approve' | 'iterate') => void;
  onLongPress: () => void;
}) {
  const reduced = useReducedMotion();
  const dragged = useRef(false);
  const longPressed = useRef(false);
  const crossed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [hint, setHint] = useState<'approve' | 'iterate' | null>(null);
  const { item, project } = entry;
  const step = project.steps.find((s) => s.id === item.stepId);
  const KindIcon = KIND_ICON[entry.kind];
  const pathStep = entry.stepId ? project.steps.find((s) => s.id === entry.stepId) : undefined;
  const request = entry.stepId ? ownGet(item.pathRequests, entry.stepId) : undefined;
  const title = entryTitle(entry);
  // Agents sent it back and forth too often (card KLCTVnX8): it waits for people to decide.
  const stuck = isStuckHold(entry);
  const text =
    entry.kind === 'question'
      ? (entry.question?.data.text ?? '')
      : entry.kind === 'path'
        ? (request?.reason ?? '')
        : entry.kind === 'proposal'
          ? (entry.proposal?.data.reason ?? '')
          : summary || item.summary;
  const gateLine = entry.kind === 'approval' ? approvalLine(project, item, uid, names) : '';
  const reminders = useReminderMap();
  const waitNote =
    entry.kind === 'approval'
      ? gateWaitNote({
          project,
          item,
          itemId: entry.itemId,
          sinceMs: entry.since,
          nowMs: now,
          reminders,
        })
      : null;

  const clearPress = () => clearTimeout(timer.current);

  return (
    <motion.li
      layout={reduced ? false : 'position'}
      initial={false}
      exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0, scale: 0.97 }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      className="relative pb-2"
    >
      {swipeable ? (
        <div
          aria-hidden
          className={cn(
            'absolute inset-x-0 top-0 bottom-2 flex items-center rounded-card px-5 text-14 font-semibold',
            hint === 'iterate'
              ? 'justify-end bg-sendback-bg text-sendback'
              : 'justify-start bg-approve-bg text-approve',
          )}
        >
          {hint === 'iterate' ? 'Send back' : 'Approve'}
        </div>
      ) : null}
      <motion.div
        drag={swipeable && !reduced ? 'x' : false}
        dragDirectionLock
        dragSnapToOrigin
        dragElastic={0.5}
        dragConstraints={{ left: 0, right: 0 }}
        onPointerDown={() => {
          dragged.current = false;
          longPressed.current = false;
          clearPress();
          timer.current = setTimeout(() => {
            if (!dragged.current) {
              longPressed.current = true;
              buzz();
              onLongPress();
            }
          }, 550);
        }}
        onPointerUp={clearPress}
        onPointerCancel={clearPress}
        onDragStart={() => {
          dragged.current = true;
          clearPress();
        }}
        onDrag={(_, info) => {
          const a = swipeAction(info.offset.x);
          if (a && !crossed.current) buzz();
          crossed.current = !!a;
          setHint(info.offset.x < 0 ? 'iterate' : 'approve');
        }}
        onDragEnd={(_, info) => {
          crossed.current = false;
          const a = swipeAction(info.offset.x);
          if (a) onSwipe(a);
        }}
        className="relative"
      >
        <button
          type="button"
          onClick={() => {
            // The click that ends a long press must not also open the row.
            if (dragged.current || longPressed.current) return;
            onOpen();
          }}
          aria-current={selected ? 'true' : undefined}
          className={cn(
            'flex w-full flex-col gap-1.5 rounded-card border bg-surface p-3.5 text-left',
            'transition-colors duration-120 hov:bg-canvas foc:outline-2 foc:outline-offset-2 foc:outline-focus',
            selected ? 'border-ink' : 'border-line',
            'border-l-4',
            entry.kind === 'finding' ? '' : 'border-l-gate',
            select?.show && 'pl-12',
            select?.checked && 'bg-canvas',
          )}
        >
          <span className="flex items-center gap-2 text-12 text-text-2">
            <Icon
              icon={KindIcon}
              size={14}
              label={stuck ? 'Agents are stuck' : KIND_LABEL[entry.kind]}
            />
            <span className="min-w-0 flex-1 truncate">
              {project.emoji} {project.name} · {pathStep?.name ?? step?.name ?? 'Step'}
            </span>
            <span className="shrink-0 tabular-nums">{waitLabel(entry.since, now)}</span>
          </span>
          <span className="text-15 font-semibold leading-snug text-ink">{title}</span>
          {text ? <span className="line-clamp-2 text-14 text-text-2">{text}</span> : null}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-text-2">
            {agent ? (
              <span className="inline-flex items-center gap-1.5">
                <AgentAvatar name={agent.name} color={agent.color} live={agent.live} size="sm" />
                {agent.name}
              </span>
            ) : null}
            {item.costEur > 0 ? <span>{formatEur(item.costEur)}</span> : null}
            {stuck ? (
              <Badge tone="sendback">
                <RotateCcw size={10} aria-hidden /> Agents sent it back {item.agentSendBacks}×
              </Badge>
            ) : null}
            {item.sendBackCount ? (
              <Badge tone="sendback">
                <RotateCcw size={10} aria-hidden /> {item.sendBackCount}
              </Badge>
            ) : null}
            {gateLine ? <span className="text-gate-text">{gateLine}</span> : null}
            {waitNote ? <span className="text-gate-text">{waitNote}</span> : null}
          </span>
        </button>
        {select?.show ? (
          // A 44 px target in the card's left edge, over the row's button (not inside it).
          <label className="absolute left-1 top-1 flex size-11 cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              aria-label={`Select ${title}`}
              checked={select.checked}
              onChange={() => undefined}
              onClick={(e) => select.onToggle(e.shiftKey)}
              className="size-5 accent-[var(--color-ink)]"
            />
          </label>
        ) : null}
      </motion.div>
    </motion.li>
  );
}

/** The row's question: the item's title, or the path decision in words (card st5INNZj). */
export function entryTitle(entry: InboxEntry): string {
  const { item, project } = entry;
  if (entry.kind === 'path' && entry.stepId) {
    const name = project.steps.find((s) => s.id === entry.stepId)?.name ?? 'this step';
    return ownGet(item.pathRequests, entry.stepId)?.op === 'add'
      ? `Add ${name} to “${item.title}”?`
      : `Skip ${name} for “${item.title}”?`;
  }
  if (entry.kind === 'proposal' && entry.proposal)
    return `Add the step “${entry.proposal.data.name}” to ${project.name}?`;
  return item.title;
}
