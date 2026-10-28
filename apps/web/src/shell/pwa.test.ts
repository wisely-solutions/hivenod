import { describe, expect, it } from 'vitest';
import { shouldShowInstallHint } from './pwa';

const base = { visits: 2, standalone: false, dismissed: false, canPrompt: true, ios: false };

describe('install hint', () => {
  it('shows from the second visit when installable', () => {
    expect(shouldShowInstallHint(base)).toBe(true);
    expect(shouldShowInstallHint({ ...base, visits: 1 })).toBe(false);
  });
  it('stays away when installed, dismissed or not installable', () => {
    expect(shouldShowInstallHint({ ...base, standalone: true })).toBe(false);
    expect(shouldShowInstallHint({ ...base, dismissed: true })).toBe(false);
    expect(shouldShowInstallHint({ ...base, canPrompt: false })).toBe(false);
  });
  it('shows manual steps on iOS, which has no install prompt event', () => {
    expect(shouldShowInstallHint({ ...base, canPrompt: false, ios: true })).toBe(true);
  });
});
