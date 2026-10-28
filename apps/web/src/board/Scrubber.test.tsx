import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Scrubber } from './Scrubber';

const e = (id: string, count: number) => ({ id, name: id, kind: 'agent' as const, count, mine: 0 });

describe('Scrubber', () => {
  it('renders nothing on an empty board (no stray dot above the column)', () => {
    const { container } = render(
      <Scrubber entries={[e('a', 0), e('b', 0)]} activeId={null} onJump={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
  it('renders the steps once there are items', () => {
    render(<Scrubber entries={[e('a', 0), e('b', 2)]} activeId={null} onJump={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Steps' })).toBeTruthy();
  });
});
