import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentAvatar, agentColorIndex } from './avatar';
import { Badge, StepPill } from './badge';
import { Button, IconButton } from './button';
import { sentBackText } from './card';
import { Stepper } from './feedback';
import { Input, Segmented, Select } from './form';
import { MotionProvider } from './motion';
import { ToastProvider, useToast } from './overlay';
import { STEPS } from '../kit/sample';
import { contrast } from '../lib/contrast';

describe('Button', () => {
  it('is a real button, 44px class, and does not fire while loading', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const b = screen.getByRole('button', { name: /save/i });
    expect(b).toHaveAttribute('aria-busy', 'true');
    expect(b.className).toContain('min-h-11');
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
  it('fires when idle and is inert when disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button disabled onClick={onClick}>
        Go
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
  });
  it('icon buttons carry their accessible name', () => {
    render(<IconButton label="Close">x</IconButton>);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});

describe('Input', () => {
  it('links label, hint and error', () => {
    render(<Input label="Title" error="Too short" />);
    const input = screen.getByLabelText('Title');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Too short')).toBeInTheDocument();
    expect(input.className).toContain('text-16');
  });
});

describe('avatars and badges', () => {
  it('maps any id to one of eight colours, stably', () => {
    const a = agentColorIndex('agent-1');
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(8);
    expect(agentColorIndex('agent-1')).toBe(a);
  });
  it('announces a live agent', () => {
    render(<AgentAvatar name="Writer" color={3} live />);
    expect(screen.getByRole('img', { name: 'Writer, working now' })).toBeInTheDocument();
  });
  it('shows the count and labels gates as text, not colour alone', () => {
    render(
      <>
        <Badge count={4}>Needs you</Badge>
        <StepPill label="Go or no-go" kind="human" count={2} />
      </>,
    );
    expect(screen.getByText('Needs you')).toBeInTheDocument();
    expect(screen.getByText(', decision step')).toBeInTheDocument();
  });
});

describe('Stepper', () => {
  it('only lets you pick earlier steps and reports the choice', () => {
    const onChange = vi.fn();
    render(
      <MotionProvider>
        <Stepper
          steps={STEPS}
          currentIndex={4}
          value="research"
          onChange={onChange}
          label="Send back to"
        />
      </MotionProvider>,
    );
    expect(screen.getByRole('radio', { name: /Research/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Approve spec/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /Build/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /Draft spec/ }));
    expect(onChange).toHaveBeenCalledWith('spec');
  });

  it('offers an optional Stop option', () => {
    const onChange = vi.fn();
    render(
      <MotionProvider>
        <Stepper
          steps={STEPS}
          currentIndex={4}
          value="stop"
          onChange={onChange}
          label="Send back to"
          stop={{ name: 'Stop it', description: 'Archive' }}
        />
      </MotionProvider>,
    );
    expect(screen.getByRole('radio', { name: /Stop it/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /Research/ }));
    expect(onChange).toHaveBeenCalledWith('research');
  });
});

function Pusher({ onUndo, onCommit }: { onUndo: () => void; onCommit: () => void }) {
  const t = useToast();
  return (
    <button
      onClick={() =>
        t.push({ message: 'Approved', undoLabel: 'Undo', duration: 5000, onUndo, onCommit })
      }
    >
      push
    </button>
  );
}

/** jsdom has no PointerEvent, so pointerType is attached by hand. */
function pointer(el: Element, type: string, pointerType: string) {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  act(() => void el.dispatchEvent(e));
}

describe('Toast with undo', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('commits after the countdown', () => {
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    render(
      <MotionProvider>
        <ToastProvider>
          <Pusher onUndo={onUndo} onCommit={onCommit} />
        </ToastProvider>
      </MotionProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    expect(screen.getByRole('status')).toHaveTextContent('Approved');
    act(() => void vi.advanceTimersByTime(4900));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(200));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('undo cancels the commit', () => {
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    render(
      <MotionProvider>
        <ToastProvider>
          <Pusher onUndo={onUndo} onCommit={onCommit} />
        </ToastProvider>
      </MotionProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    act(() => void vi.advanceTimersByTime(6000));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits pending writes on navigation (unmount)', () => {
    const onCommit = vi.fn();
    const { unmount } = render(
      <MotionProvider>
        <ToastProvider>
          <Pusher onUndo={() => undefined} onCommit={onCommit} />
        </ToastProvider>
      </MotionProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    unmount();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('pauses the countdown while the pointer is over the toast', () => {
    const onCommit = vi.fn();
    render(
      <MotionProvider>
        <ToastProvider>
          <Pusher onUndo={() => undefined} onCommit={onCommit} />
        </ToastProvider>
      </MotionProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    act(() => void vi.advanceTimersByTime(2000));
    pointer(screen.getByRole('status'), 'pointermove', 'mouse');
    act(() => void vi.advanceTimersByTime(10000));
    expect(onCommit).not.toHaveBeenCalled();
    pointer(screen.getByRole('status'), 'pointerout', 'mouse');
    act(() => void vi.advanceTimersByTime(3100));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('a touch tap on the toast text does not pause the countdown', () => {
    const onCommit = vi.fn();
    render(
      <MotionProvider>
        <ToastProvider>
          <Pusher onUndo={() => undefined} onCommit={onCommit} />
        </ToastProvider>
      </MotionProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    act(() => void vi.advanceTimersByTime(1000));
    const status = screen.getByRole('status');
    pointer(status, 'pointermove', 'touch');
    fireEvent.mouseMove(status);
    fireEvent.mouseDown(screen.getByText('Approved'));
    act(() => void vi.advanceTimersByTime(4100));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('a fourth toast within the window commits the oldest instead of stranding it', () => {
    // Only three toasts fit on screen. The one pushed out used to lose its timer and stay
    // uncommitted (its item hidden) until the person left the screen.
    const onCommit = vi.fn();
    const onUndo = vi.fn();
    render(
      <MotionProvider>
        <ToastProvider>
          <Pusher onUndo={onUndo} onCommit={onCommit} />
        </ToastProvider>
      </MotionProvider>,
    );
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText('push'));
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('push'));
    // The oldest leaves the screen with no Undo left to press: it is committed right away.
    expect(onCommit).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(6000));
    expect(onCommit).toHaveBeenCalledTimes(4);
    expect(onUndo).not.toHaveBeenCalled();
  });
});

describe('contrast helper', () => {
  it('matches known WCAG values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(4.6);
  });
});

describe('sent back count', () => {
  it('says once, then times', () => {
    expect(sentBackText(1)).toBe('Sent back once');
    expect(sentBackText(2)).toBe('Sent back 2 times');
  });
});

describe('Toast with an action next to Undo', () => {
  it('runs the action and keeps what was done (no undo)', () => {
    const onUndo = vi.fn();
    const onAction = vi.fn();
    function P() {
      const t = useToast();
      return (
        <button
          onClick={() =>
            t.push({ message: 'Added', actionLabel: 'Open', onAction, undoLabel: 'Undo', onUndo })
          }
        >
          push
        </button>
      );
    }
    render(
      <MotionProvider>
        <ToastProvider>
          <P />
        </ToastProvider>
      </MotionProvider>,
    );
    fireEvent.click(screen.getByText('push'));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });
});

describe('Segmented and Select', () => {
  it('is one 44px control: pressed state, counts, and a change callback', () => {
    const onValueChange = vi.fn();
    render(
      <Segmented
        label="View"
        value="a"
        onValueChange={onValueChange}
        options={[
          { value: 'a', label: 'Alpha', count: 3 },
          { value: 'b', label: 'Beta' },
        ]}
      />,
    );
    const a = screen.getByRole('button', { name: /Alpha/ });
    const b = screen.getByRole('button', { name: 'Beta' });
    expect(a).toHaveAttribute('aria-pressed', 'true');
    expect(b).toHaveAttribute('aria-pressed', 'false');
    expect(b.className).toContain('min-h-11');
    fireEvent.click(b);
    expect(onValueChange).toHaveBeenCalledWith('b');
  });
  it('can be a tab list', () => {
    render(
      <Segmented
        tabs
        label="Pane"
        value="a"
        onValueChange={() => undefined}
        options={[
          { value: 'a', label: 'One' },
          { value: 'b', label: 'Two' },
        ]}
      />,
    );
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
  });
  it('a select can hide its label and still be named', () => {
    render(
      <Select
        hideLabel
        inline
        label="Type"
        value="x"
        onValueChange={() => undefined}
        options={[{ value: 'x', label: 'X' }]}
      />,
    );
    expect(screen.getByLabelText('Type')).toHaveValue('x');
  });
});
