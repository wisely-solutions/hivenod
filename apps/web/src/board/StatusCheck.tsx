/**
 * Status checks (item AzveC): the agent's last status line and the "No update" flag on an item it
 * works, and "Ask for status" for anyone on the project. The ask goes to the holder's session at
 * once (the same status event as the periodic one); at most once per 2 minutes per item.
 */
import { askForStatus, STATUS_ASK_EVERY_MS, statusAskOf, type Item } from '@hive/shared';
import { Clock, MessageCircleQuestion } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useReady } from '../auth/context';
import { Pill } from '../ui/badge';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import type { MenuAction } from '../ui/menu';
import { useToast } from '../ui/overlay';
import { useNow } from '../activity/data';
import { askStatusState, statusView, type AskState } from './logic';

/** Sends the ask; `pending` covers the moment before the item's snapshot shows it. */
export function useAskStatus(pid: string, itemId: string, item: Item, now: number) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [pendingAt, setPendingAt] = useState<number | null>(null);
  const base = askStatusState(item, now);
  const pending = pendingAt !== null && now - pendingAt < STATUS_ASK_EVERY_MS && !statusAskOf(item);
  const state: AskState = pending
    ? { show: base.show, disabled: true, label: 'Asked · waiting…' }
    : base;
  const ask = useCallback(() => {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    let p;
    try {
      p = askForStatus(ctx, { projectId: pid, itemId, item, nowMs: Date.now() });
    } catch (e) {
      toast.push({ message: (e as Error).message });
      return;
    }
    setPendingAt(Date.now());
    run(p).then(
      () => toast.push({ message: 'Asked the agent for a status.' }),
      () => {
        setPendingAt(null);
        toast.push({ message: 'Could not ask for a status. Try again in a moment.' });
      },
    );
  }, [actionContext, session.workspaceId, pid, itemId, item, run, toast]);
  const menuAction: MenuAction | null = state.show
    ? {
        id: 'ask-status',
        label: state.label,
        icon: MessageCircleQuestion,
        disabled: state.disabled,
        onSelect: ask,
      }
    : null;
  return { state, ask, menuAction };
}

/** The status line, the silence flag and the button, for the item view. */
export function StatusCheck({ pid, itemId, item }: { pid: string; itemId: string; item: Item }) {
  const now = useNow(10_000);
  const view = statusView(item, now);
  const { state, ask } = useAskStatus(pid, itemId, item, now);
  if (!view.status && !view.silence && !state.show) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="status-check">
      {view.status ? (
        <p className="min-w-0 text-13 text-text-2">
          <span className="font-medium text-ink">Status:</span>{' '}
          <span data-testid="status-line">{view.status}</span>
        </p>
      ) : null}
      {view.silence ? (
        <Pill tone="sendback" data-testid="silence-flag">
          <Icon icon={Clock} size={12} />
          {view.silence}
        </Pill>
      ) : null}
      {state.show ? (
        <Button
          variant="secondary"
          className="min-h-9 px-3 text-13"
          leading={<Icon icon={MessageCircleQuestion} size={14} />}
          disabled={state.disabled}
          onClick={ask}
          data-testid="ask-status"
        >
          {state.label}
        </Button>
      ) : null}
    </div>
  );
}
