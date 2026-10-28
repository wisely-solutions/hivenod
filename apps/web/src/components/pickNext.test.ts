import { describe, expect, it } from 'vitest';
import { pickNext } from './DonePanel';

describe('pickNext', () => {
  const todo = [
    { pid: 'b', itemId: '1' },
    { pid: 'a', itemId: '2' },
    { pid: 'a', itemId: '3' },
  ];
  it('prefers the same project', () => expect(pickNext(todo, 'a', '9')).toEqual(todo[1]));
  it('skips the current item', () => expect(pickNext(todo, 'a', '2')).toEqual(todo[2]));
  it('falls back to the oldest overall', () => expect(pickNext(todo, 'c', '9')).toEqual(todo[0]));
  it('is undefined when nothing waits', () => expect(pickNext([], 'a', '1')).toBeUndefined());
});
