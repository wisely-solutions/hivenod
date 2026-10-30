import type { Gate, GroupRef, Step, StepKind } from '@hive/shared';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input, RadioCards, Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import { GateEditor, type Person } from './GateEditor';
import { OUTPUT_CHOICES } from './logic';
import { Markdown } from '../ui/markdown';

/** An agent that may be chosen for a step (allowed on the project, not revoked). */
export interface AgentChoice {
  uid: string;
  name: string;
  /** False when the agent is listed on the step but no longer allowed on the project. */
  onProject: boolean;
}

/** The editor for one step: text, kind, instructions and outputs, and Who decides for a gate. */
export function StepEditor({
  step,
  index,
  count,
  onChange,
  onKind,
  onMove,
  onDelete,
  people,
  groups,
  gateLocked = false,
  agents = [],
  allowedAgents = [],
  onAllowedAgents,
  agentsLocked = true,
}: {
  step: Step;
  index: number;
  count: number;
  onChange: (s: Step) => void;
  onKind: (k: StepKind) => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
  people: Person[];
  groups: GroupRef[];
  /** The viewer may not change this step's gate (nor turn a locked gate into an agent step). */
  gateLocked?: boolean;
  /** Agents that may be limited to this step (card zSzW3LXy). */
  agents?: AgentChoice[];
  /** The agents this step is limited to; empty means any agent on the project. */
  allowedAgents?: string[];
  onAllowedAgents?: (uids: string[]) => void;
  /** Only admins and the project's creator choose who can do a step. */
  agentsLocked?: boolean;
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const outputs = step.outputs ?? [];
  return (
    <div className="flex flex-col gap-5">
      <Input
        label="Name"
        value={step.name}
        maxLength={60}
        error={step.name.trim() ? undefined : 'Give this step a name.'}
        onChange={(e) => onChange({ ...step, name: e.target.value })}
      />

      <div role="radiogroup" aria-label="Kind" className="grid grid-cols-2 gap-2">
        {(
          [
            ['agent', 'Agent', 'An agent does this step.'],
            ['human', 'You decide', 'A person decides here.'],
          ] as const
        ).map(([k, title, hint]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={step.kind === k}
            disabled={gateLocked && step.kind === 'human' && k === 'agent'}
            onClick={() => onKind(k)}
            className={cn(
              'min-h-11 rounded-card border p-3 text-left disabled:cursor-not-allowed disabled:opacity-60 transition-[border-color,background-color] duration-120',
              'foc:outline-2 foc:outline-offset-2 foc:outline-focus',
              step.kind === k
                ? k === 'human'
                  ? 'border-gate bg-gate-bg'
                  : 'border-agent bg-agent-soft'
                : 'border-line bg-surface hov:border-line-strong',
            )}
          >
            <span className="block text-14 font-medium text-ink">{title}</span>
            <span className="block text-13 text-text-2">{hint}</span>
          </button>
        ))}
      </div>

      <Textarea
        label="Description"
        value={step.description}
        maxLength={2000}
        onChange={(e) => onChange({ ...step, description: e.target.value })}
      />

      {step.kind === 'agent' ? (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-13 font-medium text-ink">Instructions (Markdown)</span>
              <div role="tablist" aria-label="Instructions view" className="flex gap-1">
                {(['write', 'preview'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className={cn(
                      'min-h-11 rounded-btn px-3 text-13 font-medium capitalize',
                      tab === t ? 'bg-ink text-surface' : 'text-text-2 hov:text-ink',
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            {tab === 'write' ? (
              <Textarea
                label="Instructions"
                className="min-h-40 font-mono text-14"
                value={step.instructions ?? ''}
                maxLength={20000}
                onChange={(e) => onChange({ ...step, instructions: e.target.value })}
              />
            ) : (
              <div
                aria-label="Instructions preview"
                className="min-h-40 rounded-btn border border-line bg-surface p-3"
              >
                <Markdown source={step.instructions ?? ''} />
              </div>
            )}
          </div>

          <WhoCanDo
            stepName={step.name || 'this step'}
            agents={agents}
            allowed={allowedAgents}
            onChange={onAllowedAgents}
            locked={agentsLocked}
          />

          <fieldset className="flex flex-col gap-2">
            <legend className="text-13 font-medium text-ink">Expected outputs</legend>
            <div className="flex flex-wrap gap-2">
              {OUTPUT_CHOICES.map((o) => {
                const on = outputs.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      onChange({
                        ...step,
                        outputs: on ? outputs.filter((x) => x !== o.id) : [...outputs, o.id],
                      })
                    }
                    className={cn(
                      'inline-flex min-h-11 items-center rounded-full border px-4 text-14 font-medium',
                      'transition-colors duration-120 foc:outline-2 foc:outline-offset-2 foc:outline-focus',
                      on
                        ? 'border-ink bg-ink text-surface'
                        : 'border-line bg-surface text-ink hov:border-line-strong',
                    )}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        </>
      ) : step.gate ? (
        <GateEditor
          gate={step.gate}
          onChange={(g: Gate) => onChange({ ...step, gate: g })}
          people={people}
          groups={groups}
          stepName={step.name || 'This gate'}
          locked={gateLocked}
        />
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        <Button
          variant="secondary"
          leading={<Icon icon={ArrowUp} />}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          Move up
        </Button>
        <Button
          variant="secondary"
          leading={<Icon icon={ArrowDown} />}
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          Move down
        </Button>
        <Button
          variant="sendback"
          leading={<Icon icon={Trash2} />}
          disabled={count <= 1}
          onClick={onDelete}
          className="sm:ml-auto"
        >
          Delete step
        </Button>
      </div>
    </div>
  );
}

/** "Who can do this step": any agent on the project, or only the chosen ones. */
function WhoCanDo({
  stepName,
  agents,
  allowed,
  onChange,
  locked,
}: {
  stepName: string;
  agents: AgentChoice[];
  allowed: string[];
  onChange?: (uids: string[]) => void;
  locked: boolean;
}) {
  // "Only" stays chosen while the list is being built, even when it is momentarily empty.
  const [only, setOnly] = useState(allowed.length > 0);
  const limited = only || allowed.length > 0;
  const nameOf = (uid: string) => agents.find((a) => a.uid === uid)?.name ?? 'Removed agent';
  if (locked) {
    return (
      <div className="flex flex-col gap-1" data-testid="who-can-do">
        <span className="text-13 font-medium text-ink">Who can do this step</span>
        <p className="text-14 text-ink">
          {allowed.length ? `Only ${allowed.map(nameOf).join(', ')}` : 'Any agent on this project'}
        </p>
        <p className="text-13 text-text-2">
          Only admins and the project’s creator choose which agents do a step.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="who-can-do">
      <span className="text-13 font-medium text-ink">Who can do this step</span>
      <RadioCards
        label="Who can do this step"
        value={limited ? 'only' : 'any'}
        onValueChange={(v) => {
          setOnly(v === 'only');
          if (v === 'any') onChange?.([]);
        }}
        options={[
          {
            value: 'any',
            title: 'Any agent on this project',
            description: 'Every agent allowed on the project may take it.',
          },
          {
            value: 'only',
            title: 'Only these agents',
            description: `Other agents never see ${stepName} as work and cannot claim it.`,
          },
        ]}
      />
      {limited ? (
        agents.length === 0 ? (
          <p className="text-13 text-text-2">
            No agent is allowed on this project yet. Add one in Agents first.
          </p>
        ) : (
          <div role="group" aria-label="Agents for this step" className="flex flex-wrap gap-2">
            {agents.map((a) => {
              const on = allowed.includes(a.uid);
              return (
                <button
                  key={a.uid}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    onChange?.(on ? allowed.filter((u) => u !== a.uid) : [...allowed, a.uid])
                  }
                  className={cn(
                    'inline-flex min-h-11 items-center rounded-full border px-4 text-14 font-medium',
                    'transition-colors duration-120 foc:outline-2 foc:outline-offset-2 foc:outline-focus',
                    on
                      ? 'border-agent bg-agent-soft text-ink'
                      : 'border-line bg-surface text-text-2 hov:border-line-strong',
                  )}
                >
                  {a.name}
                  {a.onProject ? '' : ' (not on this project)'}
                </button>
              );
            })}
          </div>
        )
      ) : null}
      {limited && allowed.length === 0 && agents.length > 0 ? (
        <p className="text-13 text-text-2">Pick at least one agent, or choose any agent.</p>
      ) : null}
    </div>
  );
}
