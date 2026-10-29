/**
 * The Today brief (item kt3E7u9EliL3q2veDDI0, design 3.1): 2-3 sentences written by the app from
 * counts, speaking as "Your agents" (several agents in several organizations feed one member).
 * Nothing is stored: it is free, instant and never stale.
 */

/** The colour of one segment of the brief's bar: a decision's rank band, or green once made. */
export type Segment = 'red' | 'amber' | 'grey' | 'green';

export interface BriefInput {
  /** Messages that came in during the last 24 hours, and from how many distinct sources. */
  messages: number;
  sources: number;
  /** Open proposals on threads in the stack, and agent questions waiting. */
  proposals: number;
  questions: number;
  /** Project entries in the stack (approvals, questions, path changes, findings). */
  projectEntries: number;
  tidyUps: number;
  /** Threads agents are investigating (for the empty brief). */
  working: number;
  /** The first decision of the stack. */
  top: { title: string; due: string | null; urgent: boolean } | null;
  /** One per decision in the stack, in order; decisions made this visit come back green. */
  segments: Segment[];
}

export interface Brief {
  sentences: string[];
  minutes: number;
  segments: Segment[];
  /** Nothing waits: the all-caught-up state follows. */
  empty: boolean;
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export function briefOf(i: BriefInput): Brief {
  const decisions = i.proposals + i.projectEntries;
  const waiting = decisions + i.questions + i.tidyUps;
  const open = i.segments.filter((s) => s !== 'green').length;
  const minutes =
    waiting === 0 ? 0 : Math.ceil((decisions * 30 + i.questions * 60 + (i.tidyUps ? 15 : 0)) / 60);
  if (open === 0 && i.tidyUps === 0)
    return {
      sentences: [
        // The all-caught-up state below says "Nothing needs you." itself.
        i.working > 0
          ? `You are all caught up. Your agents are on ${n(i.working, 'thread')}.`
          : 'You are all caught up.',
      ],
      minutes: 0,
      segments: i.segments,
      empty: true,
    };
  const sentences: string[] = [];
  sentences.push(
    i.messages > 0
      ? `In the last 24 hours ${n(i.messages, 'message')} came in from ${n(i.sources, 'place')}.`
      : 'No new messages in the last 24 hours.',
  );
  const did: string[] = [];
  if (i.proposals) did.push(`drafted ${n(i.proposals, 'proposal')}`);
  if (i.questions) did.push(`asked ${n(i.questions, 'question')}`);
  const tidy = i.tidyUps ? `, plus ${n(i.tidyUps, 'tidy-up')}` : '';
  const need = `${open} need${open === 1 ? 's' : ''} you${tidy}`;
  sentences.push(
    did.length
      ? `Your agents ${did.join(' and ')}: ${need}.`
      : `${need[0]!.toUpperCase()}${need.slice(1)}.`,
  );
  if (i.top) {
    const why = i.top.urgent
      ? i.top.due
        ? ` (urgent, due ${i.top.due})`
        : ' (urgent)'
      : i.top.due
        ? ` (due ${i.top.due})`
        : '';
    sentences.push(`Most pressing: ${i.top.title}${why}.`);
  }
  return { sentences, minutes, segments: i.segments, empty: false };
}
