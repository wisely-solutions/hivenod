import {
  MAX_STOP_REASON_CHARS,
  stopGateFor,
  stopWork,
  type Item,
  type Project,
  type StopMode,
} from '@hive/shared';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { Button } from '../ui/button';
import { RadioCards, Textarea } from '../ui/form';
import { useToast } from '../ui/overlay';
import { ResponsiveModal } from './ResponsiveModal';

/**
 * "Stop this work?" (card BrK0r2FE, draft dialog.png): asks what the person wants. Go back ends
 * the run and holds the item at its step until someone presses Resume; Cancel completely ends the
 * run and stops the item for good. An optional reason is shown on the item and in Activity.
 * A dialog on desktop, a bottom sheet on phones.
 */
export function StopWorkDialog({
  open,
  onOpenChange,
  project,
  projectId,
  itemId,
  item,
  agentName,
  run,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  projectId: string;
  itemId: string;
  item: Item;
  agentName: string;
  /** The claimed run as last seen (its cost counts on the item; an ended one is left alone). */
  run: { costEur: number; endedAt: unknown } | null;
}) {
  return open ? (
    <Body
      onOpenChange={onOpenChange}
      project={project}
      projectId={projectId}
      itemId={itemId}
      item={item}
      agentName={agentName}
      run={run}
    />
  ) : (
    <ResponsiveModal open={false} onOpenChange={onOpenChange} title="" />
  );
}

function Body({
  onOpenChange,
  project,
  projectId,
  itemId,
  item,
  agentName,
  run: claimedRun,
}: Omit<Parameters<typeof StopWorkDialog>[0], 'open'>) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [mode, setMode] = useState<StopMode>('back');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = project.steps.find((s) => s.id === item.stepId);
  const stepName = step?.name ?? 'its step';
  const tooLong = reason.trim().length > MAX_STOP_REASON_CHARS;

  async function confirm() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx || tooLong) return;
    setBusy(true);
    setError(null);
    try {
      await run(
        stopWork(ctx, {
          project,
          projectId,
          itemId,
          item,
          mode,
          reason: reason.trim(),
          gateStepId: stopGateFor(project, session.me.uid, session.isAdmin),
          run: claimedRun,
        }),
      );
      toast.push({
        message:
          mode === 'back'
            ? `Work stopped. The item is on hold at ${stepName}.`
            : 'Work stopped. Item cancelled.',
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not stop it. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={() => onOpenChange(false)}>
        Keep working
      </Button>
      <Button variant="sendback" loading={busy} disabled={tooLong} onClick={confirm}>
        Stop work
      </Button>
    </>
  );

  return (
    <ResponsiveModal
      open
      onOpenChange={onOpenChange}
      title="Stop this work?"
      description={`${agentName} is working on “${item.title}”. What do you want?`}
      footer={footer}
    >
      <div className="flex flex-col gap-4">
        <RadioCards
          label="What happens to the item"
          value={mode}
          onValueChange={(v) => setMode(v as StopMode)}
          options={[
            {
              value: 'back',
              title: 'Go back',
              description: `Run ends. Item returns to ${stepName}, on hold until someone presses Resume.`,
            },
            {
              value: 'cancel',
              title: 'Cancel completely',
              description: 'Run ends. Item is stopped for good, like a reject.',
            },
          ]}
        />
        <div>
          <Textarea
            label="Reason (optional, shown on the item)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            hint={mode === 'back' ? 'The next agent run reads this too.' : undefined}
          />
          {tooLong ? (
            <p className="mt-1 text-13 text-sendback">
              Keep it under {MAX_STOP_REASON_CHARS} characters.
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-13 text-sendback">
            {error}
          </p>
        ) : null}
      </div>
    </ResponsiveModal>
  );
}
