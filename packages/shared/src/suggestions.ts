/**
 * Agent suggestions (card TU5pDmzE): findings nobody has triaged yet. They live at the first
 * step with status `suggested` and are shown in a lane at the top of that column.
 */
import type { Item, Project } from './schema';

/** True for an agent finding that still waits for a person to add or dismiss it. */
export function isSuggestion(item: Pick<Item, 'type' | 'status' | 'triage'>): boolean {
  return item.type === 'finding' && item.status === 'suggested' && !item.triage;
}

/**
 * Who may triage suggestions in a project: organization admins, the project's creator, and the
 * deciders of the first step when that step is a gate.
 *
 * THE ONE PLACE to change this (João's confirmation is pending, card TU5pDmzE). It mirrors
 * `canTriage()` in firestore.rules: change both together; the rules tests in
 * packages/shared/rules/decisions.test.ts ("suggestions") check the rules side.
 */
export function canTriage(
  project: Pick<Project, 'steps' | 'createdBy'>,
  uid: string,
  isAdmin: boolean,
): boolean {
  if (isAdmin || project.createdBy === uid) return true;
  const first = project.steps[0];
  return first?.kind === 'human' && !!first.gate?.deciderUids.includes(uid);
}
