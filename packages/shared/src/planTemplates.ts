/**
 * Plan templates (item OE8FmrTaIxFVGcaeGG3N, slice 6, design "Development as threads" 6.1): a
 * template is an ordered list of plan steps with default fields, code not data (editing in the
 * UI is a non-goal). The member starts one with New thread (createMemberThread: the agent steps
 * start approved, the creation is the approval); an agent proposes one with plan_propose
 * `template` (it waits for Approve plan as any plan).
 *
 * `sendBackTo` (per person step): the step that Ask for changes sends the plan back to, as an
 * index; without one, the nearest earlier agent step (sendBackTarget). The Go CLI embeds the
 * templates as cli/internal/actions/plantemplates.json (scripts/inbox-outcomes.test.mjs keeps it
 * equal; UPDATE_GO_CONTRACT=1 pnpm test:scripts rewrites it).
 */
import { ActionError } from './actions';
import { outcomeKind, outcomeType } from './outcomes';

export interface PlanTemplateStep {
  type: string;
  /** The step's default fields (merged under what the caller gives). */
  fields: Readonly<Record<string, string>>;
  /** A person step: the index of the step Ask for changes sends the plan back to. */
  sendBackTo?: number;
}
export interface PlanTemplate {
  id: string;
  name: string;
  description: string;
  steps: readonly PlanTemplateStep[];
}

export const PLAN_TEMPLATES = {
  dev: {
    id: 'dev',
    name: 'Development',
    description:
      'Shape → Approve idea → Build (an open, green, unmerged PR) → Ship it? → Release + live check → Accept on live.',
    steps: [
      { type: 'shape', fields: {} },
      { type: 'approval', fields: { what: 'Approve idea' }, sendBackTo: 0 },
      { type: 'build', fields: {} },
      { type: 'approval', fields: { what: 'Ship it?' }, sendBackTo: 2 },
      { type: 'release', fields: {} },
      { type: 'approval', fields: { what: 'Accept on live' }, sendBackTo: 2 },
    ],
  },
} as const satisfies Record<string, PlanTemplate>;
export type PlanTemplateId = keyof typeof PLAN_TEMPLATES;
export const PLAN_TEMPLATE_IDS = Object.keys(PLAN_TEMPLATES) as PlanTemplateId[];

export function planTemplate(id: string): PlanTemplate | null {
  return Object.prototype.hasOwnProperty.call(PLAN_TEMPLATES, id)
    ? (PLAN_TEMPLATES as Record<string, PlanTemplate>)[id]!
    : null;
}

/**
 * A template's steps, ready for proposePlan / createMemberThread: each step's default fields with
 * `fields[i]` (the caller's, e.g. the idea and brief) over them. Unknown templates are refused.
 */
export function templateSteps(
  id: string,
  fields: readonly (Readonly<Record<string, unknown>> | null | undefined)[] = [],
): { type: string; fields: Record<string, unknown> }[] {
  const t = planTemplate(id);
  if (!t)
    throw new ActionError(`Unknown template ${id}. Templates: ${PLAN_TEMPLATE_IDS.join(', ')}.`);
  if (fields.length > t.steps.length)
    throw new ActionError(`The ${t.name} template has ${t.steps.length} steps.`);
  return t.steps.map((s, i) => ({ type: s.type, fields: { ...s.fields, ...(fields[i] ?? {}) } }));
}

/**
 * The plan's send-back map {person step's outcome id: target outcome id} from a template, for
 * the plan doc (`sendBackTo`).
 */
export function templateSendBack(id: string, stepIds: readonly string[]): Record<string, string> {
  const t = planTemplate(id)!;
  const out: Record<string, string> = {};
  t.steps.forEach((s, i) => {
    const from = stepIds[i];
    const to = s.sendBackTo !== undefined ? stepIds[s.sendBackTo] : undefined;
    if (from && to) out[from] = to;
  });
  return out;
}

/**
 * Where Ask for changes on the person step at `index` sends the plan back to: the plan's
 * `sendBackTo` for that step when it names an earlier agent step, else the nearest earlier agent
 * step; null when there is none (a plain approval with no agent step before it).
 */
export function sendBackTarget(
  steps: readonly string[],
  types: Readonly<Record<string, string | undefined>>,
  index: number,
  map?: Readonly<Record<string, string>> | null,
): number | null {
  const agentAt = (i: number) =>
    i >= 0 &&
    i < index &&
    outcomeKind(types[steps[i]!] ?? '') === 'agent' &&
    outcomeType(types[steps[i]!] ?? '') !== null;
  const named = map?.[steps[index]!];
  const at = named !== undefined ? steps.indexOf(named) : -1;
  if (agentAt(at)) return at;
  for (let i = index - 1; i >= 0; i--) if (agentAt(i)) return i;
  return null;
}
