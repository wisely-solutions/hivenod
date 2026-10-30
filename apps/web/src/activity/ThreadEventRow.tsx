import type { Agent, InboxEvent } from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { colorIndex } from '../agents/logic';
import type { Row } from '../lib/live';
import { AgentAvatar, Avatar } from '../ui/avatar';
import { cn } from '../ui/cn';
import { clock } from './logic';
import { groupOf, threadSentence, type ThreadGroupId } from './threadLogic';

const GROUP_DOT: Record<ThreadGroupId, string> = {
  threads: 'bg-text-2',
  plans: 'bg-agent',
  decisions: 'bg-approve',
  summaries: 'bg-gate',
};
const GROUP_NAME: Record<ThreadGroupId, string> = {
  threads: 'Thread',
  plans: 'Plan or step',
  decisions: 'Decision',
  summaries: 'Summary',
};

/** One line of the thread feed (slice 9): who, what in one sentence, the thread, when. */
export function ThreadEventRow({
  wid,
  event,
  title,
  agent,
  fresh,
  folded = 0,
}: {
  wid: string;
  event: Row<InboxEvent>;
  title: string | null;
  agent?: Row<Agent>;
  fresh?: boolean;
  folded?: number;
}) {
  const e = event.data;
  const ms = e.at.toMillis();
  const s = threadSentence(e, folded);
  const group = groupOf(e);
  const name = e.actor.name || (e.actor.type === 'agent' ? 'Agent' : 'Someone');
  const thread = e.threadId ? (
    <Link
      to="/inbox/$wid/t/$tid"
      params={{ wid, tid: e.threadId }}
      className="font-medium text-ink underline underline-offset-4 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
    >
      {title || 'a thread'}
    </Link>
  ) : (
    <span>a thread</span>
  );
  return (
    <motion.li
      initial={fresh ? { opacity: 0, y: -12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      data-type={e.type}
      data-group={group}
      className={cn(
        'border-t border-line px-3 py-2 first:border-t-0 sm:px-4',
        fresh && 'drop-in-highlight',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5">
          {e.actor.type === 'agent' ? (
            <AgentAvatar
              name={name}
              color={agent ? colorIndex(agent.data.color, agent.id) : colorIndex('', e.actor.id)}
              size="sm"
            />
          ) : (
            <Avatar name={name} size="sm" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-14 text-ink">
            <span className="font-semibold">{name}</span> {s.before}
            {thread}
            {s.after}
            {s.link ? (
              <>
                {' · '}
                <a
                  href={s.link.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-4 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
                >
                  {s.link.label}
                </a>
              </>
            ) : null}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-13 text-text-2">
            <span
              aria-hidden
              className={cn('inline-block size-2 rounded-full', GROUP_DOT[group])}
            />
            <span>{GROUP_NAME[group]}</span>
            <span>·</span>
            <time dateTime={new Date(ms).toISOString()}>{clock(ms)}</time>
            {e.actor.type === 'agent' ? <span>· agent</span> : null}
          </p>
        </div>
      </div>
    </motion.li>
  );
}
