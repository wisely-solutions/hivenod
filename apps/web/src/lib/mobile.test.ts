import { describe, expect, it } from 'vitest';
import {
  classifySwipe,
  growHeight,
  isEdgeStart,
  keyboardInset,
  maxFieldHeight,
  ownsGesture,
  revealDelta,
} from './mobile';

describe('classifySwipe', () => {
  it('reads fast horizontal moves as left and right', () => {
    expect(classifySwipe({ dx: -120, dy: 10, ms: 200, startX: 200 })).toBe('left');
    expect(classifySwipe({ dx: 120, dy: -20, ms: 200, startX: 200 })).toBe('right');
  });
  it('ignores short, slow or diagonal moves', () => {
    expect(classifySwipe({ dx: 40, dy: 0, ms: 100, startX: 100 })).toBeNull();
    expect(classifySwipe({ dx: 200, dy: 0, ms: 1200, startX: 100 })).toBeNull();
    expect(classifySwipe({ dx: 100, dy: 90, ms: 200, startX: 100 })).toBeNull();
  });
  it('reads a long vertical pull as down, never up', () => {
    expect(classifySwipe({ dx: 5, dy: 160, ms: 300, startX: 100 })).toBe('down');
    expect(classifySwipe({ dx: 5, dy: -160, ms: 300, startX: 100 })).toBeNull();
    // slow pulls close too (tester R58: 400 px at 780 ms, 600 px at 900 ms)
    expect(classifySwipe({ dx: 5, dy: 400, ms: 780, startX: 100 })).toBe('down');
    expect(classifySwipe({ dx: 5, dy: 600, ms: 900, startX: 100 })).toBe('down');
    expect(classifySwipe({ dx: 5, dy: 160, ms: 9000, startX: 100 })).toBeNull();
    expect(classifySwipe({ dx: 5, dy: 60, ms: 300, startX: 100 })).toBeNull();
  });
  it('knows the left edge', () => {
    expect(isEdgeStart(10)).toBe(true);
    expect(isEdgeStart(60)).toBe(false);
  });
});

describe('keyboardInset', () => {
  it('is the covered height when a keyboard is up', () => {
    expect(keyboardInset(667, 380, 0)).toBe(287);
  });
  it('ignores browser chrome changes and a scrolled visual viewport', () => {
    expect(keyboardInset(667, 620, 0)).toBe(0);
    expect(keyboardInset(667, 380, 287)).toBe(0);
  });
});

describe('growHeight', () => {
  it('stays between the bounds', () => {
    expect(growHeight(40, 96, 240)).toBe(96);
    expect(growHeight(150, 96, 240)).toBe(150);
    expect(growHeight(900, 96, 240)).toBe(240);
  });
});

describe('revealDelta', () => {
  it('does nothing when the field is already visible', () => {
    expect(revealDelta({ top: 200, bottom: 300 }, 56, 400)).toBe(0);
  });
  it('scrolls down by what the keyboard covers', () => {
    expect(revealDelta({ top: 300, bottom: 420 }, 56, 360)).toBe(60);
  });
  it('keeps the top of a tall field in view', () => {
    expect(revealDelta({ top: 100, bottom: 700 }, 56, 360)).toBe(44);
  });
  it('scrolls up when the field is under the header', () => {
    expect(revealDelta({ top: 10, bottom: 100 }, 56, 360)).toBe(-46);
  });
});

describe('maxFieldHeight', () => {
  it('is 40% of the screen without a keyboard', () => {
    expect(maxFieldHeight(844, 0, 0, 56)).toBe(338);
  });
  it('fits the band above the keyboard and action bar when it is open', () => {
    expect(maxFieldHeight(667, 300, 60, 56)).toBe(227);
    expect(maxFieldHeight(300, 250, 60, 56)).toBe(96);
  });
});

describe('ownsGesture', () => {
  it('lets a pull start on a select that opts in, not on other selects', () => {
    const root = document.createElement('header');
    const a = document.createElement('select');
    a.setAttribute('data-swipe-through', '');
    const b = document.createElement('select');
    root.append(a, b);
    expect(ownsGesture(a, root)).toBe(false);
    expect(ownsGesture(b, root)).toBe(true);
  });
});
