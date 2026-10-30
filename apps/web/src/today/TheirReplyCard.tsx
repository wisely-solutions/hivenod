/**
 * Today's card for a Their reply draft: the message the agent wrote to someone outside Hivenod
 * (the first ask, a follow-up or a reminder) waits for the member's approval. Same actions as the
 * decision page (usePlanActions: approveAsk, markDone); nothing is sent before Approve & send.
 * Keys A and E act on it as on any card; Not now and Open sit beside the buttons.
 */
import {
  planView,
  theirReplyView,
  type InboxPlan,
  type PlanInput,
  type SendBackOf,
} from '@hive/shared';
import { Check, ExternalLink, MessageSquareQuote } from 'lucide-react';
import { forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import type { Row } from '../lib/live';
import { usePlanActions } from '../threads/usePlanActions';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import { UndoButton } from '../ui/UndoButton';
import { Key } from '../components/DecisionBar';
import type { DecisionCardHandle, DecisionCardProps } from './DecisionCard';
import { theirDraftText } from './logic';

export const TheirReplyCard = forwardRef<
  DecisionCardHandle,
  {
    props: DecisionCardProps;
    plan: Row<InboxPlan>;
    pl: PlanInput & { plan: SendBackOf };
    outcomeId: string;
    extra?: ReactNode;
  }
>(function TheirReplyCard({ props, plan, pl, outcomeId, extra }, ref) {
  const { entry, now } = props;
  const thread = entry.thread!;
  const acts = usePlanActions(entry.wid, thread, pl, props.onDone);
  const o = pl.outcomes[outcomeId]!;
  const v = theirReplyView(o, now);
  const view = planView(pl.plan, pl.outcomes);
  const s = view.steps.find((x) => x.outcomeId === outcomeId);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const label =
    v?.ask?.kind === 'follow_up' ? 'follow-up' : v?.ask?.kind === 'nudge' ? 'reminder' : 'ask';
  const ready = !!v && !!s && v.phase === 'approve';
  const approve = () => {
    if (!ready || !s || acts.counting) return;
    acts.approveAsk(s, label.charAt(0).toUpperCase() + label.slice(1), editing ? text : undefined);
    setEditing(false);
  };
  const edit = () => {
    if (!v?.ask || editing) return;
    setText(v.ask.text);
    setEditing(true);
  };
  useImperativeHandle(ref, () => ({ approve, edit, reject: () => undefined }));
  if (!v || !s) return null;
  const t = theirDraftText(v, { number: s.number, total: view.total });
  return (
    <div
      data-their-card=""
      data-plan={plan.id}
      className="mt-3 rounded-card border-2 border-external/60 bg-surface p-3.5 sm:p-4"
    >
      <span
        data-their-tag=""
        className="inline-flex items-center gap-1 rounded-full border border-external/40 bg-external-bg px-2 py-0.5 text-12 font-semibold text-external"
      >
        <Icon icon={MessageSquareQuote} size={12} />
        {t.tag}
      </span>
      <h3 className="mt-2 text-16 font-semibold leading-snug text-ink [overflow-wrap:anywhere]">
        {t.question}
      </h3>
      <p className="mt-1 text-13 text-text-2 [overflow-wrap:anywhere]">{t.sub}</p>
      <div className="mt-2.5 rounded-btn border border-line bg-canvas p-3">
        {editing ? (
          <Textarea
            label={`Message to ${v.who}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <p
            data-their-ask=""
            className="whitespace-pre-wrap text-14 text-ink [overflow-wrap:anywhere]"
          >
            {v.ask?.text}
          </p>
        )}
      </div>
      {acts.error ? (
        <p role="alert" className="mt-3 text-14 text-sendback">
          {acts.error}
        </p>
      ) : null}
      <div className={cn('mt-3 flex flex-wrap items-center gap-2')}>
        {acts.counting ? (
          <UndoButton countdown={acts.counting} variant="approve" />
        ) : (
          <>
            <Button
              variant="approve"
              data-their-approve=""
              onClick={approve}
              leading={<Icon icon={Check} size={16} />}
            >
              Approve &amp; send
              <Key>A</Key>
            </Button>
            {!editing ? (
              <Button variant="secondary" data-their-edit="" onClick={edit}>
                Edit
                <Key>E</Key>
              </Button>
            ) : null}
            {t.canMarkDone ? (
              <Button variant="secondary" data-their-done="" onClick={() => acts.markDone(s)}>
                Mark done
              </Button>
            ) : null}
            {extra}
            <Button
              variant="secondary"
              onClick={props.onOpen}
              leading={<Icon icon={ExternalLink} size={15} />}
            >
              Open
            </Button>
            <Button variant="ghost" className="ml-auto max-sm:hidden" onClick={props.onSkip}>
              Skip
              <Key>S</Key>
            </Button>
          </>
        )}
      </div>
    </div>
  );
});
