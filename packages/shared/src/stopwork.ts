/**
 * Stop work from the UI (card BrK0r2FE): a person ends an agent's run on an item, either going
 * back (the item waits on hold at its step until someone presses Resume) or cancelling it
 * completely (the item is stopped, like a stop at a gate).
 */
import type { Item, Project } from './schema';

/**
 * The gate step that lets `uid` stop work in this project, or null. Admins need none (''): they
 * may always. Anyone else must decide at some gate of the project; the action names that gate in
 * its event (`gateStepId`) so the rules can check it without a loop.
 *
 * THE ONE PLACE to change who may stop work. It mirrors `canStopWork()` in firestore.rules: change
 * both together; packages/shared/rules/stopwork.test.ts checks the rules side.
 */
export function stopGateFor(
  project: Pick<Project, 'steps'>,
  uid: string,
  isAdmin: boolean,
): string | null {
  if (isAdmin) return '';
  const gate = project.steps.find((s) => s.kind === 'human' && s.gate?.deciderUids.includes(uid));
  return gate ? gate.id : null;
}

/** Admins and the people who decide at a gate of this project may stop and resume agent work. */
export function canStopWork(project: Pick<Project, 'steps'>, uid: string, isAdmin: boolean) {
  return stopGateFor(project, uid, isAdmin) !== null;
}

/** An agent holds the item at an agent step (or is shaping it): there is work to stop. */
export function isWorkStoppable(
  project: Pick<Project, 'steps'>,
  item: Pick<Item, 'claim' | 'stepId' | 'status'> & Partial<Pick<Item, 'shape'>>,
): boolean {
  const step = project.steps.find((s) => s.id === item.stepId);
  return (
    !!item.claim &&
    (step?.kind === 'agent' || item.shape === null) &&
    (item.status === 'working' || item.status === 'queued')
  );
}

/** Held after "Go back": waits at its step until someone presses Resume; no agent may claim it. */
export function isOnHold(item: Pick<Item, 'workStopped' | 'status'>): boolean {
  return item.workStopped?.mode === 'back' && item.status !== 'stopped';
}
