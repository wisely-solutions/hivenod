import { outcomeType, type Decision } from '@hive/shared';

/**
 * One definition of "sent back" for every screen (Insights, agent profile, CSV):
 * only the sentBack outcome. A stop is counted separately, never as a send back.
 */
export const isSentBack = (outcome: Decision['outcome']): boolean => outcome === 'sentBack';

/** The app's label for a decision outcome (also used in the CSV Decision column). */
export function outcomeName(outcome: Decision['outcome']): string {
  switch (outcome) {
    case 'approved':
      return 'Approved';
    case 'sentBack':
      return 'Sent back';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Answered';
  }
}

/**
 * "When you approve, <agent> will…" (item kt3E7u9EliL3q2veDDI0, design 3.8): 1-3 lines built
 * from an inbox outcome's type and fields, the registry's executor and after-state. Nothing is
 * stored. `channel` is where the thread came in (the reply goes back there).
 */
export function effectLines(
  type: string,
  fields: Readonly<Record<string, string | boolean | undefined>>,
  ctx: { agent: string; channel?: string; to?: string },
): { lead: string; lines: string[] } {
  const t = outcomeType(type);
  // Retired with Calendar (slice 5): old bookings are never approved now.
  if (t?.retired)
    return {
      lead: 'Bookings were removed with Calendar:',
      lines: ['This proposal can only be rejected'],
    };
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const on = ctx.channel ? ` on ${ctx.channel}` : '';
  const to = ctx.to ? ` to ${ctx.to}` : '';
  const lead =
    t?.executor === 'none'
      ? 'When you approve, it takes effect at once:'
      : `When you approve, ${ctx.agent} will:`;
  const lines: string[] = [];
  const at = (iso: unknown) => {
    const ms = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (Number.isNaN(ms)) return '';
    const d = new Date(ms);
    return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  switch (type) {
    case 'reply':
      lines.push(`Send ${fields.holding ? 'the holding reply' : 'the reply'}${to}${on}, as you`);
      break;
    case 'nudge':
      lines.push(`Send the reminder${to}${on}, as you`);
      break;
    case 'make_it_work':
      lines.push(
        `Create the item “${s(fields.title)}”${s(fields.project) ? ` in ${s(fields.project)}` : ''}`,
      );
      break;
    case 'handover':
      lines.push(`Hand it over to ${s(fields.to)}`);
      break;
    case 'snooze':
      lines.push(`Snooze it until ${at(fields.until)}; nothing is sent`);
      break;
    case 'no_reply':
      lines.push('Close the thread; nothing is sent');
      break;
    case 'ignore':
      lines.push('Ignore the thread; nothing is sent');
      break;
  }
  const after = t?.after;
  if (after?.state === 'waiting' && type !== 'snooze')
    lines.push(
      after.waitingOn === 'item'
        ? 'Keep the thread waiting on the item'
        : after.waitingOn === 'thirdParty'
          ? 'Keep the thread waiting on them'
          : 'Mark the thread “Waiting on them” until they answer',
    );
  return { lead, lines: lines.slice(0, 3) };
}
