import { approve, nextOnPath, skips, type Item, type Project } from '@hive/shared';
import { useEffect, useRef, useState } from 'react';
import { takePastedFiles, useAddFiles } from '../board/ItemEdit';
import { waitedMs } from '../insights/logic';
import { stash } from '../lib/pendingDecisions';
import { useReady } from '../auth/context';
import { needsMyDecision } from '../shell/logic';
import { Button } from '../ui/button';
import { useCountdown, useToast } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { SendBackDialog } from './SendBackDialog';
import { BarNote, DecisionBar, Key } from './DecisionBar';
import { gateRuleLine, type InboxEntry } from '../inbox/logic';
import { DecisionDialog } from '../inbox/DecisionDialog';
import { useDecide } from '../inbox/useDecide';
import { releasingMessage } from '../inbox/decision';
import { useShortcut } from '../shell/shortcuts';

const strip =
  'border-t border-line bg-surface px-4 py-3 text-14 text-text-2 pb-[max(12px,env(safe-area-inset-bottom))]';

/**
 * The decide panel for an item waiting at a gate: approve (with an optional note) or send back
 * (with a reason). Shared by the item detail and, later, the Needs-you inbox.
 */
export function DecidePanel({
  project,
  projectId,
  itemId,
  item,
  compact = false,
  onDecided,
}: {
  project: Project;
  projectId: string;
  itemId: string;
  item: Item;
  /** In the viewer's narrow side panel: a stacked bar. */
  compact?: boolean;
  /** Called when the approval is written (after the Undo window) while still on this item. */
  onDecided?: () => void;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [backOpen, setBackOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const { decide } = useDecide();
  const [mountedAt] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const { add: addFiles, error: fileError } = useAddFiles(projectId, itemId);
  // The latest callback and item, so a commit 5 s later acts on what is on screen then.
  const live = useRef({ onDecided, itemId });
  useEffect(() => {
    live.current = { onDecided, itemId };
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const index = project.steps.findIndex((s) => s.id === item.stepId);
  const step = project.steps[index];
  // The next step on the item's path (card st5INNZj): skipped steps are passed over.
  const next = step ? (nextOnPath(project, item) ?? undefined) : undefined;
  const earlier = project.steps.slice(0, Math.max(index, 0)).filter((s) => !skips(item, s));
  const mine = needsMyDecision(project, item, session.me.uid);
  const canDecide =
    mine && item.status !== 'suggested' && item.status !== 'done' && step?.kind === 'human';
  // The same keys as Needs you: A approves, R sends back.
  const rejectEntry: InboxEntry = {
    key: `a:${projectId}:${itemId}`,
    kind: 'approval',
    pid: projectId,
    itemId,
    project,
    item,
    since: mountedAt - waitedMs(item),
  };
  const counting = useCountdown(rejectEntry.key);
  useShortcut({
    id: 'decide:approve',
    keys: ['a'],
    label: 'Approve',
    group: 'Item',
    run: () => {
      if (canDecide && !busy && !counting) approveNow();
    },
  });
  useShortcut({
    id: 'decide:sendback',
    keys: ['r'],
    label: 'Send back',
    group: 'Item',
    run: () => {
      if (canDecide && earlier.length > 0) setBackOpen(true);
    },
  });
  if (item.status === 'suggested') {
    return (
      <p className={strip}>
        A suggestion from an agent. It is not work yet: add it to{' '}
        {project.steps[0]?.name ?? 'the first step'} or dismiss it from the suggestions on the board
        or in Needs you.
      </p>
    );
  }
  if (item.status === 'done') return null;
  if (!step || step.kind !== 'human') return null;
  if (!mine) {
    const decided =
      item.gate &&
      (session.me.uid in item.gate.approvals || session.me.uid in item.gate.rejections);
    return (
      <p className={strip}>
        {decided
          ? 'You have decided. Waiting for the others.'
          : item.status === 'stopped'
            ? 'Stopped.'
            : 'You are not a decider at this step.'}
      </p>
    );
  }
  /**
   * Like Needs you (card rLntxm7C): the approval waits 5 s behind an Undo toast and is written
   * when the toast ends, or when the person leaves the screen.
   */
  function approveNow() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setError(null);
    let p;
    try {
      p = approve(ctx, {
        project,
        projectId,
        itemId,
        item,
        rationale: note.trim(),
        waitedMs: waitedMs(item),
      });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not save. Try again.');
      return;
    }
    const final = p.advanced && !next;
    const message = !p.advanced
      ? 'Approved.'
      : next
        ? `Approved. Moved to ${next.name}.`
        : `Released. \u201c${item.title}\u201d is done.`;
    const plan = p;
    const forget = stash(
      session.me.uid,
      session.workspaceId,
      [plan.ops],
      `Saved your approval of \u201c${item.title}\u201d`,
    );
    toast.push({
      message: final ? releasingMessage(item.title) : message,
      undoLabel: 'Undo',
      duration: 5000,
      // The pressed Approve button counts down (card eLSSIGOs); no toast.
      countdown: {
        key: rejectEntry.key,
        tag: 'approve',
        announce: 'Approved. Undo available for 5 seconds',
      },
      onUndo: () => {
        forget();
        setBusy(false);
      },
      onCommit: () => {
        setBusy(true);
        // Move on like Needs you does, but only when the person is still looking at this item.
        // A final approval stays: the Done panel is what it shows.
        if (!final && mounted.current && live.current.itemId === itemId) live.current.onDecided?.();
        // Released shows at once, with the Done panel the write brings (not when the server answers).
        if (final) toast.push({ message });
        run(plan).then(
          () => {
            forget();
            setBusy(false);
            setNote('');
          },
          (e: unknown) => {
            forget();
            setBusy(false);
            setError(e instanceof Error && e.message ? e.message : 'Could not save. Try again.');
          },
        );
      },
    });
  }

  return (
    <>
      <DecisionBar
        compact={compact}
        label={`${step.name} \u00b7 you decide`}
        rule={gateRuleLine(step.gate)}
        note={
          <BarNote
            label="Your note (optional)"
            placeholder="Add a note (optional)"
            value={note}
            onChange={setNote}
            error={error ?? (fileError || undefined)}
            onPaste={(e) => takePastedFiles(e, (f) => void addFiles(f))}
          />
        }
      >
        {counting?.tag === 'approve' ? (
          <UndoButton countdown={counting} variant="approve" keyHint={<Key>Z</Key>} />
        ) : (
          <Button variant="approve" loading={busy} disabled={!!counting} onClick={approveNow}>
            {next ? `Approve \u2192 ${next.name}` : 'Approve'}
            <Key>A</Key>
          </Button>
        )}
        {earlier.length > 0 ? (
          <Button variant="sendback" disabled={!!counting} onClick={() => setBackOpen(true)}>
            Send back…
            <Key>R</Key>
          </Button>
        ) : null}
        {counting?.tag === 'reject' ? (
          <UndoButton countdown={counting} variant="sendback" keyHint={<Key>Z</Key>} />
        ) : (
          <Button variant="sendback" disabled={!!counting} onClick={() => setRejectOpen(true)}>
            Reject
          </Button>
        )}
      </DecisionBar>
      <DecisionDialog
        mode={rejectOpen ? 'reject' : null}
        entry={rejectEntry}
        onSubmit={(e, d) => {
          const problem = decide(e, d);
          if (!problem) setRejectOpen(false);
          return problem;
        }}
        onClose={() => setRejectOpen(false)}
      />
      <SendBackDialog
        open={backOpen}
        onOpenChange={setBackOpen}
        project={project}
        projectId={projectId}
        itemId={itemId}
        item={item}
      />
    </>
  );
}
