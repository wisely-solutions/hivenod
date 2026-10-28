import {
  allowedAgentsFor,
  canEditAgentSettings,
  guardrailsOf,
  MAX_FAILED_RUNS_LIMIT,
  resumeAgent,
  updateAgentSettings,
  type Agent,
  type Project,
} from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { Play, Save } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useReady } from '../auth/context';
import type { Row } from '../lib/live';
import { Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input } from '../ui/form';
import { Icon } from '../ui/icon';
import { useToast } from '../ui/overlay';
import {
  parseCount,
  settingsChanged,
  settingsDraft,
  settingsErrors,
  type SettingsDraft,
} from './settings';

/** A pressed/unpressed pill; 44px tall. */
export function ToggleChip({
  on,
  onClick,
  disabled,
  children,
  label,
}: {
  on: boolean;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-4 text-14 font-medium',
        'transition-colors duration-120 foc:outline-2 foc:outline-offset-2 foc:outline-focus',
        'disabled:cursor-default',
        on
          ? 'border-agent bg-agent-soft text-ink'
          : 'border-line bg-surface text-text-2 enabled:hov:border-line-strong',
      )}
    >
      {children}
    </button>
  );
}

/** The paused banner on the agent page: why, and Resume for admins. */
export function PausedBanner({
  agentId,
  agent,
  isAdmin,
}: {
  agentId: string;
  agent: Agent;
  isAdmin: boolean;
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!agent.pausedAt || agent.revokedAt) return null;
  async function resume() {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    try {
      await run(resumeAgent(ctx, { agentUid: agentId, name: agent.name }));
      toast.push({ message: `${agent.name} is resumed. It picks up work again.` });
    } catch {
      toast.push({ message: 'Could not resume. Try again.' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      role="status"
      data-testid="paused-banner"
      className="mb-6 flex flex-wrap items-center gap-3 rounded-card border border-gate/50 bg-gate-bg p-3.5"
    >
      <p className="min-w-0 flex-1 text-14 text-gate-text">
        <span className="font-semibold">Paused</span>
        {agent.pausedReason ? `: ${agent.pausedReason}.` : '.'} It takes no new work until an admin
        resumes it. Check its failed runs below first.
      </p>
      {isAdmin ? (
        <Button variant="gate" loading={busy} leading={<Icon icon={Play} />} onClick={resume}>
          Resume
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Agent settings (card zSzW3LXy, Draft 1): where it works and its guardrails. What it may do on
 * its machine is that machine's Claude Code config (card rifzGl8M). Admins edit; others read.
 */
export function AgentSettings({
  agentId,
  agent,
  projects,
}: {
  agentId: string;
  agent: Agent;
  projects: Row<Project>[];
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const canEdit =
    canEditAgentSettings({ uid: session.me.uid, isAdmin: session.isAdmin }) && !agent.revokedAt;
  const base = settingsDraft(agent);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const d = draft ?? base;
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const errors = settingsErrors(d);
  const dirty = draft !== null && settingsChanged(base, d);
  const live = projects.filter((p) => !p.data.archivedAt);
  const set = (patch: Partial<SettingsDraft>) => setDraft({ ...d, ...patch });
  const g = guardrailsOf(agent);

  async function save() {
    setTried(true);
    const ctx = actionContext(session.workspaceId);
    if (!ctx || Object.keys(errors).length) return;
    setBusy(true);
    try {
      await run(
        updateAgentSettings(ctx, {
          agentUid: agentId,
          name: agent.name,
          ...(d.inboxOnly
            ? { scope: 'inbox' as const }
            : { projectIds: d.allProjects ? ('*' as const) : d.projectIds }),
          guardrails: {
            maxFailedRuns: parseCount(d.maxFailedRuns) ?? g.maxFailedRuns,
          },
        }),
      );
      setDraft(null);
      setTried(false);
      toast.push({ message: 'Settings saved.' });
    } catch {
      toast.push({ message: 'Could not save the settings. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  const inScope = d.allProjects ? live : live.filter((p) => d.projectIds.includes(p.id));

  return (
    <section
      aria-labelledby="settings-h"
      className="mb-8 rounded-panel border border-line bg-surface p-4 shadow-e1 sm:p-5"
    >
      <h2 id="settings-h" className="mb-4">
        <Eyebrow>Allowed to work on</Eyebrow>
      </h2>

      <div className="flex flex-col gap-5">
        {d.inboxOnly ? (
          <p
            data-testid="inbox-only"
            className="rounded-btn border border-line bg-canvas px-3 py-2.5 text-14 text-ink"
          >
            Inbox and Calendar only. This agent syncs calendars and brings in requests for this
            organization; it never works on development items. This was set when it was connected
            and cannot be changed.
          </p>
        ) : null}
        <div hidden={d.inboxOnly}>
          <p className="mb-2 text-13 font-medium text-ink">Projects</p>
          <div role="group" aria-label="Projects" className="flex flex-wrap gap-2">
            <ToggleChip
              on={d.allProjects}
              disabled={!canEdit}
              onClick={() => set({ allProjects: !d.allProjects })}
            >
              All projects
            </ToggleChip>
            {live.map((p) => {
              const on = d.allProjects || d.projectIds.includes(p.id);
              return (
                <ToggleChip
                  key={p.id}
                  on={on}
                  disabled={!canEdit || d.allProjects}
                  onClick={() =>
                    set({
                      projectIds: on
                        ? d.projectIds.filter((x) => x !== p.id)
                        : [...d.projectIds, p.id],
                    })
                  }
                >
                  <span aria-hidden>{p.data.emoji}</span>
                  {p.data.name}
                </ToggleChip>
              );
            })}
          </div>
          {tried && errors.projects ? (
            <p className="mt-1.5 text-13 text-sendback">{errors.projects}</p>
          ) : null}
        </div>

        <div hidden={d.inboxOnly}>
          <p className="mb-1 text-13 font-medium text-ink">Steps (agent steps only)</p>
          <p className="mb-2 text-13 text-text-2">
            A step can be limited to some agents in its project’s process. Gates are never decided
            by agents.
          </p>
          {inScope.length === 0 ? (
            <p className="text-13 text-text-2">No projects chosen.</p>
          ) : (
            <ul className="flex flex-col gap-3" aria-label="Steps this agent may take">
              {inScope.map((p) => {
                const agentSteps = p.data.steps.filter((s) => s.kind === 'agent');
                return (
                  <li key={p.id} className="flex flex-col gap-1.5">
                    <span className="flex flex-wrap items-baseline gap-x-2 text-13 text-text-2">
                      <span className="font-medium text-ink">
                        {p.data.emoji} {p.data.name}
                      </span>
                      <Link
                        to="/p/$pid/process"
                        params={{ pid: p.id }}
                        className="inline-flex min-h-11 items-center underline underline-offset-4 hov:text-ink"
                      >
                        Process
                      </Link>
                    </span>
                    <span className="flex flex-wrap gap-2">
                      {agentSteps.length === 0 ? (
                        <span className="text-13 text-text-2">No agent steps.</span>
                      ) : (
                        agentSteps.map((s) => {
                          const only = allowedAgentsFor(p.data, s.id);
                          const mayTake = only.length === 0 || only.includes(agentId);
                          return (
                            <span
                              key={s.id}
                              data-step={s.id}
                              data-allowed={mayTake ? 'yes' : 'no'}
                              className={cn(
                                'inline-flex min-h-8 items-center rounded-full border px-3 text-13 font-medium',
                                mayTake
                                  ? 'border-agent bg-agent-soft text-ink'
                                  : 'border-line bg-canvas text-text-3 line-through',
                              )}
                              title={
                                mayTake
                                  ? only.length
                                    ? 'Limited to some agents, including this one'
                                    : 'Any agent on this project'
                                  : 'Limited to other agents'
                              }
                            >
                              {s.name}
                              <span className="sr-only">
                                {mayTake ? '' : ' (limited to other agents)'}
                              </span>
                            </span>
                          );
                        })
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-line pt-5">
          <h3 className="mb-3">
            <Eyebrow>Guardrails</Eyebrow>
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Stop after failed runs in a row"
              inputMode="numeric"
              value={d.maxFailedRuns}
              disabled={!canEdit}
              hint={`Then it pauses until an admin resumes it. 1 to ${MAX_FAILED_RUNS_LIMIT}.`}
              error={tried ? errors.maxFailedRuns : undefined}
              onChange={(e) => set({ maxFailedRuns: e.target.value })}
            />
          </div>
          <div className="mt-4">
            <p className="text-13 font-medium text-ink">When unsure</p>
            <p className="mt-1 rounded-btn border border-line bg-canvas px-3 py-2.5 text-14 text-ink">
              Ask in Hivenod (Needs you). The item goes back to the queue and is picked up again
              once you answer.
            </p>
          </div>
        </div>

        <div className="border-t border-line pt-5">
          <h3 className="mb-1">
            <Eyebrow>Permissions</Eyebrow>
          </h3>
          <p className="text-13 text-text-2">
            What this agent may do on its machine is set in that machine’s Claude Code settings.
          </p>
        </div>

        {canEdit ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            {dirty ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setTried(false);
                }}
              >
                Discard
              </Button>
            ) : null}
            <Button loading={busy} disabled={!dirty} leading={<Icon icon={Save} />} onClick={save}>
              Save settings
            </Button>
          </div>
        ) : (
          <p className="border-t border-line pt-4 text-13 text-text-2">
            {agent.revokedAt
              ? 'This agent is revoked; its settings no longer apply.'
              : 'Only admins change these settings.'}{' '}
            Now: pause after {g.maxFailedRuns} failed runs.
          </p>
        )}
      </div>
    </section>
  );
}
