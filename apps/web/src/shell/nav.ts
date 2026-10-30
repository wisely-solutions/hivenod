import { Activity, Bot, ChartNoAxesColumn, Mails, Sun, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type NavPath = '/' | '/inbox' | '/insights' | '/activity' | '/agents' | '/account';

export interface NavEntry {
  to: NavPath;
  label: string;
  icon: LucideIcon;
  /** Shows the live Needs-you count. */
  badge?: boolean;
  /** Second key of the "g then x" go-to shortcut. */
  key: string;
  /** The phone tab's shorter label. */
  short?: string;
  /**
   * Which sidebar zone it sits in (item icVly, model A): `you` spans every organization (Today,
   * Inbox); `org` belongs to the organization picked in the switcher.
   */
  zone: 'you' | 'org';
}

export const NAV: NavEntry[] = [
  // Today (item kt3E7) replaced Needs you: same route, badge and `g n`.
  { to: '/', label: 'Today', icon: Sun, badge: true, key: 'n', zone: 'you' },
  { to: '/inbox', label: 'Inbox', icon: Mails, key: 'm', zone: 'you' },
  // Projects was removed (item OE8FmrTaIxFVGcaeGG3N, slice 10).
  { to: '/agents', label: 'Agents', icon: Bot, key: 'e', zone: 'org' },
  { to: '/activity', label: 'Activity', icon: Activity, key: 'a', zone: 'org' },
  { to: '/insights', label: 'Decision insights', icon: ChartNoAxesColumn, key: 'i', zone: 'org' },
];

/** The sidebar's first zone: you, across every organization. */
export const YOU_NAV: NavEntry[] = NAV.filter((n) => n.zone === 'you');
/** The sidebar's second zone: the organization picked in the switcher. */
export const ORG_NAV: NavEntry[] = NAV.filter((n) => n.zone === 'org');

/** Your account (item icVly): profile, theme, notifications, under the avatar. */
export const ME: NavEntry = {
  to: '/account',
  label: 'Account',
  icon: UserRound,
  key: 's',
  zone: 'you',
};

/**
 * The phone tabs (items kt3E7, icVly; Calendar removed in OE8Fm slice 5): Today · Inbox · + · <the
 * organization>. The last one is drawn by the tab bar itself (the organization's mark and name)
 * and opens the organization hub (/org). Your Account sits under the avatar in the top bar.
 */
export const TABS: NavEntry[] = [NAV[0]!, NAV[1]!];

/** Paths that belong to the organization tab: the hub and every organization page. */
export function isOrgPath(path: string): boolean {
  return /^\/(org|agents|activity|insights)(\/|$)/.test(path) || /^\/settings\//.test(path);
}

export function isActivePath(current: string, to: NavPath): boolean {
  return to === '/' ? current === '/' : current === to || current.startsWith(`${to}/`);
}
