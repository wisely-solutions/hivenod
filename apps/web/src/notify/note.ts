import { reminderNote, type Item, type Notified, type Project } from '@hive/shared';

export const NO_REMINDERS: ReadonlyMap<string, Notified> = new Map();

/** "30 h" up to three days, then "4 d": a gate past its reminder time is measured in hours. */
export function waitedText(sinceMs: number, nowMs: number): string {
  const h = Math.max(1, Math.round((nowMs - sinceMs) / 3_600_000));
  return h < 72 ? `${h} h` : `${Math.round(h / 24)} d`;
}

/** "Waiting 30 h · reminder sent" once the gate's reminder time has passed, otherwise null. */
export function gateWaitNote(input: {
  project: Pick<Project, 'steps'>;
  item: Pick<Item, 'stepId' | 'sendBackCount' | 'status'>;
  itemId: string;
  sinceMs: number;
  nowMs: number;
  reminders: ReadonlyMap<string, Notified>;
}): string | null {
  const step = input.project.steps.find((s) => s.id === input.item.stepId);
  if (input.item.status !== 'waiting' || step?.kind !== 'human' || !step.gate) return null;
  const note = reminderNote({
    sinceMs: input.sinceMs,
    nowMs: input.nowMs,
    remindAfterHours: step.gate.remindAfterHours,
    item: input.item,
    notified: input.reminders.get(input.itemId),
  });
  return note ? `Waiting ${waitedText(input.sinceMs, input.nowMs)} · reminder ${note}` : null;
}
