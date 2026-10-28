import type { ItemType } from '@hive/shared';

/** The types a person can pick when adding an item (findings only come from agents). */
export type CaptureType = Exclude<ItemType, 'finding'>;

export const CAPTURE_TYPES: Array<{ value: CaptureType; label: string }> = [
  { value: 'idea', label: 'Idea' },
  { value: 'request', label: 'Request' },
  { value: 'bug', label: 'Bug' },
  { value: 'task', label: 'Task' },
];

export const typeLabel = (t: CaptureType): string =>
  CAPTURE_TYPES.find((x) => x.value === t)?.label ?? 'Idea';

const LABELLED = /^\s*(bug|request|task|idea)\s*[:\-–]/i;
const BUG =
  /\b(bug|crash(?:es|ed|ing)?|broken|breaks?|error|exception|regression|does(?:n't| not) work|not working|doesn't load|fails?|failing|failed|wrong|typo)\b/i;
const REQUEST =
  /^\s*(?:please\b|can we\b|can you\b|could we\b|could you\b|would you\b|we need\b|i need\b|need\b|request\b|customer (?:asks?|wants?)\b|client (?:asks?|wants?)\b)/i;
const TASK =
  /^\s*(?:add|update|fix|write|send|call|email|buy|book|set up|setup|review|schedule|remove|delete|rename|move|check|publish|draft|prepare|renew|pay|order|follow up|clean up|upgrade)\b/i;

/**
 * Guesses what the person is adding from how the text starts and reads. A label such as "Bug:"
 * wins; otherwise bug words, then a polite ask, then a leading verb; the default is an idea.
 * The result is always shown to the person as a chip they can change, never applied silently.
 */
export function guessType(text: string): CaptureType {
  const t = text.trim();
  if (!t) return 'idea';
  const label = LABELLED.exec(t);
  if (label) return label[1]!.toLowerCase() as CaptureType;
  if (BUG.test(t)) return 'bug';
  if (REQUEST.test(t)) return 'request';
  if (TASK.test(t)) return 'task';
  return 'idea';
}

export interface ProjectRef {
  id: string;
  name: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Finds the project a "#name" tag points at: the name (or one of its words) starts with it. */
export function matchTag(tag: string, projects: ProjectRef[]): ProjectRef | null {
  const t = slug(tag);
  if (!t) return null;
  const exact = projects.find((p) => slug(p.name) === t);
  if (exact) return exact;
  const start = projects.find((p) => slug(p.name).startsWith(t));
  if (start) return start;
  return (
    projects.find((p) =>
      p.name
        .split(/[\s&/,-]+/)
        .filter(Boolean)
        .some((w) => slug(w).startsWith(t)),
    ) ?? null
  );
}

const TAG = /(^|\s)#([\p{L}\p{N}_-]+)(?=\s|$)/gu;

/** The project named by a "#name" tag in the text (the last one that matches), and the text without it. */
export function parseTags(
  text: string,
  projects: ProjectRef[],
): { project: ProjectRef | null; text: string } {
  let project: ProjectRef | null = null;
  const cleaned = text.replace(TAG, (whole, pre: string, name: string) => {
    const hit = matchTag(name, projects);
    if (!hit) return whole;
    project = hit;
    return pre;
  });
  return { project, text: project ? cleaned.replace(/ {2,}/g, ' ').trim() : text };
}

/** The project the box starts on: the one being looked at, else the last used, else the first. */
export function defaultProject(
  projects: ProjectRef[],
  current: string | null | undefined,
  last: string | null | undefined,
): ProjectRef | null {
  const by = (id: string | null | undefined) => projects.find((p) => p.id === id) ?? null;
  return by(current) ?? by(last) ?? projects[0] ?? null;
}

/** The first line is the title; anything after it (pasted text with line breaks) is the details. */
export function splitPaste(text: string): { title: string; details: string } {
  const [first = '', ...rest] = text.replace(/\r\n?/g, '\n').split('\n');
  return { title: first.trim(), details: rest.join('\n').trim() };
}

export const MAX_TITLE = 300;
export const FILE_LIMIT = 900 * 1024;

const kbOf = (n: number) => `${Math.ceil(n / 1024)} KB`;

/**
 * The refusal for a file over FILE_LIMIT, worded like the CLI. The limit counts what is stored:
 * images and PDFs are base64 data URLs (a third bigger), so their file limit is about 675 KB.
 */
export function fileTooBigMessage(
  name: string,
  kind: PickedFile['kind'],
  fileBytes: number,
  storedLength: number,
): string {
  const encoded = kind === 'image' || kind === 'pdf';
  const limit = kbOf(FILE_LIMIT);
  if (!encoded) return `${name} is ${kbOf(fileBytes)}, over the ${limit} limit for attachments.`;
  return `${name} is ${kbOf(fileBytes)} (${kbOf(storedLength)} once encoded), over the ${limit} limit for attachments, which is about ${kbOf((FILE_LIMIT * 3) / 4)} for an image or PDF file.`;
}

export interface PickedFile {
  name: string;
  kind: 'image' | 'pdf' | 'text' | 'markdown' | 'html';
  /** A data: URL for images and PDFs, the text itself for the rest. */
  content: string;
  bytes: number;
}

/** What kind of attachment a file is, from its type and name; null when it cannot be attached. */
export function fileKind(file: { name: string; type: string }): PickedFile['kind'] | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  if (/\.(md|markdown)$/i.test(file.name)) return 'markdown';
  if (/\.html?$/i.test(file.name) || file.type === 'text/html') return 'html';
  if (file.type.startsWith('text/') || /\.(txt|log|csv|json)$/i.test(file.name)) return 'text';
  return null;
}

/** What is in the box. `type: null` means "use the guess"; picking a chip fixes it. */
export interface Draft {
  title: string;
  details: string;
  type: CaptureType | null;
  projectId: string | null;
  files: PickedFile[];
}

export const emptyDraft = (projectId: string | null): Draft => ({
  title: '',
  details: '',
  type: null,
  projectId,
  files: [],
});

export interface Resolved {
  project: ProjectRef | null;
  /** The title as it will be saved: trimmed, without the #tag. */
  title: string;
  type: CaptureType;
  /** The type is the guess, not the person's choice (the chip says so). */
  guessed: boolean;
}

/** Turns what is typed into what will be saved: the "#name" project, the cleaned title, the type. */
export function resolveDraft(draft: Draft, projects: ProjectRef[]): Resolved {
  const tagged = parseTags(draft.title, projects);
  const project =
    tagged.project ?? projects.find((p) => p.id === draft.projectId) ?? projects[0] ?? null;
  const title = (tagged.project ? tagged.text : draft.title).trim();
  return {
    project,
    title,
    type: draft.type ?? guessType(title),
    guessed: draft.type === null,
  };
}
