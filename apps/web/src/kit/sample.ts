import type { ItemCardData } from '../ui/card';
import type { StepperStep } from '../ui/feedback';

export const STEPS: StepperStep[] = [
  {
    id: 'intake',
    name: 'Intake',
    description: 'The idea or request as it first came in.',
    kind: 'agent',
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Agents gather facts and sources.',
    kind: 'agent',
    tag: 'Most common',
  },
  {
    id: 'gonogo',
    name: 'Go or no-go',
    description: 'You decide if this is worth building.',
    kind: 'human',
  },
  {
    id: 'spec',
    name: 'Draft spec',
    description: 'An agent writes the plan to review.',
    kind: 'agent',
  },
  {
    id: 'approve',
    name: 'Approve spec',
    description: 'You approve the plan before work starts.',
    kind: 'human',
  },
  { id: 'build', name: 'Build', description: 'Agents build it and report back.', kind: 'agent' },
];

export const INBOX: ItemCardData[] = [
  {
    id: 'a',
    title: 'Weekly digest: pick the three lead stories',
    type: 'request',
    attachments: 'report.html · 2 more',
    agent: { name: 'Research agent', color: 1, live: false },
    approvals: { have: 1, need: 2 },
    waitingForYou: true,
  },
  {
    id: 'b',
    title: 'Pricing page copy is too long on phones',
    type: 'bug',
    attachments: 'before.png',
    agent: { name: 'Writer', color: 3 },
    sendBacks: 2,
    waitingForYou: true,
  },
  {
    id: 'c',
    title: 'Add export to CSV on the decision log',
    type: 'finding',
    foundBy: 'Builder on Insights page',
    agent: { name: 'Builder', color: 6 },
    waitingForYou: true,
  },
];

export const BOARD_ITEMS: ItemCardData[] = [
  {
    id: 'r1',
    title: 'Compare three hosting options',
    type: 'task',
    agent: { name: 'Research agent', color: 1, live: true },
    progress: { done: 3, total: 5 },
  },
  {
    id: 'r2',
    title: 'Collect competitor onboarding flows',
    type: 'task',
    agent: { name: 'Research agent', color: 1 },
    progress: { done: 1, total: 4 },
    sendBacks: 1,
  },
];

export const AGENT_NAMES = [
  'Research agent',
  'Writer',
  'Planner',
  'Builder',
  'Reviewer',
  'Scout',
  'Editor',
  'Analyst',
];

/** A tiny inline portrait so the human avatar needs no network (CSP allows data: images). */
export const PORTRAIT =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#d9c7a8"/><circle cx="32" cy="25" r="11" fill="#7a5a3a"/><path d="M8 64c2-17 14-24 24-24s22 7 24 24z" fill="#3b4a5c"/></svg>',
  );
