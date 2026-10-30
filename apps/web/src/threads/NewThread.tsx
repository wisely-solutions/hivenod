/**
 * New thread (item OE8FmrTaIxFVGcaeGG3N, slice 6, design 6.2): the member writes to one of the
 * organization's agents (its home agent from then on): a title, the text, a template (None or
 * Development) and the agent. With Development, the plan is the member's own: Shape starts at
 * once, Build waits for Approve idea, Release for Ship it?, and the plan is done at Accept on live.
 */
import { createMemberThread, PLAN_TEMPLATES, type Agent } from '@hive/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useReady } from '../auth/context';
import type { Row } from '../lib/live';
import { useShellData } from '../shell/data';
import { Button } from '../ui/button';
import { Input, RadioCards, Select, Textarea } from '../ui/form';
import { Dialog } from '../ui/overlay';
import { errorText } from './parts';

/** The org's agents that can take a thread (not revoked), the most recently seen first. */
export function threadAgents(agents: readonly Row<Agent>[]): Row<Agent>[] {
  return agents
    .filter((a) => a.data.revokedAt === null)
    .sort(
      (a, b) =>
        (b.data.lastSeenAt?.toMillis() ?? 0) - (a.data.lastSeenAt?.toMillis() ?? 0) ||
        a.data.name.localeCompare(b.data.name),
    );
}

export function NewThreadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session, actionContext, run } = useReady();
  const { agents } = useShellData();
  const navigate = useNavigate();
  const wid = session.workspaceId;
  const list = threadAgents(agents);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [template, setTemplate] = useState<'none' | 'dev'>('none');
  const [agent, setAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentUid = agent || list[0]?.id || '';
  const can = !!title.trim() && !!text.trim() && !!agentUid && !busy;

  async function create() {
    const ctx = actionContext(wid);
    if (!ctx || !can) return;
    setError(null);
    let p;
    try {
      p = createMemberThread(ctx, {
        title,
        text,
        agentUid,
        template: template === 'dev' ? 'dev' : null,
      });
    } catch (e) {
      setError(errorText(e));
      return;
    }
    setBusy(true);
    try {
      await run(p);
      setTitle('');
      setText('');
      setTemplate('none');
      onClose();
      void navigate({ to: '/inbox/$wid/t/$tid', params: { wid, tid: p.threadId } });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const dev = PLAN_TEMPLATES.dev;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="New thread"
      description="Write to one of your organization's agents. It works the thread and asks you at every decision."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="approve"
            data-new-thread-create=""
            disabled={!can}
            loading={busy}
            onClick={() => void create()}
          >
            {template === 'dev' ? 'Start development' : 'Create thread'}
          </Button>
        </>
      }
    >
      <div data-new-thread="" className="flex flex-col gap-3">
        <Input
          label="Title"
          name="title"
          value={title}
          maxLength={200}
          placeholder="Dark mode for the board"
          onChange={(e) => setTitle(e.target.value)}
        />
        <Textarea
          label="What do you want?"
          name="text"
          rows={4}
          value={text}
          placeholder="What it is, who asked, what done looks like"
          onChange={(e) => setText(e.target.value)}
        />
        <RadioCards
          label="Template"
          value={template}
          onValueChange={(v) => setTemplate(v === 'dev' ? 'dev' : 'none')}
          options={[
            {
              value: 'none',
              title: 'None',
              description: 'The agent looks into it and proposes what to do.',
            },
            { value: 'dev', title: dev.name, description: dev.description },
          ]}
        />
        {list.length ? (
          <Select
            label="Agent"
            value={agentUid}
            onValueChange={setAgent}
            options={list.map((a) => ({ value: a.id, label: a.data.name }))}
          />
        ) : (
          <p role="status" className="text-14 text-sendback">
            This organization has no agent yet: connect one under Agents first.
          </p>
        )}
        {template === 'dev' ? (
          <p data-new-thread-dev="" className="text-13 text-text-2">
            Shape starts at once. Build waits for your Approve idea, Release for your Ship it?, and
            the work is done when you Accept on live. You can ask for changes at every one of them.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-14 text-sendback">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
