import type { Agent } from '@hive/shared';
import { removeAgent } from '@hive/shared';
import { useState } from 'react';
import { useReady } from '../auth/context';
import type { Row } from '../lib/live';
import { Button } from '../ui/button';
import { Dialog, useToast } from '../ui/overlay';

/** Removes a revoked agent for good (admins only, item 81P4s). Past work keeps the name. */
export function RemoveAgentDialog({
  agent,
  onClose,
  onRemoved,
}: {
  agent: Row<Agent> | null;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function confirm() {
    const ctx = actionContext(session.workspaceId);
    if (!agent || !ctx) return;
    setBusy(true);
    try {
      await run(removeAgent(ctx, { agentUid: agent.id, name: agent.data.name }));
      onClose();
      toast.push({ message: `${agent.data.name} is removed.` });
      onRemoved?.();
    } catch {
      toast.push({ message: 'Could not remove the agent. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={agent !== null}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Remove ${agent?.data.name ?? ''}?`}
      description={`Remove ${agent?.data.name ?? ''} for good? Its past work keeps its name.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep
          </Button>
          <Button variant="sendback" loading={busy} onClick={confirm}>
            Remove agent
          </Button>
        </>
      }
    />
  );
}
