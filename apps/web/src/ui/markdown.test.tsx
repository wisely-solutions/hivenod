import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown, parseBlocks, safeUrl } from './markdown';

describe('markdown', () => {
  it('parses headings, lists, code and paragraphs', () => {
    expect(parseBlocks('# Hi\n\nsome\ntext\n\n- a\n- b\n\n1. x\n\n```\ncode\n```')).toEqual([
      { t: 'h', level: 1, text: 'Hi' },
      { t: 'p', text: 'some text' },
      { t: 'ul', items: ['a', 'b'] },
      { t: 'ol', items: ['x'] },
      { t: 'code', text: 'code' },
    ]);
  });
  it('only links http(s) and never injects markup', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    const { container } = render(
      <Markdown source={'**bold** [ok](https://a.b) [bad](javascript:x) <img src=x onerror=y>'} />,
    );
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', 'https://a.b');
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
  });
  it('lets very long words wrap instead of widening the pane', () => {
    const { container } = render(<Markdown source={'x'.repeat(300)} />);
    expect(container.firstElementChild?.className).toContain('overflow-wrap:anywhere');
  });
});
