import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ failed: false }));
const link = vi.hoisted(() => ({ v: 'live' as 'live' | 'reconnecting' }));
vi.mock('../lib/connection', () => ({ useServerLink: () => link.v }));
vi.mock('../auth/context', () => ({ useReady: () => ({ session: { workspaceId: 'w' } }) }));
vi.mock('./data', () => ({ useShellData: () => data }));
vi.mock('./pwa', () => ({ useOnline: () => true, useInstallHint: () => ({}) }));

import { LoadErrorBanner, ReconnectingBanner, UnreachableState } from './banners';

afterEach(() => {
  data.failed = false;
});

describe('LoadErrorBanner', () => {
  it('shows nothing while the data loads fine', () => {
    render(<LoadErrorBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so and offers Reload when a listener failed', () => {
    data.failed = true;
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    render(<LoadErrorBanner />);
    expect(screen.getByRole('alert').textContent).toContain('Some of your data could not load.');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('ReconnectingBanner', () => {
  it('shows only while the live link is down', () => {
    const { unmount } = render(<ReconnectingBanner />);
    expect(screen.queryByTestId('reconnecting')).toBeNull();
    unmount();
    link.v = 'reconnecting';
    render(<ReconnectingBanner />);
    expect(screen.getByTestId('reconnecting').textContent).toContain('Reconnecting');
  });
});

describe('UnreachableState', () => {
  it('says the server cannot be reached and retries on tap', () => {
    const retry = vi.fn();
    render(<UnreachableState onRetry={retry} />);
    expect(screen.getByText("Can't reach the server")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
  });
});

describe('UnreachableState while retrying', () => {
  it('keeps the Retry button, disabled, until the retry settles', () => {
    const retry = vi.fn();
    render(<UnreachableState onRetry={retry} retrying />);
    const button = screen.getByRole('button', { name: /Retrying/ });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(retry).not.toHaveBeenCalled();
  });
});
