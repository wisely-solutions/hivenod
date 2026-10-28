/** The first-run checklist: three steps from an empty workspace to a first idea and an agent. */
export interface FirstRunState {
  project: boolean;
  idea: boolean;
  agent: boolean;
}

/** `ever`: the steps this person already saw done; a step done once stays done. */
export function firstRunState(input: {
  projects: { data: { archivedAt?: unknown } }[];
  items: Record<string, readonly unknown[]>;
  agents: { data: { revokedAt?: unknown } }[];
  ever?: Partial<FirstRunState> | null;
}): FirstRunState {
  return {
    project: !!input.ever?.project || input.projects.some((p) => !p.data.archivedAt),
    idea: !!input.ever?.idea || Object.values(input.items).some((l) => l.length > 0),
    agent: !!input.ever?.agent || input.agents.some((a) => !a.data.revokedAt),
  };
}

export const firstRunDone = (s: FirstRunState) => s.project && s.idea && s.agent;
