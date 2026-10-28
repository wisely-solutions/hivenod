import { encodeToken, newAgentCredentials, tokenHint, type ActionContext } from '@hive/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MotionProvider } from '../ui/motion';
import { ToastProvider } from '../ui/overlay';

const creds = newAgentCredentials();
const TOKEN = encodeToken({ w: 'w1', e: creds.email, p: creds.password });

vi.mock('../lib/app', () => ({
  app: { options: {} },
  USE_EMULATOR: false,
  AUTH_EMULATOR_PORT: 9099,
}));
vi.mock('@hive/shared/agent-auth', () => ({
  createAgentIdentity: vi.fn(async () => ({ uid: 'newUid', token: TOKEN })),
}));

import { createAgentFlow, revokeAgentFlow, rotateAgentFlow } from './flow';
import { TokenDialog } from './TokenDialog';

const ctx: ActionContext = { workspaceId: 'w1', actor: { type: 'human', id: 'o', name: 'Owner' } };

describe('writes never contain the credential', () => {
  it('create, rotate and revoke plans carry only the hint', async () => {
    const plans: unknown[] = [];
    const run = vi.fn(async (p: unknown) => void plans.push(p));
    const input = { name: 'Scout', color: 'agent-2', projectIds: '*' as const };
    expect(await createAgentFlow(ctx, run, input)).toBe(TOKEN);
    expect(await rotateAgentFlow(ctx, run, 'old', input)).toBe(TOKEN);
    await revokeAgentFlow(ctx, run, 'old');
    expect(plans).toHaveLength(3);
    const written = JSON.stringify(plans);
    expect(written).not.toContain(creds.password);
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain('hive_agt_');
    expect(written).toContain(tokenHint(TOKEN));
    // The agent doc id is the Auth uid, and the event names the action.
    expect(written).toContain('agent.created');
    expect(written).toContain('agent.rotated');
    expect(written).toContain('agent.revoked');
  });

  it('never logs the token', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    await createAgentFlow(ctx, async () => undefined, {
      name: 'Scout',
      color: 'agent-1',
      projectIds: ['p1'],
    });
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(creds.password);
      s.mockRestore();
    }
  });
});

function Harness() {
  const [token, setToken] = useState<string | null>(TOKEN);
  return (
    <MotionProvider>
      <ToastProvider>
        <TokenDialog name="Scout" token={token} onDone={() => setToken(null)} />
        <p>{token ? 'open' : 'closed'}</p>
      </ToastProvider>
    </MotionProvider>
  );
}

describe('TokenDialog', () => {
  it('shows the token once with the warning, and only closes after the box is ticked', async () => {
    render(<Harness />);
    expect(screen.getByLabelText('Agent token')).toHaveValue(TOKEN);
    expect(screen.getByText(/You won’t see this again/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy token' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy as env var' })).toBeInTheDocument();
    expect((screen.getByLabelText('MCP config') as HTMLTextAreaElement).value).toContain(
      'HIVENOD_TOKEN',
    );

    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    // Esc cannot dismiss it either; it nudges instead.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(await screen.findByText(/Tick this once/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /saved this token/ }));
    expect(done).toBeEnabled();
    fireEvent.click(done);
    await waitFor(() => expect(screen.getByText('closed')).toBeInTheDocument());
  });

  it('copies the env var form and vibrates', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText }, vibrate: vi.fn() });
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy as env var' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`HIVENOD_TOKEN=${TOKEN}`));
    expect(navigator.vibrate).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });
});
