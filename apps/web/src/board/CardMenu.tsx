import { isOnHold, isWorkStoppable, resumeWork, stopGateFor, type Item } from '@hive/shared';
import { MoreHorizontal, Play, Square } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useReady } from '../auth/context';
import { useIsPhone } from '../components/ResponsiveModal';
import { StopWorkDialog } from '../components/StopWorkDialog';
import type { Row } from '../lib/live';
import { useShellData } from '../shell/data';
import { IconButton } from '../ui/button';
import { Icon } from '../ui/icon';
import { ActionMenu, LongPressMenu, type MenuAction } from '../ui/menu';
import { useItemActions } from './itemActions';
import type { CardContext } from './logic';

/**
 * Quick menu on a board card (card Tfvq6A6g): Stop work and Resume without opening the item, plus
 * Archive and Delete… (card rHjaDFEK, `useItemActions`).
 * A "..." button on desktop, a long press on phones (right-click too). Same rules as the item
 * panel: `stopGateFor` decides who may (admins, deciders of a gate), `isWorkStoppable` / `isOnHold`
 * what applies; nobody else sees a menu at all. The card itself stays a plain button, so drag and
 * drop (the grip beside it) and opening the item are untouched.
 */
export function CardMenu({
  row,
  ctx,
  pid,
  children,
}: {
  row: Row<Item>;
  ctx: CardContext;
  pid: string;
  /** Gets the padding class it needs for the "..." button. */
  children: (pad: string) => ReactNode;
}) {
  const { session, actionContext, run } = useReady();
  const { runs } = useShellData();
  const phone = useIsPhone();
  const [stopOpen, setStopOpen] = useState(false);
  const item = row.data;
  const gate = stopGateFor(ctx.project, session.me.uid, session.isAdmin);
  const stoppable = gate !== null && isWorkStoppable(ctx.project, item);
  const resumable = gate !== null && isOnHold(item);
  const more = useItemActions({ pid, itemId: row.id, item });
  if (!stoppable && !resumable && more.actions.length === 0) return <>{children('')}</>;

  const actions: MenuAction[] = [
    ...(stoppable
      ? [
          {
            id: 'stop',
            label: 'Stop work',
            icon: Square,
            tone: 'danger' as const,
            onSelect: () => setStopOpen(true),
          },
        ]
      : []),
    ...(resumable
      ? [
          {
            id: 'resume',
            label: 'Resume',
            icon: Play,
            onSelect: () => {
              const c = actionContext(session.workspaceId);
              if (!c) return;
              void run(resumeWork(c, { projectId: pid, itemId: row.id, item, gateStepId: gate }));
            },
          },
        ]
      : []),
    ...more.actions,
  ];
  const label = `Actions for ${item.title}`;
  const agent = item.claim ? ctx.agents.find((a) => a.id === item.claim?.agentUid) : undefined;
  const claimedRun = item.claim ? runs.find((r) => r.id === item.claim?.runId) : undefined;

  return (
    <>
      <LongPressMenu
        label={label}
        actions={actions}
        className="relative [-webkit-touch-callout:none]"
      >
        {children(phone ? '' : 'pr-10')}
        {phone ? null : (
          <div className="absolute right-1 top-1">
            <ActionMenu
              label={label}
              actions={actions}
              trigger={
                <IconButton label={label} className="size-9! text-text-2" data-testid="card-menu">
                  <Icon icon={MoreHorizontal} size={16} />
                </IconButton>
              }
            />
          </div>
        )}
      </LongPressMenu>
      {more.dialog}
      {stoppable ? (
        <StopWorkDialog
          open={stopOpen}
          onOpenChange={setStopOpen}
          project={ctx.project}
          projectId={pid}
          itemId={row.id}
          item={item}
          agentName={agent?.data.name ?? 'Removed agent'}
          run={
            claimedRun
              ? { costEur: claimedRun.data.costEur, endedAt: claimedRun.data.endedAt }
              : null
          }
        />
      ) : null}
    </>
  );
}
