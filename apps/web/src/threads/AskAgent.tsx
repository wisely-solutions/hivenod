/**
 * Ask the agent (item w6O2KOw4ys70TQv9I1xD): on any thread, the member asks its home agent
 * something, as free text (500 characters, ⌘↵ sends) or a quick chip. Only the chips that fit
 * the thread now are shown (at most 3, the agent's suggestions first; packages/shared/src/
 * chips.ts). Re-check is the Re-check request; the others are instructions. Sending counts down on
 * the pressed button with Undo (5 s) before it is written; then "Asked · <agent> is on it", then
 * the answer under the request (the note itself, or a link to the question, proposal or plan).
 */
import {
  agentSchema,
  cliSupports,
  contextChips,
  INBOX_LIMITS,
  INSTRUCT_CHIP_LABELS,
  instructPending,
  instructThread,
  minVersionFor,
  outcomeType,
  paths,
  type InboxInstruction,
  type InboxMessage,
  type InboxOutcome,
  type InboxThread,
  type InstructChip,
} from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Loader2, Send, Sparkles, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { useReady } from '../auth/context';
import { Key } from '../components/DecisionBar';
import { useLiveDoc, type Row } from '../lib/live';
import { stash } from '../lib/pendingDecisions';
import { hhmm } from '../today/logic';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { Dialog, useCountdown, useToast, type Countdown } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { useThread } from './data';
import { errorText } from './parts';
import { planLive } from './plan';
import { useRecheck, type RecheckState } from './Recheck';

const MAX = INBOX_LIMITS.instruction;

/** The countdown key of a thread's instruction. */
export const instructKey = (wid: string, tid: string) => `in:${wid}:${tid}`;

export interface InstructState {
  counting: Countdown | undefined;
  pending: boolean;
  can: boolean;
  send: (what: { text?: string; chip?: string }, tag: string, onSent?: () => void) => void;
}

export function useInstruct(
  wid: string,
  thread: Row<InboxThread>,
  now: number,
  onError?: (msg: string) => void,
): InstructState {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const key = instructKey(wid, thread.id);
  const counting = useCountdown(key);
  const pending = instructPending(thread.data, now);
  const can = !pending && !counting;
  function send(what: { text?: string; chip?: string }, tag: string, onSent?: () => void) {
    const ctx = actionContext(wid);
    if (!ctx || !can) return;
    let plan;
    try {
      plan = instructThread(ctx, {
        threadId: thread.id,
        thread: { ...thread.data },
        text: what.text ?? null,
        chip: what.chip ?? null,
        nowMs: now,
      });
    } catch (e) {
      onError?.(errorText(e));
      return;
    }
    const forget = stash(session.me.uid, wid, [plan.ops], 'Saved: asked the agent');
    const p = plan;
    onSent?.();
    toast.push({
      message: 'Asked',
      duration: 5000,
      countdown: { key, tag, announce: 'Asked the agent. Undo available for 5 seconds' },
      onUndo: forget,
      onCommit: () => {
        run(p).then(
          () => forget(),
          (e: unknown) => {
            forget();
            onError?.(errorText(e));
          },
        );
      },
    });
  }
  return { counting, pending, can, send };
}

/** The member's latest instruction, if any. */
function latest(t: InboxThread): [string, InboxInstruction] | null {
  const all = Object.entries(t.instructions ?? {});
  if (!all.length) return null;
  all.sort(
    ([a, x], [b, y]) => (x.at?.toMillis() ?? 0) - (y.at?.toMillis() ?? 0) || (a < b ? -1 : 1),
  );
  return all[all.length - 1]!;
}

const asked = (i: Pick<InboxInstruction, 'text' | 'chip'>) =>
  i.chip ? INSTRUCT_CHIP_LABELS[i.chip] : (i.text ?? '');

/** "Asked · <agent> is on it", then the answer under the request. */
function InstructLine({
  wid,
  thread,
  now,
  agent,
  outcomes,
}: {
  wid: string;
  thread: Row<InboxThread>;
  now: number;
  agent: string;
  outcomes: readonly Row<InboxOutcome>[];
}) {
  const t = thread.data;
  const last = latest(t);
  const pending = instructPending(t, now);
  const home = useLiveDoc(pending ? paths.agent(wid, t.fetchedBy) : null, agentSchema);
  const have = home.state === 'ready' ? home.data?.cliVersion : undefined;
  const old =
    pending && home.state === 'ready' && !!home.data && cliSupports('instruct', have) === 'old';
  if (!last) return null;
  const [, ins] = last;
  if (pending && ins.state === 'pending')
    return (
      <div className="mt-3">
        <p
          data-instructing=""
          role="status"
          className="flex items-start gap-2 rounded-btn border border-dashed border-agent/50 bg-surface px-3 py-2 text-13 text-agent [overflow-wrap:anywhere]"
        >
          <Icon icon={Loader2} size={15} className="mt-0.5 shrink-0 motion-safe:animate-spin" />
          <span className="min-w-0">
            <span className="font-semibold">Asked · {agent} is on it</span>
            <span className="text-text-2"> · {asked(ins)}</span>
          </span>
        </p>
        {old ? (
          <p
            data-cli-old=""
            className="mt-2 flex items-start gap-2 rounded-btn border border-gate bg-gate-bg px-3 py-2 text-13 text-gate-text [overflow-wrap:anywhere]"
          >
            <Icon icon={TriangleAlert} size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0">
              {agent} needs a Hivenod update to do this (it runs {have}; this needs{' '}
              {minVersionFor('instruct')}). Ask its owner to run <code>hivenod update</code> and
              restart the session.
            </span>
          </p>
        ) : null}
      </div>
    );
  const a = ins.answer;
  if (ins.state !== 'answered' || !a) return null;
  const ref = a.refId ? outcomes.find((o) => o.id === a.refId) : undefined;
  const label = ref ? (outcomeType(ref.data.type)?.label ?? ref.data.type) : null;
  const link =
    a.kind === 'ask'
      ? { text: 'See the question', hash: 'agent-asks' }
      : a.kind === 'outcome'
        ? { text: label ? `See the proposal (${label})` : 'See the proposal', hash: 'proposed' }
        : a.kind === 'plan'
          ? { text: 'See the plan', hash: 'plan' }
          : null;
  return (
    <div
      data-instruct-answer={a.kind}
      className="mt-3 rounded-btn bg-canvas px-3 py-2 text-13 [overflow-wrap:anywhere]"
    >
      <p className="text-text-2">
        You asked: <span className="italic">{asked(ins)}</span>
      </p>
      <p className="mt-1 flex items-start gap-2 text-ink">
        <Icon icon={Sparkles} size={14} className="mt-0.5 shrink-0 text-agent" />
        <span className="min-w-0">
          <span className="font-medium">
            {agent} answered{a.at ? ` ${hhmm(new Date(a.at.toMillis()))}` : ''}
          </span>
          {a.note ? <span className="whitespace-pre-wrap"> · {a.note}</span> : null}
          {link ? (
            <>
              {' · '}
              <Link
                to="/inbox/$wid/t/$tid"
                params={{ wid, tid: thread.id }}
                hash={link.hash}
                data-answer-link=""
                className="inline-flex items-center gap-1 font-medium text-agent underline-offset-2 hov:underline foc:outline-2 foc:outline-focus"
              >
                {link.text}
                <Icon icon={ArrowRight} size={13} />
              </Link>
            </>
          ) : null}
        </span>
      </p>
    </div>
  );
}

export interface AskAgentProps {
  wid: string;
  thread: Row<InboxThread>;
  outcomes: readonly Row<InboxOutcome>[];
  /** Oldest first; undefined: not loaded (no Summarize or Draft a reply). */
  messages?: readonly InboxMessage[];
  livePlan?: boolean;
  staleStep?: boolean;
  now: number;
  agent: string;
  /** Shared with the proposal's Re-check, so one countdown shows on whichever was pressed. */
  rc?: RecheckState;
  onSent?: () => void;
}

/** The "Ask the agent…" box with the chips that fit the thread now. */
export function AskAgent(props: AskAgentProps) {
  const { wid, thread, outcomes, messages, now, agent } = props;
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ins = useInstruct(wid, thread, now, setError);
  const own = useRecheck(wid, thread, now, setError);
  const rc = props.rc ?? own;
  const chips = contextChips({
    thread: thread.data,
    outcomes: outcomes.map((o) => o.data),
    messages,
    livePlan: props.livePlan,
    staleStep: props.staleStep,
    canRecheck: rc.can || rc.counting?.tag === 'chip-recheck',
    nowMs: now,
  });
  const trimmed = text.trim();
  const canSend = ins.can && trimmed.length > 0 && trimmed.length <= MAX;
  const sendText = () => {
    if (!canSend) return;
    ins.send({ text: trimmed }, 'send', () => {
      setText('');
      setError(null);
      props.onSent?.();
    });
  };
  const pressChip = (c: InstructChip) => {
    if (c === 'recheck') {
      rc.request('chip-recheck');
      return;
    }
    ins.send({ chip: c }, `chip-${c}`, () => {
      setError(null);
      props.onSent?.();
    });
  };
  const chipUndo = (c: InstructChip) =>
    c === 'recheck'
      ? rc.counting?.tag === 'chip-recheck'
        ? rc.counting
        : undefined
      : ins.counting?.tag === `chip-${c}`
        ? ins.counting
        : undefined;
  return (
    <div data-ask-agent="">
      {chips.length ? (
        <div role="group" aria-label="Quick asks" className="mb-2.5 flex flex-wrap gap-2">
          {chips.map((c) => {
            const undo = chipUndo(c);
            if (undo)
              return (
                <UndoButton key={c} countdown={undo} variant="secondary" className="min-h-9" />
              );
            const off = c === 'recheck' ? !rc.can : !ins.can;
            return (
              <button
                key={c}
                type="button"
                data-ask-chip={c}
                disabled={off}
                onClick={() => pressChip(c)}
                className={cn(
                  'inline-flex min-h-9 items-center gap-1.5 rounded-full border border-agent/40 bg-agent-soft px-3 text-13 font-medium text-agent transition-colors duration-120',
                  'hov:border-agent foc:outline-2 foc:outline-offset-2 foc:outline-focus disabled:opacity-50',
                )}
              >
                <Icon icon={Sparkles} size={13} />
                {INSTRUCT_CHIP_LABELS[c]}
              </button>
            );
          })}
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendText();
        }}
      >
        <label htmlFor={`${id}-ask`} className="sr-only">
          Ask {agent}
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id={`${id}-ask`}
            data-ask-box=""
            rows={2}
            value={text}
            maxLength={MAX + 50}
            disabled={ins.pending}
            aria-describedby={`${id}-count`}
            placeholder={`Ask ${agent}…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendText();
              }
            }}
            className={cn(
              'block min-h-16 min-w-0 flex-1 rounded-btn border border-line-strong bg-surface px-3 py-2 text-16 text-ink sm:text-15',
              'placeholder:text-text-3 foc:border-focus foc:outline-2 foc:outline-offset-0 foc:outline-focus disabled:opacity-60',
            )}
          />
          {ins.counting?.tag === 'send' ? (
            <UndoButton countdown={ins.counting} variant="primary" />
          ) : (
            <Button
              type="submit"
              variant="primary"
              disabled={!canSend}
              data-ask-send=""
              className="bg-agent! text-surface!"
              leading={<Icon icon={Send} size={15} />}
            >
              Ask
              <Key>⌘↵</Key>
            </Button>
          )}
        </div>
        <p
          id={`${id}-count`}
          className={cn(
            'mt-1 text-right text-12 tabular-nums',
            trimmed.length > MAX ? 'text-sendback' : 'text-text-2',
          )}
        >
          {text.length} / {MAX}
        </p>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-13 text-sendback [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
      <InstructLine wid={wid} thread={thread} now={now} agent={agent} outcomes={outcomes} />
    </div>
  );
}

/**
 * "Ask the agent…" from the Today card's Other menu: the box in a dialog, with the thread's
 * outcomes and messages loaded for the chips.
 */
export function AskAgentDialog({
  open,
  onOpenChange,
  wid,
  thread,
  now,
  agent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wid: string;
  thread: Row<InboxThread>;
  now: number;
  agent: string;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Ask ${agent}`}
      description={`About “${thread.data.title || 'this thread'}”. ${agent} answers here; anything it would send waits for your OK.`}
    >
      {open ? <DialogBody wid={wid} thread={thread} now={now} agent={agent} /> : null}
    </Dialog>
  );
}

function DialogBody({
  wid,
  thread,
  now,
  agent,
}: {
  wid: string;
  thread: Row<InboxThread>;
  now: number;
  agent: string;
}) {
  const { session } = useReady();
  const { thread: live, messages, outcomes, plans } = useThread(wid, thread.id, session.me.uid);
  const t: Row<InboxThread> =
    live.state === 'ready' && live.data ? { id: thread.id, data: live.data } : thread;
  const os = outcomes.state === 'ready' ? outcomes.data : [];
  const ms =
    messages.state === 'ready'
      ? [...messages.data]
          .sort((a, b) => a.data.receivedAt.toMillis() - b.data.receivedAt.toMillis())
          .map((m) => m.data)
      : undefined;
  const livePlan = plans.state === 'ready' && plans.data.some((p) => planLive(p.data.state));
  return (
    <AskAgent
      wid={wid}
      thread={t}
      outcomes={os}
      messages={ms}
      livePlan={livePlan}
      now={now}
      agent={agent}
    />
  );
}
