/**
 * Ask the agent (item w6O2KOw4ys70TQv9I1xD): the quick chips that fit a thread now, computed in
 * the browser, nothing stored. The home agent's suggestions (suggestedChips) come first, then:
 *  - prepare_meeting: a booking (reply_book or book) approved or done, starting in the next 7 days;
 *  - recheck: an open proposal (or an unrun live-plan step) may be out of date (stale.ts);
 *  - follow_up: the thread waits on them, with no message for 3 days or more;
 *  - summarize: 8 messages or more;
 *  - draft_reply: nothing is open (no proposal, no live plan) and the last message is theirs.
 * At most 3 are shown. Re-check only where a Re-check may be asked (Your call or waiting).
 */
import type { InboxThread, InstructChip } from './inbox';
import { INSTRUCT_CHIPS } from './inbox';
import { staleReason, type StaleOutcomeOf } from './stale';

export const CHIPS_SHOWN = 3;
export const FOLLOW_UP_AFTER_MS = 3 * 86_400_000;
export const PREPARE_WITHIN_MS = 7 * 86_400_000;
export const SUMMARIZE_FROM = 8;

type Ms = { toMillis(): number } | null | undefined;

export interface ChipThreadOf {
  state: InboxThread['state'];
  waiting?: { on: string } | null;
  lastMessageAt?: Ms;
  suggestedChips?: readonly string[];
}
export type ChipOutcomeOf = StaleOutcomeOf & { type: string };

export function contextChips(input: {
  thread: ChipThreadOf;
  /** The thread's outcomes. */
  outcomes: readonly ChipOutcomeOf[];
  /** Messages, oldest first (only the direction matters); undefined: not loaded. */
  messages?: ReadonlyArray<{ direction: 'in' | 'out' }>;
  /** A live plan is on the thread. */
  livePlan?: boolean;
  /** Re-check may be asked now (useRecheck's `can`). */
  canRecheck: boolean;
  /** A live plan's step that has not run may be out of date (the plan panel works it out). */
  staleStep?: boolean;
  nowMs: number;
}): InstructChip[] {
  const { thread: t, outcomes, messages, nowMs } = input;
  const fits = (c: InstructChip): boolean => {
    switch (c) {
      case 'prepare_meeting':
        return outcomes.some((o) => {
          if (o.type !== 'reply_book' && o.type !== 'book') return false;
          if (o.state !== 'approved' && o.state !== 'done') return false;
          const start = typeof o.fields.start === 'string' ? Date.parse(o.fields.start) : NaN;
          return !Number.isNaN(start) && start > nowMs && start - nowMs <= PREPARE_WITHIN_MS;
        });
      case 'recheck':
        return (
          input.canRecheck &&
          (!!input.staleStep ||
            outcomes.some((o) => o.state === 'proposed' && staleReason(o, t, nowMs) !== null))
        );
      case 'follow_up': {
        const last = t.lastMessageAt?.toMillis();
        return (
          t.state === 'waiting' &&
          t.waiting?.on === 'them' &&
          last !== undefined &&
          nowMs - last >= FOLLOW_UP_AFTER_MS
        );
      }
      case 'summarize':
        return (messages?.length ?? 0) >= SUMMARIZE_FROM;
      case 'draft_reply': {
        const open = outcomes.some((o) => ['proposed', 'revising', 'approved'].includes(o.state));
        const last = messages?.[messages.length - 1];
        return !open && !input.livePlan && last?.direction === 'in';
      }
    }
  };
  const known = (c: string): c is InstructChip => (INSTRUCT_CHIPS as readonly string[]).includes(c);
  const suggested = (t.suggestedChips ?? []).filter(known);
  // The agent's suggestions are shown as it set them (Re-check still needs a request to be possible).
  const out: InstructChip[] = [];
  for (const c of suggested)
    if (!out.includes(c) && (c !== 'recheck' || input.canRecheck)) out.push(c);
  for (const c of INSTRUCT_CHIPS) if (!out.includes(c) && fits(c)) out.push(c);
  return out.slice(0, CHIPS_SHOWN);
}
