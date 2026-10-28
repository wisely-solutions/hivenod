import { decisionSchema, sendBack, type Item, type Project } from '@hive/shared';
import { skips } from '@hive/shared';
import { collection, query, where } from 'firebase/firestore';
import { waitedMs } from '../insights/logic';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { insightLine, MIN_REASON, mostCommonTarget, quickTags } from '../board/sendback';
import { db } from '../lib/db';
import { useLiveQuery } from '../lib/live';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Stepper } from '../ui/feedback';
import { Textarea } from '../ui/form';
import { motion, spring, useReducedMotion } from '../ui/motion';
import { useToast } from '../ui/overlay';
import { ResponsiveModal } from './ResponsiveModal';

/**
 * "Send '<title>' back": a vertical stepper of the earlier steps (plus Stop), a required reason with
 * quick tags, and an insight line. A dialog on desktop, a bottom sheet on phones.
 */
export function SendBackDialog({
  open,
  onOpenChange,
  project,
  projectId,
  itemId,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  projectId: string;
  itemId: string;
  item: Item;
}) {
  // The body owns the form state, so it renders the modal and passes the buttons as the pinned footer.
  return open ? (
    <Body
      open={open}
      onOpenChange={onOpenChange}
      project={project}
      projectId={projectId}
      itemId={itemId}
      item={item}
      onDone={() => onOpenChange(false)}
    />
  ) : (
    <ResponsiveModal open={false} onOpenChange={onOpenChange} title="" />
  );
}

function Body({
  open,
  onOpenChange,
  project,
  projectId,
  itemId,
  item,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  projectId: string;
  itemId: string;
  item: Item;
  onDone: () => void;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const reduced = useReducedMotion();
  const wid = session.workspaceId;
  const past = useLiveQuery(
    `sendback-history:${wid}:${projectId}:${item.stepId}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/projects/${projectId}/decisions`),
        where('stepId', '==', item.stepId),
      ),
    decisionSchema,
  );
  const history = useMemo(
    () => (past.state === 'ready' ? past.data.map((r) => r.data) : []),
    [past],
  );
  // Only steps on the item's path (card st5INNZj): a skipped step is no place to send it.
  const steps = project.steps.filter((s) => !skips(item, s));
  const index = steps.findIndex((s) => s.id === item.stepId);
  const current = steps[index];
  const order = steps.map((s) => s.id);
  const mostCommon = mostCommonTarget(history, item.stepId, order);
  const common = mostCommon && order.includes(mostCommon) ? mostCommon : null;
  const [picked, setPicked] = useState<string | null>(null);
  const target = picked ?? common ?? steps[index - 1]?.id ?? 'stop';
  const [reason, setReason] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = reason.trim().length;
  const valid = trimmed >= MIN_REASON;
  const stop = target === 'stop';
  const targetName = steps.find((s) => s.id === target)?.name ?? '';
  const insight = insightLine(history, item.stepId, current?.name ?? '', tags, new Date());

  async function confirm() {
    const ctx = actionContext(wid);
    if (!ctx || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const plan = sendBack(ctx, {
        project,
        projectId,
        itemId,
        item,
        toStepId: target,
        rationale: reason.trim(),
        tags,
        waitedMs: waitedMs(item),
      });
      await run(plan);
      toast.push({
        message: !plan.moved
          ? 'Your vote is recorded. The item moves when most deciders agree.'
          : stop
            ? 'Item stopped.'
            : `Sent back to ${targetName}.`,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      {!valid ? (
        <p className="text-13 text-text-2 sm:mr-auto">
          Add a reason of at least {MIN_REASON} characters to continue.
        </p>
      ) : null}
      <Button variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      <Button variant="sendback" loading={busy} disabled={!valid} onClick={confirm}>
        {stop ? 'Stop item' : `Send back to ${targetName}`}
      </Button>
    </>
  );

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Send '${item.title}' back`}
      description="Pick where it goes back to, and say why. The next agent reads your reason."
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        <Stepper
          label="Send back to"
          steps={steps.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            kind: s.kind,
            tag: s.id === common ? 'most common' : undefined,
          }))}
          currentIndex={index}
          value={target}
          onChange={setPicked}
          stop={{
            name: 'Stop: archive, don’t retry',
            description: 'The item leaves the flow. No agent picks it up.',
          }}
        />
        <div>
          <Textarea
            label="Why?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby="sendback-count"
            hint="Required. The next agent run reads this."
          />
          <p
            id="sendback-count"
            className={cn('mt-1 text-13 tabular-nums', valid ? 'text-text-2' : 'text-sendback')}
          >
            {trimmed} / {MIN_REASON} characters minimum
          </p>
          <div role="group" aria-label="Quick tags" className="mt-2 flex flex-wrap gap-2">
            {quickTags(history).map((t) => {
              const on = tags.includes(t);
              return (
                <motion.button
                  key={t}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setTags(on ? tags.filter((x) => x !== t) : [...tags, t])}
                  animate={on && !reduced ? { scale: [0.92, 1.08, 1] } : { scale: 1 }}
                  transition={spring.ui}
                  className={cn(
                    'min-h-11 rounded-full border px-3 text-13 foc:outline-2 foc:outline-focus',
                    on
                      ? 'border-sendback bg-sendback-bg text-sendback'
                      : 'border-line bg-surface text-text-2 hov:border-line-strong',
                  )}
                >
                  {t}
                </motion.button>
              );
            })}
          </div>
        </div>
        {insight ? <p className="text-13 text-text-2">{insight}</p> : null}
        {error ? (
          <p role="alert" className="text-13 text-sendback">
            {error}
          </p>
        ) : null}
      </div>
    </ResponsiveModal>
  );
}
