import {
  createProject,
  DEFAULT_TEMPLATE_ID,
  stepsFor,
  templateById,
  type Template,
} from '@hive/shared';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { TemplateGallery } from '../projects/TemplateGallery';
import { Button } from '../ui/button';
import { Input } from '../ui/form';

/**
 * The first step after sign-up (item EJ2Cxq4k): "What will your agents work on?". Picking a
 * template and creating makes a project with that process, then opens Connect Claude Code.
 */
export function WelcomeProject() {
  const { session, actionContext, run } = useReady();
  const navigate = useNavigate();
  const [template, setTemplate] = useState<Template>(templateById(DEFAULT_TEMPLATE_ID)!);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function create() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    setError(undefined);
    try {
      const plan = createProject(ctx, {
        name: name.trim() || template.name,
        emoji: template.emoji,
        color: 'agent-1',
        templateId: template.id,
        steps: stepsFor(template, session.me.uid),
        memberUids: [session.me.uid],
      });
      await run(plan);
      void navigate({ to: '/connect' });
    } catch {
      setError('Could not create the project. Try again.');
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <TemplateGallery
        value={template.id}
        onValueChange={setTemplate}
        label="What will your agents work on?"
        bleed="page"
      />
      <Input
        label="Project name"
        placeholder={template.name}
        autoComplete="off"
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      {error ? (
        <p role="alert" className="text-13 text-sendback">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" loading={busy}>
          Create project
        </Button>
      </div>
    </form>
  );
}
