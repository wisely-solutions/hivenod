import { describe, expect, it } from 'vitest';
import { createMatcher, isActivationTarget, type Shortcut } from './shortcuts';

const mk = (id: string, keys: string[]): Shortcut => ({
  id,
  keys,
  label: id,
  group: 'g',
  run: () => {},
});

describe('shortcut matcher', () => {
  const list = [mk('next', ['j']), mk('needs', ['g', 'n']), mk('projects', ['g', 'p'])];

  it('matches single keys', () => {
    const press = createMatcher(() => list);
    expect(press('j')?.id).toBe('next');
    expect(press('x')).toBeNull();
  });

  it('matches two-key sequences within the window', () => {
    let t = 0;
    const press = createMatcher(
      () => list,
      () => t,
    );
    expect(press('g')).toBeNull();
    t = 400;
    expect(press('p')?.id).toBe('projects');
  });

  it('drops a sequence that is too slow or broken', () => {
    let t = 0;
    const press = createMatcher(
      () => list,
      () => t,
    );
    press('g');
    t = 2000;
    expect(press('n')).toBeNull();
    press('g');
    expect(press('x')).toBeNull();
    expect(press('n')).toBeNull();
  });
});

describe('activation targets', () => {
  it('treats buttons and links as owners of Enter and Space', () => {
    document.body.innerHTML =
      '<button id="b"><span id="s"></span></button><a id="a" href="/x">x</a><div id="d"></div>';
    const el = (id: string) => document.getElementById(id);
    expect(isActivationTarget(el('b'))).toBe(true);
    expect(isActivationTarget(el('s'))).toBe(true);
    expect(isActivationTarget(el('a'))).toBe(true);
    expect(isActivationTarget(el('d'))).toBe(false);
    expect(isActivationTarget(null)).toBe(false);
  });
});
