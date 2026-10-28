import { CloudOff, CornerUpLeft, Paperclip } from 'lucide-react';
import { motion } from 'motion/react';
import type { HTMLAttributes, ReactNode } from 'react';
import { AgentAvatar } from './avatar';
import { Badge, Pill } from './badge';
import { cn } from './cn';
import { Icon } from './icon';
import { ProgressRing, WorkingDots } from './feedback';
import { spring } from './motion';
import { useJustAdded } from '../capture/justAdded';
import type { PathView } from '../board/path';
import { PathCompact } from './path';

export function Card({
  className,
  tone = 'plain',
  ...rest
}: HTMLAttributes<HTMLDivElement> & { tone?: 'plain' | 'gate' | 'agent' }) {
  return (
    <div
      className={cn(
        'rounded-card border p-4 shadow-e1',
        tone === 'gate' && 'border-gate/60 bg-gate-bg',
        tone === 'agent' && 'border-line bg-agent-soft',
        tone === 'plain' && 'border-line bg-surface',
        className,
      )}
      {...rest}
    />
  );
}

export interface ItemCardData {
  id: string;
  title: string;
  type: 'idea' | 'request' | 'bug' | 'finding' | 'task';
  attachments?: string;
  progress?: { done: number; total: number };
  sendBacks?: number;
  agent?: { name: string; color: number; live?: boolean };
  approvals?: { have: number; need: number };
  waitingForYou?: boolean;
  /** "Waiting 30 h · reminder sent", shown once a gate's reminder time has passed. */
  waitNote?: string;
  /** Stop work, Go back (card BrK0r2FE): no agent takes it until someone presses Resume. */
  onHold?: boolean;
  /** Added or changed on this device and not yet confirmed by the server (offline). */
  pendingSync?: boolean;
  foundBy?: string;
  /** Per-item paths (card st5INNZj): the compact path strip. */
  path?: PathView;
}

/** An item as it appears on the board and in the inbox. Becomes a button when onOpen is set. */
/** "Sent back once", "Sent back 3 times". */
export function sentBackText(n: number): string {
  return n === 1 ? 'Sent back once' : `Sent back ${n} times`;
}

export function ItemCard({
  item,
  onOpen,
  layoutId,
  className,
  trailing,
}: {
  item: ItemCardData;
  onOpen?: () => void;
  /** Shared-element id: the same id on the detail view animates the open and close. */
  layoutId?: string;
  className?: string;
  trailing?: ReactNode;
}) {
  const [justAdded, trackNode, pulse] = useJustAdded(item.id);
  const body = (
    <>
      {item.foundBy ? (
        <p className="mb-1 font-mono text-12 uppercase tracking-[0.08em] text-gate-text">
          Found while working · {item.foundBy}
        </p>
      ) : null}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge>{item.type}</Badge>
            {item.waitingForYou ? <Pill tone="gate">Waiting for you</Pill> : null}
            {item.onHold ? <Pill tone="gate">On hold</Pill> : null}
            {item.pendingSync ? (
              <span className="inline-flex items-center gap-1 text-12 text-text-2">
                <Icon icon={CloudOff} size={12} />
                Waiting to sync
              </span>
            ) : null}
          </div>
          <h3 className="text-14 font-semibold leading-snug text-ink">{item.title}</h3>
        </div>
        {item.progress ? (
          <ProgressRing
            value={item.progress.done}
            max={item.progress.total}
            label="Progress"
            caption
          />
        ) : null}
        {trailing}
      </div>
      {item.path ? <PathCompact view={item.path} className="mt-2.5" /> : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-13 text-text-2">
        {item.agent ? (
          <span className="inline-flex items-center gap-1.5">
            <AgentAvatar
              name={item.agent.name}
              color={item.agent.color}
              live={item.agent.live}
              size="sm"
            />
            {item.agent.live ? (
              <>
                <WorkingDots />
                <span className="sr-only">{item.agent.name} is working</span>
              </>
            ) : (
              item.agent.name
            )}
          </span>
        ) : null}
        {item.attachments ? (
          <span className="inline-flex items-center gap-1">
            <Icon icon={Paperclip} size={14} />
            {item.attachments}
          </span>
        ) : null}
        {item.sendBacks ? (
          <span
            className="inline-flex items-center gap-1 text-sendback"
            title={sentBackText(item.sendBacks)}
          >
            <Icon icon={CornerUpLeft} size={14} />
            <span aria-hidden>{item.sendBacks}</span>
            <span className="sr-only">{sentBackText(item.sendBacks)}</span>
          </span>
        ) : null}
        {item.approvals ? (
          <span>
            {item.approvals.have} of {item.approvals.need} approved
          </span>
        ) : null}
        {item.waitNote ? <span className="text-gate-text">{item.waitNote}</span> : null}
      </div>
    </>
  );

  const classes = cn(
    'block w-full rounded-card border border-line bg-surface p-3.5 text-left shadow-e1',
    onOpen &&
      'transition-[border-color,box-shadow] duration-120 ease-standard hov:border-line-strong hov:shadow-e2 foc:outline-2 foc:outline-offset-2 foc:outline-focus act:scale-[0.995]',
    justAdded && 'ring-2 ring-gate ring-offset-2 ring-offset-canvas',
    className,
  );

  if (onOpen) {
    return (
      <motion.button
        type="button"
        layoutId={layoutId}
        layout={layoutId ? 'position' : undefined}
        transition={spring.ui}
        onClick={onOpen}
        className={classes}
        data-item-id={item.id}
        data-just-added={pulse || undefined}
        ref={trackNode}
      >
        {body}
      </motion.button>
    );
  }
  return (
    <motion.div
      layoutId={layoutId}
      transition={spring.ui}
      className={classes}
      data-item-id={item.id}
      data-just-added={pulse || undefined}
      ref={trackNode}
    >
      {body}
    </motion.div>
  );
}
