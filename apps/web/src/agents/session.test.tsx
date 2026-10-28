import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SESSION_COMMANDS } from './cli';
import { ConnectGuide, type ConnectStep } from './CliSetup';

function Guide({ start }: { start: ConnectStep }) {
  const [step, setStep] = useState<ConnectStep>(start);
  return <ConnectGuide step={step} onStep={setStep} origin="https://hivenod.com" />;
}

describe('The one agent guide: install, pair, plugin, start (cards KLCTVnX8, Ul32d6Ee)', () => {
  it('installs the CLI, then pairs with `hivenod pair`', () => {
    const { unmount } = render(<Guide start={0} />);
    expect(screen.getByLabelText('Install command').textContent).toBe(
      'curl -fsSL https://hivenod.com/install.sh | sh',
    );
    unmount();
    render(<Guide start={1} />);
    expect(screen.getByLabelText('Pair command').textContent).toBe('hivenod pair');
  });

  it('adds the plugin and starts the session with the development-channels flag', () => {
    const { unmount } = render(<Guide start={2} />);
    expect(screen.getByLabelText('Marketplace command').textContent).toBe(
      'claude plugin marketplace add wisely-solutions/hivenod',
    );
    expect(screen.getByLabelText('Plugin command').textContent).toBe(
      'claude plugin install hivenod@hivenod',
    );
    unmount();
    render(<Guide start={3} />);
    expect(screen.getByLabelText('Start command').textContent).toBe(
      'claude --dangerously-load-development-channels plugin:hivenod@hivenod',
    );
    expect(screen.getByText(/own Claude config/)).toBeTruthy();
    expect(SESSION_COMMANDS.separateConfig).toContain('CLAUDE_CONFIG_DIR');
  });

  it('never mentions hivenod run, headless runs or YOLO, on any step', () => {
    render(<Guide start={3} />);
    for (const name of ['Install', 'Pair', 'Plugin', 'Start'])
      fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    expect(document.body.textContent).not.toMatch(/hivenod run|headless|YOLO|Remote Control/i);
  });
});
