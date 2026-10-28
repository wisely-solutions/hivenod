import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CaptureComposer } from './CaptureComposer';
import { clearJustAdded, markJustAdded, useJustAdded } from './justAdded';
import { emptyDraft, type Draft } from './logic';

const projects = [
  { id: 'p1', name: 'Blog', emoji: '✍️' },
  { id: 'p2', name: 'Website', emoji: '🌐' },
];

function Harness({
  onSubmit,
  variant = 'sheet',
}: {
  onSubmit: (keepOpen: boolean, draft: Draft) => void;
  variant?: 'sheet' | 'inline';
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft('p1'));
  return (
    <CaptureComposer
      draft={draft}
      onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
      projects={projects}
      variant={variant}
      onSubmit={(keep) => onSubmit(keep, draft)}
    />
  );
}

const title = () => screen.getByLabelText(/^(Title|Add an idea)/);

describe('CaptureComposer', () => {
  it('shows the guessed type as a chip that says so, and a picked type replaces the guess', () => {
    render(<Harness onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Type')).toHaveValue('idea');
    fireEvent.change(title(), { target: { value: 'Bug: the footer overlaps' } });
    expect(screen.getByLabelText('Type')).toHaveValue('bug');
    expect(screen.getByText(/guessed/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'task' } });
    fireEvent.change(title(), { target: { value: 'Bug: something else' } });
    expect(screen.getByLabelText('Type')).toHaveValue('task');
    expect(screen.queryByText(/guessed/)).toBeNull();
  });

  it('#name switches the project chip', () => {
    render(<Harness onSubmit={vi.fn()} />);
    expect(screen.getByLabelText('Project')).toHaveValue('p1');
    fireEvent.change(title(), { target: { value: 'Fix nav #web' } });
    expect(screen.getByLabelText('Project')).toHaveValue('p2');
  });

  it('Enter adds, Cmd+Enter adds and keeps open, Shift+Enter goes to the details', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(title(), { target: { value: 'One' } });
    fireEvent.keyDown(title(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenLastCalledWith(false, expect.anything());
    fireEvent.keyDown(title(), { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith(true, expect.anything());
    onSubmit.mockClear();
    fireEvent.keyDown(title(), { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Details (optional)')).toHaveFocus();
  });

  it('keeps Add disabled until there is a title', () => {
    render(<Harness onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    fireEvent.change(title(), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
  });

  it('splits a pasted multi-line text into title and details', () => {
    render(<Harness onSubmit={vi.fn()} />);
    fireEvent.paste(title(), {
      clipboardData: { files: [], getData: () => 'Title line\nmore detail' },
    });
    expect(title()).toHaveValue('Title line');
    expect(screen.getByLabelText('Details (optional)')).toHaveValue('more detail');
  });

  it('attaches a pasted image and can remove it', async () => {
    render(<Harness onSubmit={vi.fn()} />);
    const file = new File(['abc'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(title(), { clipboardData: { files: [file], getData: () => '' } });
    expect(await screen.findByText('shot.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    expect(screen.queryByText('shot.png')).toBeNull();
  });

  it('refuses a file type it cannot attach', async () => {
    render(<Harness onSubmit={vi.fn()} />);
    const file = new File(['abc'], 'a.zip', { type: 'application/zip' });
    fireEvent.drop(title().closest('form')!, { dataTransfer: { files: [file] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/can't be attached/);
  });

  it('inline: one line, type chip, no details, no project chip, Enter adds', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} variant="inline" />);
    expect(screen.queryByLabelText('Project')).toBeNull();
    expect(screen.queryByLabelText('Details (optional)')).toBeNull();
    expect(screen.getByLabelText('Type')).toBeInTheDocument();
    fireEvent.change(title(), { target: { value: 'Fix the footer' } });
    fireEvent.keyDown(title(), { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith(false, expect.anything());
  });
});

describe('justAdded', () => {
  function Probe({ id }: { id: string }) {
    const [on, ref] = useJustAdded(id);
    return (
      <div ref={ref} data-on={on}>
        {id}
      </div>
    );
  }
  it('lights only the item just added, and clears', () => {
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    act(() => markJustAdded('b'));
    expect(screen.getByText('b')).toHaveAttribute('data-on', 'true');
    expect(screen.getByText('a')).toHaveAttribute('data-on', 'false');
    act(() => clearJustAdded());
    expect(screen.getByText('b')).toHaveAttribute('data-on', 'false');
  });
});
