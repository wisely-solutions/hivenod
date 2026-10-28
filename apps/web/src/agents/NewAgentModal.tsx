import { Check } from 'lucide-react';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { useShellData } from '../shell/data';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input, RadioCards } from '../ui/form';
import { Icon } from '../ui/icon';
import { COLOR_NAMES, colorValue } from './logic';
import { createAgentFlow } from './flow';

export interface AgentFieldsValue {
  name: string;
  color: number;
  scope: 'all' | 'some';
  chosen: string[];
}
export interface AgentFieldErrors {
  name?: string;
  projects?: string;
  form?: string;
}

/** Checks the fields; returns the errors (empty when fine). */
export function validateAgentFields(v: AgentFieldsValue): AgentFieldErrors {
  const next: AgentFieldErrors = {};
  if (!v.name.trim()) next.name = 'Give the agent a name.';
  if (v.scope === 'some' && v.chosen.length === 0) next.projects = 'Pick at least one project.';
  return next;
}

/** Name, colour and allowed projects: shared by the token dialog and the Connect page. */
export function AgentFields({
  value,
  onChange,
  errors,
}: {
  value: AgentFieldsValue;
  onChange: (v: AgentFieldsValue) => void;
  errors: AgentFieldErrors;
}) {
  const { projects } = useShellData();
  const live = projects.filter((p) => !p.data.archivedAt);
  const { name, color, scope, chosen } = value;
  const setName = (name: string) => onChange({ ...value, name });
  const setColor = (color: number) => onChange({ ...value, color });
  const setScope = (scope: 'all' | 'some') => onChange({ ...value, scope });
  const setChosen = (fn: (c: string[]) => string[]) => onChange({ ...value, chosen: fn(chosen) });
  return (
    <>
      <Input
        label="Name"
        placeholder="Research agent"
        autoComplete="off"
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
      />

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-13 font-medium text-ink">Colour</legend>
        <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1">
          {COLOR_NAMES.map((n, i) => {
            const idx = i + 1;
            const on = color === idx;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={n}
                onClick={() => setColor(idx)}
                className="grid size-11 place-items-center rounded-full foc:outline-2 foc:outline-offset-0 foc:outline-focus"
              >
                <span
                  aria-hidden
                  className={cn(
                    'grid size-8 place-items-center rounded-full text-on-solid transition-transform duration-120 ease-standard',
                    on && 'scale-110 ring-2 ring-ink ring-offset-2 ring-offset-surface',
                  )}
                  style={{ backgroundColor: `var(--agent-${idx})` }}
                >
                  {on ? <Icon icon={Check} size={16} /> : null}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <RadioCards
          label="Allowed projects"
          value={scope}
          onValueChange={(v) => setScope(v as 'all' | 'some')}
          options={[
            { value: 'all', title: 'All projects', description: 'Including ones you add later.' },
            {
              value: 'some',
              title: 'Chosen projects',
              description: 'Only the ones you tick below.',
            },
          ]}
        />
        {scope === 'some' ? (
          <fieldset className="flex flex-col rounded-card border border-line">
            <legend className="sr-only">Projects this agent can use</legend>
            {live.length === 0 ? (
              <p className="p-3.5 text-14 text-text-2">
                No projects yet. Choose “All projects”, or add a project first.
              </p>
            ) : (
              live.map((p, i) => (
                <label
                  key={p.id}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 px-3.5 text-14 text-ink',
                    i > 0 && 'border-t border-line',
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-5 accent-[var(--ink)]"
                    checked={chosen.includes(p.id)}
                    onChange={(e) =>
                      setChosen((c) =>
                        e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id),
                      )
                    }
                  />
                  <span aria-hidden>{p.data.emoji}</span>
                  <span className="truncate">{p.data.name}</span>
                </label>
              ))
            )}
          </fieldset>
        ) : null}
        {errors.projects ? <p className="text-13 text-sendback">{errors.projects}</p> : null}
      </div>
    </>
  );
}

/** "Advanced": a plain MCP agent that signs in with a token. The CLI path is the Connect page. */
export function NewAgentModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (name: string, token: string) => void;
}) {
  const { session, actionContext, run } = useReady();
  const [value, setValue] = useState<AgentFieldsValue>({
    name: '',
    color: 1,
    scope: 'all',
    chosen: [],
  });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<AgentFieldErrors>({});

  const reset = () => {
    setValue({ name: '', color: 1, scope: 'all', chosen: [] });
    setErrors({});
    setBusy(false);
  };

  async function create() {
    const next = validateAgentFields(value);
    setErrors(next);
    if (next.name || next.projects) return;
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    try {
      const token = await createAgentFlow(ctx, run, {
        name: value.name.trim(),
        color: colorValue(value.color),
        projectIds: value.scope === 'all' ? ('*' as const) : value.chosen,
      });
      onCreated?.(value.name.trim(), token);
      onClose();
      setTimeout(reset, 250);
    } catch {
      setErrors({ form: 'Could not create the agent. Try again.' });
      setBusy(false);
    }
  }

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) {
          onClose();
          setTimeout(reset, 250);
        }
      }}
      title="New agent with a token"
      description="Advanced: plain MCP. The agent signs in with a token. You see it once, right after this."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} onClick={create}>
            Create agent
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
        <AgentFields value={value} onChange={setValue} errors={errors} />
        {errors.form ? (
          <p role="alert" className="text-13 text-sendback">
            {errors.form}
          </p>
        ) : null}
      </form>
    </ResponsiveModal>
  );
}
