import { guardrailsOf, MAX_FAILED_RUNS_LIMIT, type Agent } from '@hive/shared';

/** What the agent settings form holds (numbers as typed). */
export interface SettingsDraft {
  allProjects: boolean;
  projectIds: string[];
  maxFailedRuns: string;
}

export function settingsDraft(agent: Agent): SettingsDraft {
  const g = guardrailsOf(agent);
  return {
    allProjects: agent.projectIds === '*',
    projectIds: agent.projectIds === '*' ? [] : [...agent.projectIds],
    maxFailedRuns: String(g.maxFailedRuns),
  };
}

/** Whole numbers only; "500,000" and "500 000" are fine. */
export function parseCount(text: string): number | null {
  const clean = text.replace(/[\s,._]/g, '');
  if (!/^\d+$/.test(clean)) return null;
  return Number(clean);
}

export function settingsErrors(d: SettingsDraft): {
  projects?: string;
  maxFailedRuns?: string;
} {
  const out: ReturnType<typeof settingsErrors> = {};
  if (!d.allProjects && d.projectIds.length === 0) out.projects = 'Pick at least one project.';
  const n = parseCount(d.maxFailedRuns);
  if (n === null || n < 1 || n > MAX_FAILED_RUNS_LIMIT)
    out.maxFailedRuns = `A whole number from 1 to ${MAX_FAILED_RUNS_LIMIT}.`;
  return out;
}

export function settingsChanged(a: SettingsDraft, b: SettingsDraft): boolean {
  const sorted = (x: readonly string[]) => [...x].sort().join('|');
  return (
    a.allProjects !== b.allProjects ||
    (!b.allProjects && sorted(a.projectIds) !== sorted(b.projectIds)) ||
    parseCount(a.maxFailedRuns) !== parseCount(b.maxFailedRuns)
  );
}
