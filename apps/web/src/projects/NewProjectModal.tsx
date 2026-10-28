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
import { ResponsiveModal } from '../components/ResponsiveModal';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input } from '../ui/form';
import { useToast } from '../ui/overlay';
import { EMOJI_CHOICES } from './logic';
import { PeoplePicker } from './PeoplePicker';
import { TemplateGallery } from './TemplateGallery';

/** Pick a template, then name it. Mount it with a fresh `key` each time it opens. */
export function NewProjectModal({
  open,
  initialTemplateId,
  nextColor,
  onClose,
}: {
  open: boolean;
  initialTemplateId?: string;
  /** 1 to 8: the colour for the new project. */
  nextColor: number;
  onClose: () => void;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const navigate = useNavigate();
  const [template, setTemplate] = useState<Template>(
    templateById(initialTemplateId ?? DEFAULT_TEMPLATE_ID)!,
  );
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Admins choose who sees it; a member can only make a project for themselves.
  const [people, setPeople] = useState<string[]>([session.me.uid]);
  const [errors, setErrors] = useState<{ name?: string; form?: string }>({});
  const shownEmoji = emoji ?? template.emoji;

  async function create() {
    const clean = name.trim();
    const next: typeof errors = {};
    if (!clean) next.name = 'Give the project a name.';
    setErrors(next);
    if (next.name) return;
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    try {
      const plan = createProject(ctx, {
        name: clean,
        emoji: shownEmoji,
        color: `agent-${nextColor}`,
        templateId: template.id,
        steps: stepsFor(template, session.me.uid),
        memberUids: session.isAdmin
          ? people.filter(
              (u) => session.workspace.memberRoles[u] === 'member' || u === session.me.uid,
            )
          : [session.me.uid],
      });
      await run(plan);
      toast.push({ message: `${clean} is ready.` });
      onClose();
      // Creating a project opens its board: that is where the first idea goes.
      void navigate({ to: '/p/$pid', params: { pid: plan.projectId } });
    } catch {
      setErrors({ form: 'Could not create the project. Try again.' });
      setBusy(false);
    }
  }

  return (
    <ResponsiveModal
      open={open}
      wide
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title="New project"
      description="Start from a template. You can change the process later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={create}>
            Create project
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <TemplateGallery value={template.id} onValueChange={setTemplate} />

        <Input
          label="Name"
          placeholder="Customer portal"
          autoComplete="off"
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
        />

        {session.isAdmin ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-13 font-medium text-ink">Who can see it</legend>
            <PeoplePicker value={people} onChange={setPeople} label="Who can see it" />
            <p className="text-13 text-text-2">
              Members only see projects they are added to. You can change this later.
            </p>
          </fieldset>
        ) : null}

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-13 font-medium text-ink">Emoji</legend>
          <div role="radiogroup" aria-label="Emoji" className="flex flex-wrap gap-1">
            {[template.emoji, ...EMOJI_CHOICES.filter((e) => e !== template.emoji)].map((e) => {
              const on = e === shownEmoji;
              return (
                <button
                  key={e}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`Emoji ${e}`}
                  onClick={() => setEmoji(e)}
                  className={cn(
                    'grid size-11 place-items-center rounded-btn border text-20 transition-[border-color,background-color,transform] duration-120 ease-standard act:scale-95',
                    'foc:outline-2 foc:outline-offset-2 foc:outline-focus',
                    on ? 'border-ink bg-canvas' : 'border-transparent hov:bg-canvas',
                  )}
                >
                  <span aria-hidden>{e}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {errors.form ? (
          <p role="alert" className="text-13 text-sendback">
            {errors.form}
          </p>
        ) : null}
      </form>
    </ResponsiveModal>
  );
}
