import { describe, expect, it } from 'vitest';
import { matchReason, searchCommands, WAITING_ON_ME, type Searchable } from './commandSearch';

const item = (id: string, label: string, over: Partial<Searchable> = {}): Searchable => ({
  id,
  label,
  group: 'Items',
  ...over,
});

describe('palette search', () => {
  it('ranks an exact title above a prefix, a word start and an agent', () => {
    const list = [
      item('a', 'Billing usage report'),
      item('b', 'Usage-based billing'),
      item('c', 'Usage', { group: 'Agents' }),
      item('d', 'Reusage notes'),
    ];
    expect(searchCommands(list, 'usage').map((x) => x.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('does not fuzzy match', () => {
    const list = [
      item('a', 'Faster search'),
      item('b', 'Forge'),
      item('c', 'Two-factor'),
      item('d', 'Dark mode'),
    ];
    expect(searchCommands(list, 'Faster').map((x) => x.id)).toEqual(['a']);
  });

  it('searches the description, below the title', () => {
    const list = [item('a', 'Pricing', { body: 'compare invoices' }), item('b', 'Invoices page')];
    expect(searchCommands(list, 'invoices').map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('narrows with a type, a project name and waiting on me', () => {
    const list = [
      item('a', 'Login broken', { tags: ['Portal', 'bug'] }),
      item('b', 'Dark mode', { tags: ['Portal', 'idea', WAITING_ON_ME] }),
      item('c', 'Crash on save', { tags: ['Mobile', 'bug', WAITING_ON_ME] }),
    ];
    expect(searchCommands(list, 'bug').map((x) => x.id)).toEqual(['a', 'c']);
    expect(searchCommands(list, 'portal bug').map((x) => x.id)).toEqual(['a']);
    expect(searchCommands(list, 'waiting on me').map((x) => x.id)).toEqual(['b', 'c']);
    expect(searchCommands(list, 'waiting on me bug').map((x) => x.id)).toEqual(['c']);
  });

  it('keeps the given order for an empty query', () => {
    const list = [item('a', 'B'), item('b', 'A')];
    expect(searchCommands(list, '  ').map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('ignores case and accents', () => {
    expect(searchCommands([item('a', 'Café menu')], 'CAFE').length).toBe(1);
  });

  it('ranks items of that type before titles containing the word, and says why', () => {
    const list = [
      item('t', 'Bug triage notes', { tags: ['Portal', 'task'], type: 'task' }),
      item('b', 'Login broken', { tags: ['Portal', 'bug'], type: 'bug' }),
    ];
    expect(searchCommands(list, 'bug').map((x) => x.id)).toEqual(['b', 't']);
    expect(matchReason(list[1]!, 'bug')).toBe('type: bug');
    expect(matchReason(list[0]!, 'bug')).toBeNull();
    expect(matchReason(item('d', 'Pricing', { body: 'compare invoices' }), 'invoices')).toBe(
      'description',
    );
  });
});
