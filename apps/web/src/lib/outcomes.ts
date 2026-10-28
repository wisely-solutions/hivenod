import type { Decision } from '@hive/shared';

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
