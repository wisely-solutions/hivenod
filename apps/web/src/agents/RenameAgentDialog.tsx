import type { Agent } from '@hive/shared';
import { renameAgent } from '@hive/shared';
import { useState } from 'react';
import { useReady } from '../auth/context';
import type { Row } from '../lib/live';
import { Button } from '../ui/button';
import { Input } from '../ui/form';
import { Dialog, useToast } from '../ui/overlay';

/** Renames an agent (admins only, item 8U5Rz). Past events keep the name they were written with. */
function RenameForm({ agent, onClose }: { agent: Row<Agent> | null; onClose: () => void }) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [name, setName] = useState(agent?.data.name ?? '');
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const current = agent?.data.name ?? '';

  const trimmed = name.trim();
  const error = !trimmed
    ? 'Give the agent a name'
    : trimmed === current
      ? 'That is already its name'
      : null;

  async function save() {
    setTried(true);
    const ctx = actionContext(session.workspaceId);
    if (!agent || !ctx || error) return;
    setBusy(true);
    try {
      await run(renameAgent(ctx, { agentUid: agent.id, oldName: current, newName: trimmed }));
      onClose();
      toast.push({ message: `Renamed to ${trimmed}.` });
    } catch {
      toast.push({ message: 'Could not rename the agent. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={agent !== null}
      onOpenChange={(o) => !o && !busy && onClose()}
      title={`Rename ${current}`}
      description="The new name shows everywhere the agent appears. Past activity keeps the name it was written with."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={save}>
            Rename
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input
          label="Name"
          autoComplete="off"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={tried ? (error ?? undefined) : undefined}
        />
      </form>
    </Dialog>
  );
}

/** Keyed by agent, so each opening starts from that agent's current name. */
export function RenameAgentDialog(props: { agent: Row<Agent> | null; onClose: () => void }) {
  return <RenameForm key={props.agent?.id ?? ''} {...props} />;
}
