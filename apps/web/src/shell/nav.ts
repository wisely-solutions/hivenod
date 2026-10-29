import {
  Activity,
  Bot,
  CalendarDays,
  ChartNoAxesColumn,
  FolderKanban,
  Mails,
  Settings,
  Sun,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type NavPath =
  '/' | '/inbox' | '/projects' | '/calendar' | '/insights' | '/activity' | '/agents' | '/settings';

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
   * Inbox, Calendar); `org` belongs to the organization picked in the switcher.
   */
  zone: 'you' | 'org';
}

export const NAV: NavEntry[] = [
  // Today (item kt3E7) replaced Needs you: same route, badge and `g n`.
  { to: '/', label: 'Today', icon: Sun, badge: true, key: 'n', zone: 'you' },
  { to: '/inbox', label: 'Inbox', icon: Mails, key: 'm', zone: 'you' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, key: 'c', zone: 'you' },
  // "All projects" listed only the selected organization's: now plainly "Projects" (item icVly).
  { to: '/projects', label: 'Projects', icon: FolderKanban, key: 'p', zone: 'org' },
  { to: '/agents', label: 'Agents', icon: Bot, key: 'e', zone: 'org' },
  { to: '/activity', label: 'Activity', icon: Activity, key: 'a', zone: 'org' },
  { to: '/insights', label: 'Decision insights', icon: ChartNoAxesColumn, key: 'i', zone: 'org' },
];

/** The sidebar's first zone: you, across every organization. */
export const YOU_NAV: NavEntry[] = NAV.filter((n) => n.zone === 'you');
/** The sidebar's second zone: the organization picked in the switcher. */
export const ORG_NAV: NavEntry[] = NAV.filter((n) => n.zone === 'org');

export const ME: NavEntry = {
  to: '/settings',
  label: 'Settings',
  icon: Settings,
  key: 's',
  zone: 'you',
};

/**
 * The four phone tabs around the + (item kt3E7, design 2.7): Today · Inbox · + · Calendar ·
 * Projects. Settings sits under the avatar in the phone's top bar; Activity stays in the sidebar,
 * `g a` and the palette.
 */
export const TABS: NavEntry[] = [NAV[0]!, NAV[1]!, NAV[2]!, NAV[3]!];

export function isActivePath(current: string, to: NavPath): boolean {
  return to === '/' ? current === '/' : current === to || current.startsWith(`${to}/`);
}
