import type { Agent, HiveEvent, Project } from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { colorIndex } from '../agents/logic';
import type { Row } from '../lib/live';
import { AgentAvatar, Avatar } from '../ui/avatar';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { isNewAttachment } from '../board/logic';
import { clock, eventSentence, progressSummary, progressText, type EventDetail } from './logic';
import { RunLog } from './RunLog';

/** One line of the feed: who, what in plain words, when, and where to look. */
/** Item events the claim, release and complete actions write for a run (they carry its runId). */
const RUN_ITEM_EVENTS: ReadonlySet<string> = new Set([
  'item.claimed',
  'item.released',
  'item.completed',
  'item.sentBack',
  'item.workStopped',
]);

export function EventRow({
  wid,
  event,
  title,
  project,
  agent,
  fresh,
  showProject = true,
  detail,
  progress,
  now,
}: {
  wid: string;
  event: Row<HiveEvent>;
  title: string | null;
  project?: Project;
  agent?: Row<Agent>;
  fresh?: boolean;
  showProject?: boolean;
  detail?: EventDetail;
  /** The run's progress calls, newest first, folded into this row. */
  progress?: Row<HiveEvent>[];
  now: number;
}) {
  const e = event.data;
  const [open, setOpen] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const ms = e.at.toMillis();
  const sentence = eventSentence(e, title);
  const hasRun = Boolean(e.runId) && (e.type.startsWith('run.') || RUN_ITEM_EVENTS.has(e.type));
  const live = (e.type === 'run.started' || e.type === 'item.claimed') && now - ms < 3_600_000;
  // A deleted item has nothing left to open.
  const canOpen =
    Boolean(e.projectId && e.itemId && project) && !(e.type === 'item.deleted' && e.data.forever);
  return (
    <motion.li
      initial={fresh ? { opacity: 0, y: -12 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={cn(
        'px-3 py-1.5 sm:px-4',
        fresh && 'drop-in-highlight',
        'border-t border-line first:border-t-0',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5">
          {e.actor.type === 'agent' ? (
            <AgentAvatar
              name={e.actor.name || 'Agent'}
              color={agent ? colorIndex(agent.data.color, agent.id) : colorIndex('', e.actor.id)}
              size="sm"
            />
          ) : (
            <Avatar name={e.actor.name || '?'} size="sm" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-14 text-ink">
            {canOpen && e.projectId && e.itemId ? (
              <Link
                to="/p/$pid"
                params={{ pid: e.projectId }}
                search={{ item: e.itemId }}
                className="rounded-sm hov:underline hov:underline-offset-4 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
              >
                {sentence}
              </Link>
            ) : (
              sentence
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-13 text-text-2">
            <time dateTime={new Date(ms).toISOString()}>{clock(ms)}</time>
            {showProject && project ? (
              <span>
                · {project.emoji} {project.name}
              </span>
            ) : null}
            {e.actor.type === 'agent' ? <span>· agent</span> : null}
          </p>
          {detail?.note ? (
            <p className="mt-1 break-words text-14 text-text-2">“{detail.note}”</p>
          ) : null}
          {detail?.facts ? (
            <p className="mt-0.5 break-words text-13 text-text-2">{detail.facts}</p>
          ) : null}
          {detail?.files.length ? (
            <ul aria-label="Attachments" className="mt-1.5 flex flex-wrap gap-1.5">
              {detail.files.map((f) => (
                <li
                  key={f.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-0.5 text-12 text-ink"
                >
                  {f.name}
                  {isNewAttachment(f.at, now) ? (
                    <span className="rounded-full border border-agent bg-agent-soft px-1.5 text-12 font-semibold text-ink">
                      new
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {progress?.length ? (
            <div>
              <button
                type="button"
                aria-expanded={showProgress}
                onClick={() => setShowProgress((v) => !v)}
                className="inline-flex min-h-11 items-center gap-1 text-13 text-text-2 underline underline-offset-4 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
              >
                <Icon icon={showProgress ? ChevronDown : ChevronRight} size={14} />
                {progressSummary(progress)}
              </button>
              {showProgress ? (
                <ul
                  aria-label="Progress"
                  className="mb-1 ml-5 flex flex-col gap-0.5 text-13 text-text-2"
                >
                  {progress.map((p) => (
                    <li key={p.id}>
                      <time dateTime={new Date(p.data.at.toMillis()).toISOString()}>
                        {clock(p.data.at.toMillis())}
                      </time>
                      {' · '}
                      {progressText(p.data.data)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {hasRun ? (
            <div className="flex flex-wrap items-center gap-x-4">
              {hasRun ? (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setOpen((v) => !v)}
                  className="inline-flex min-h-11 items-center gap-1 text-13 font-medium text-ink underline underline-offset-4 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
                >
                  <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
                  {open ? 'Hide log' : 'Show log'}
                </button>
              ) : null}
            </div>
          ) : null}
          {open && e.runId ? (
            <div className="mt-1">
              <RunLog wid={wid} runId={e.runId} live={live} />
            </div>
          ) : null}
        </div>
      </div>
    </motion.li>
  );
}
