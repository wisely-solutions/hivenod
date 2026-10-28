/**
 * Project templates (SPEC 9.3). A template is an ordered process: agent steps do the work, human
 * steps are gates. `stepsFor` turns one into real project steps, with the creator as the first
 * decider at every gate (the "Who decides" editor changes that later).
 */
import type { Step, StepKind } from './schema';

export interface TemplateStep {
  id: string;
  name: string;
  kind: StepKind;
  description: string;
}

export interface Template {
  id: string;
  name: string;
  /** One line shown on the gallery card. */
  blurb: string;
  emoji: string;
  steps: readonly TemplateStep[];
}

const agent = (id: string, name: string, description: string): TemplateStep => ({
  id,
  name,
  kind: 'agent',
  description,
});
const gate = (id: string, name: string, description: string): TemplateStep => ({
  id,
  name,
  kind: 'human',
  description,
});

export const TEMPLATES: readonly Template[] = [
  {
    id: 'build-a-system',
    name: 'Build a system',
    blurb: 'From idea to release, with people only at the decision points.',
    emoji: '🏗️',
    steps: [
      agent(
        'intake',
        'Intake',
        'Triages ideas, requests and bugs from people, clients, email, Telegram and monitoring.',
      ),
      agent('discover', 'Discover', 'Research, feasibility and cost, delivered as an HTML report.'),
      gate('go-no-go', 'Go / no-go', 'A person decides whether this is worth building.'),
      agent('spec', 'Spec', 'Scope, screens and acceptance criteria, delivered as HTML.'),
      gate('approve-spec', 'Approve spec', 'A person approves the spec before any work starts.'),
      agent('plan', 'Plan', 'Breaks the spec into tasks and an estimate.'),
      agent('build', 'Build', 'Writes the code and the tests, and opens a pull request.'),
      agent('verify', 'Verify', 'Runs the tests, then shares a preview link and screenshots.'),
      gate('accept', 'Accept', 'A person checks the result against the acceptance criteria.'),
      gate('release', 'Release', 'A person releases it. This can become automatic later.'),
    ],
  },
  {
    id: 'content-pipeline',
    name: 'Content pipeline',
    blurb: 'Posts and pages, from idea to published.',
    emoji: '✍️',
    steps: [
      agent('ideas', 'Ideas', 'Collects and proposes topics worth writing about.'),
      gate('pick', 'Pick', 'A person picks which ideas to write.'),
      agent('draft', 'Draft', 'Writes the first draft.'),
      gate('approve', 'Approve', 'A person approves the draft. Nothing goes out without this.'),
      agent('publish', 'Publish', 'Prepares the approved piece for publishing.'),
    ],
  },
  {
    id: 'research-to-decision',
    name: 'Research to decision',
    blurb: 'Turn a question into a researched, signed-off plan.',
    emoji: '🔎',
    steps: [
      agent('brief', 'Brief', 'Turns the question into a clear brief.'),
      agent('research', 'Research', 'Gathers sources and findings, delivered as a report.'),
      gate('review', 'Review', 'A person reviews the findings and picks a direction.'),
      agent('plan', 'Plan', 'Writes the plan for the chosen direction.'),
      gate('done', 'Done', 'A person signs off and closes it.'),
    ],
  },
  {
    id: 'feature-delivery',
    name: 'Feature delivery',
    blurb: 'Ship a feature with a person checking the pull request.',
    emoji: '🚀',
    steps: [
      agent('spec', 'Spec', 'Writes what the feature does and how to tell it works.'),
      agent('build', 'Build', 'Writes the code and the tests.'),
      gate('review-pr', 'Review PR', 'A person reviews the pull request.'),
      agent('deploy', 'Deploy', 'Deploys the merged change.'),
      agent('verify', 'Verify', 'Checks the change on production.'),
    ],
  },
  {
    id: 'client-proposal',
    name: 'Client proposal',
    blurb: 'Discover, scope and propose, with the client sign-off as a gate.',
    emoji: '🤝',
    steps: [
      agent('discovery', 'Discovery', 'Learns what the client needs and where they are today.'),
      agent('scope', 'Scope', 'Drafts the scope, price and timeline.'),
      gate('sign-off', 'Sign-off', 'A person signs off before anything is sent to the client.'),
      agent('pilot', 'Pilot', 'Runs the agreed pilot.'),
      agent('report', 'Report', 'Reports the pilot results.'),
    ],
  },
  {
    id: 'blank',
    name: 'Blank',
    blurb: 'One step. Add your own process later.',
    emoji: '📄',
    steps: [agent('todo', 'To do', 'Work waiting to be done.')],
  },
];

export const DEFAULT_TEMPLATE_ID = 'build-a-system';

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Template name shown under a project name; Blank and unknown templates read as a custom process. */
export function templateLabel(id: string): string {
  const t = templateById(id);
  return t && t.id !== 'blank' ? t.name : 'Custom process';
}

/** 1-based positions of the human gates, e.g. [3, 5, 9, 10]. */
export function gatePositions(steps: readonly Pick<TemplateStep, 'kind'>[]): number[] {
  return steps.flatMap((s, i) => (s.kind === 'human' ? [i + 1] : []));
}

/** "Gates at 3, 5, 9 and 10", for screen readers and small print. */
export function describeProcess(steps: readonly Pick<TemplateStep, 'kind'>[]): string {
  const gates = gatePositions(steps);
  const n = `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`;
  if (gates.length === 0) return `${n}, no gates`;
  const list =
    gates.length === 1 ? String(gates[0]) : `${gates.slice(0, -1).join(', ')} and ${gates.at(-1)}`;
  return `${n}, ${gates.length === 1 ? 'gate' : 'gates'} at ${list}`;
}

/** Real project steps for a template; every gate starts with the creator as its decider. */
export function stepsFor(template: Template, creatorUid: string): Step[] {
  return template.steps.map((s) =>
    s.kind === 'human'
      ? {
          ...s,
          gate: {
            deciderUids: [creatorUid],
            groupIds: [],
            rule: 'any' as const,
            n: 1,
            mustInclude: [],
            rejectPolicy: 'one' as const,
            remindAfterHours: 24,
          },
        }
      : { ...s },
  );
}
