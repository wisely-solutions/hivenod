import type { Agent } from '@hive/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Bot, KeyRound, MoreHorizontal, Pencil, Plus, ShieldOff, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useReady } from '../auth/context';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import type { Row } from '../lib/live';
import { AgentAvatar } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { cn } from '../ui/cn';
import { EmptyState, Skeleton } from '../ui/feedback';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { Dialog, useToast } from '../ui/overlay';
import { revokeAgentFlow, rotateAgentFlow } from './flow';
import { agentStatus, colorIndex, statusText } from './logic';
import { NewAgentModal } from './NewAgentModal';
import { RemoveAgentDialog } from './RemoveAgentDialog';
import { RenameAgentDialog } from './RenameAgentDialog';
import { TokenDialog } from './TokenDialog';

interface Issued {
  name: string;
  token: string;
  rotated: boolean;
}

export function AgentsPage() {
  const { session, actionContext, run } = useReady();
  const { agents, loading, agentsKnown } = useShellData();
  const toast = useToast();
  const { isAdmin, workspaceId } = session;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Advanced: ?token=1 opens the plain-MCP form (the Connect page links here).
  const { agent: pickedAgent, token: wantToken } = useSearch({ strict: false }) as {
    agent?: string;
    token?: 1;
  };
  const navigate = useNavigate();
  const creating = !!wantToken && isAdmin;
  const closeCreating = () => void navigate({ to: '/agents', search: {}, replace: true });
  // The token is held here, in memory, only until the admin confirms they saved it.
  const [issued, setIssued] = useState<Issued | null>(null);
  const [revoking, setRevoking] = useState<Row<Agent> | null>(null);
  const [rotating, setRotating] = useState<Row<Agent> | null>(null);
  const [removing, setRemoving] = useState<Row<Agent> | null>(null);
  const [renaming, setRenaming] = useState<Row<Agent> | null>(null);
  const [busy, setBusy] = useState(false);

  const active = agents.filter((a) => !a.data.revokedAt);
  const revoked = agents.filter((a) => a.data.revokedAt);
  const ordered = [
    ...[...active].sort((a, b) => a.data.name.localeCompare(b.data.name)),
    ...[...revoked].sort((a, b) => b.data.revokedAt!.toMillis() - a.data.revokedAt!.toMillis()),
  ];

  const connectNew = () => void navigate({ to: '/agents/connect' });

  async function confirmRevoke() {
    const target = revoking;
    const ctx = actionContext(workspaceId);
    if (!target || !ctx) return;
    setBusy(true);
    try {
      await revokeAgentFlow(ctx, run, target.id);
      setRevoking(null);
      toast.push({ message: `${target.data.name} is revoked.` });
    } catch {
      toast.push({ message: 'Could not revoke. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function confirmRotate() {
    const target = rotating;
    const ctx = actionContext(workspaceId);
    if (!target || !ctx) return;
    setBusy(true);
    try {
      const token = await rotateAgentFlow(ctx, run, target.id, target.data);
      setRotating(null);
      setIssued({ name: target.data.name, token, rotated: true });
    } catch {
      toast.push({ message: 'Could not rotate the token. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle={
          agents.length
            ? `${active.length} active${revoked.length ? ` · ${revoked.length} revoked` : ''}`
            : undefined
        }
        action={
          isAdmin ? (
            <Button leading={<Icon icon={Plus} />} onClick={connectNew}>
              New agent
            </Button>
          ) : null
        }
      />

      {ordered.length === 0 && (loading || !agentsKnown) ? (
        <div role="status" aria-label="Loading agents" className="flex flex-col gap-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : ordered.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="No agents yet"
          description={
            isAdmin
              ? 'Connect a terminal running Claude Code. It picks up work from your Inbox threads.'
              : 'An admin creates agents. They show up here.'
          }
          action={
            isAdmin ? (
              <Button leading={<Icon icon={Plus} />} onClick={connectNew}>
                New agent
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul
          aria-label="Agents"
          className="overflow-hidden rounded-card border border-line bg-surface shadow-e1"
        >
          {ordered.map((a, i) => {
            const status = agentStatus(a.data, now);
            const isRevoked = status.kind === 'revoked';
            const prev = a.data.previousAgentUid
              ? agents.find((x) => x.id === a.data.previousAgentUid)
              : null;
            return (
              <li
                key={a.id}
                aria-label={a.data.name}
                aria-current={pickedAgent === a.id ? 'true' : undefined}
                ref={
                  pickedAgent === a.id ? (el) => el?.scrollIntoView({ block: 'center' }) : undefined
                }
                className={cn(
                  'flex flex-col gap-3 p-3.5 sm:flex-row sm:items-center',
                  pickedAgent === a.id && 'bg-agent-soft ring-2 ring-inset ring-focus',
                  i > 0 && 'border-t border-line',
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {/* A revoked agent is dimmed by its picture only: dimmed text would fail contrast. */}
                  <span className={cn('shrink-0', isRevoked && 'opacity-60')}>
                    <AgentAvatar
                      name={a.data.name}
                      color={colorIndex(a.data.color, a.id)}
                      live={status.kind === 'online'}
                      size="lg"
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2">
                      <Link
                        to="/agents/$id"
                        params={{ id: a.id }}
                        className="truncate text-14 font-medium text-ink underline-offset-4 hov:underline foc:outline-2 foc:outline-offset-2 foc:outline-focus"
                      >
                        {a.data.name}
                      </Link>
                      {isRevoked ? <Badge tone="sendback">Revoked</Badge> : null}
                      {!isRevoked && a.data.pausedAt ? <Badge tone="gate">Paused</Badge> : null}
                    </p>
                    {isRevoked ? null : (
                      <p
                        className={cn(
                          'truncate text-13',
                          status.kind === 'paused'
                            ? 'text-gate-text'
                            : status.kind === 'online'
                              ? 'text-approve-text'
                              : 'text-text-2',
                        )}
                      >
                        {statusText(status, now)}
                      </p>
                    )}
                    {a.data.scope === 'inbox' || prev ? (
                      <p className="truncate text-13 text-text-2">
                        {[
                          a.data.scope === 'inbox' ? 'Inbox only' : '',
                          prev ? `rotated from ${prev.data.tokenHint}` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    ) : null}
                  </div>
                </div>

                <dl className="flex items-center gap-5 text-13 sm:justify-end">
                  <div>
                    <dt className="text-text-2">Token</dt>
                    <dd className="font-mono font-medium text-ink">
                      <span className="sr-only">ends in </span>
                      {a.data.tokenHint}
                    </dd>
                  </div>
                </dl>

                {isAdmin && isRevoked ? (
                  <div className="flex justify-end">
                    <ActionMenu
                      label={`Actions for ${a.data.name}`}
                      actions={[
                        {
                          id: 'remove',
                          label: 'Remove…',
                          icon: Trash2,
                          tone: 'danger',
                          onSelect: () => setRemoving(a),
                        },
                      ]}
                      trigger={
                        <IconButton label={`Actions for ${a.data.name}`} className="text-text-2">
                          <Icon icon={MoreHorizontal} size={16} />
                        </IconButton>
                      }
                    />
                  </div>
                ) : null}
                {isAdmin && !isRevoked ? (
                  <div className="flex justify-end">
                    <ActionMenu
                      label={`Actions for ${a.data.name}`}
                      actions={[
                        {
                          id: 'rename',
                          label: 'Rename…',
                          icon: Pencil,
                          onSelect: () => setRenaming(a),
                        },
                        {
                          id: 'rotate',
                          label: 'Rotate token',
                          icon: KeyRound,
                          onSelect: () => setRotating(a),
                        },
                        {
                          id: 'revoke',
                          label: 'Revoke',
                          icon: ShieldOff,
                          tone: 'danger',
                          onSelect: () => setRevoking(a),
                        },
                      ]}
                      trigger={
                        <IconButton label={`Actions for ${a.data.name}`} className="text-text-2">
                          <Icon icon={MoreHorizontal} size={16} />
                        </IconButton>
                      }
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {isAdmin ? (
        <NewAgentModal
          open={creating}
          onClose={closeCreating}
          onCreated={(name, token) => setIssued({ name, token, rotated: false })}
        />
      ) : null}

      <TokenDialog
        name={issued?.name ?? ''}
        token={issued?.token ?? null}
        rotated={issued?.rotated}
        onDone={() => setIssued(null)}
      />

      <Dialog
        open={revoking !== null}
        onOpenChange={(o) => !o && !busy && setRevoking(null)}
        title={`Revoke ${revoking?.data.name ?? ''}?`}
        description="It stops all its work now. Its token is denied on the very next request, and anything it is working on shows “Agent revoked”. This can’t be undone; create a new agent to replace it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)} disabled={busy}>
              Keep
            </Button>
            <Button variant="sendback" loading={busy} onClick={confirmRevoke}>
              Revoke agent
            </Button>
          </>
        }
      />

      <RemoveAgentDialog agent={removing} onClose={() => setRemoving(null)} />
      <RenameAgentDialog agent={renaming} onClose={() => setRenaming(null)} />

      <Dialog
        open={rotating !== null}
        onOpenChange={(o) => !o && !busy && setRotating(null)}
        title={`Rotate the token for ${rotating?.data.name ?? ''}?`}
        description="You get a new token for the same agent: same name, colour and settings, linked to its history. The old token stops working now."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRotating(null)} disabled={busy}>
              Keep
            </Button>
            <Button loading={busy} onClick={confirmRotate}>
              Rotate token
            </Button>
          </>
        }
      />
    </>
  );
}
