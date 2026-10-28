import { describe, expect, it } from 'vitest';
import {
  defaultProject,
  emptyDraft,
  resolveDraft,
  fileKind,
  fileTooBigMessage,
  guessType,
  matchTag,
  parseTags,
  splitPaste,
  type ProjectRef,
} from './logic';

const projects: ProjectRef[] = [
  { id: 'p1', name: 'Blog & newsletter' },
  { id: 'p2', name: 'Website' },
  { id: 'p3', name: 'Billing' },
];

describe('guessType', () => {
  it.each([
    ['Bug: invoice total is wrong', 'bug'],
    ['request - export to CSV', 'request'],
    ['Idea: a weekly digest', 'idea'],
    ['Task: renew the domain', 'task'],
    ['The login page crashes on Safari', 'bug'],
    ['Search is not working', 'bug'],
    ['Please add dark mode', 'request'],
    ['Can we export the board?', 'request'],
    ['Renew the domain', 'task'],
    ['Write the launch post', 'task'],
    ['Post: what clients ask in week one', 'idea'],
    ['A weekly digest of decisions', 'idea'],
    ['', 'idea'],
  ])('%s -> %s', (text, type) => {
    expect(guessType(text)).toBe(type);
  });

  it('lets an explicit label beat the words', () => {
    expect(guessType('Idea: fix the broken footer later')).toBe('idea');
  });
});

describe('matchTag and parseTags', () => {
  it('matches by name, prefix or any word of the name', () => {
    expect(matchTag('website', projects)?.id).toBe('p2');
    expect(matchTag('bill', projects)?.id).toBe('p3');
    expect(matchTag('news', projects)?.id).toBe('p1');
    expect(matchTag('zzz', projects)).toBeNull();
    expect(matchTag('', projects)).toBeNull();
  });

  it('switches project and removes the tag from the title', () => {
    expect(parseTags('Fix the footer #web', projects)).toEqual({
      project: projects[1],
      text: 'Fix the footer',
    });
    expect(parseTags('#bill invoice rounding', projects).project?.id).toBe('p3');
    expect(parseTags('#bill invoice rounding', projects).text).toBe('invoice rounding');
  });

  it('leaves text alone when the tag matches nothing', () => {
    expect(parseTags('Meet at #5', projects)).toEqual({ project: null, text: 'Meet at #5' });
    expect(parseTags('no tags here', projects).project).toBeNull();
  });
});

describe('defaultProject', () => {
  it('prefers the current project, then the last used, then the first', () => {
    expect(defaultProject(projects, 'p2', 'p3')?.id).toBe('p2');
    expect(defaultProject(projects, null, 'p3')?.id).toBe('p3');
    expect(defaultProject(projects, 'gone', 'gone2')?.id).toBe('p1');
    expect(defaultProject([], null, null)).toBeNull();
  });
});

describe('splitPaste', () => {
  it('uses the first line as the title and the rest as details', () => {
    expect(splitPaste('Title\r\n\nmore\nlines')).toEqual({
      title: 'Title',
      details: 'more\nlines',
    });
    expect(splitPaste('one line')).toEqual({ title: 'one line', details: '' });
  });
});

describe('fileKind', () => {
  it('knows images, pdf and text; refuses the rest', () => {
    expect(fileKind({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(fileKind({ name: 'a.pdf', type: 'application/pdf' })).toBe('pdf');
    expect(fileKind({ name: 'a.md', type: '' })).toBe('markdown');
    expect(fileKind({ name: 'a.html', type: 'text/html' })).toBe('html');
    expect(fileKind({ name: 'a.txt', type: 'text/plain' })).toBe('text');
    expect(fileKind({ name: 'a.zip', type: 'application/zip' })).toBeNull();
  });
});

describe('resolveDraft', () => {
  it('uses the chosen project and guesses the type', () => {
    const d = { ...emptyDraft('p2'), title: ' Bug: header overlaps ' };
    expect(resolveDraft(d, projects)).toEqual({
      project: projects[1],
      title: 'Bug: header overlaps',
      type: 'bug',
      guessed: true,
    });
  });

  it('lets #name switch the project and keeps a picked type', () => {
    const d = { ...emptyDraft('p2'), title: 'Invoice is wrong #bill', type: 'task' as const };
    const r = resolveDraft(d, projects);
    expect(r.project?.id).toBe('p3');
    expect(r.title).toBe('Invoice is wrong');
    expect(r.type).toBe('task');
    expect(r.guessed).toBe(false);
  });

  it('falls back to the first project when the chosen one is gone', () => {
    expect(resolveDraft(emptyDraft('gone'), projects).project?.id).toBe('p1');
    expect(resolveDraft(emptyDraft(null), []).project).toBeNull();
  });
});

describe('fileTooBigMessage', () => {
  it('explains the encoded size and the file-terms limit for images, like the CLI', () => {
    const m = fileTooBigMessage('shot.png', 'image', 734 * 1024, 978 * 1024);
    expect(m).toContain('shot.png is 734 KB (978 KB once encoded)');
    expect(m).toContain('over the 900 KB limit');
    expect(m).toContain('about 675 KB');
  });

  it('keeps text simple: the file is what is stored', () => {
    expect(fileTooBigMessage('a.md', 'markdown', 901 * 1024, 901 * 1024)).toBe(
      'a.md is 901 KB, over the 900 KB limit for attachments.',
    );
  });
});
