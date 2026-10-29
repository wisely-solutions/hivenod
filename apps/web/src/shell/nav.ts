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
}

export const NAV: NavEntry[] = [
  // Today (item kt3E7) replaced Needs you: same route, badge and `g n`.
  { to: '/', label: 'Today', icon: Sun, badge: true, key: 'n' },
  { to: '/inbox', label: 'Inbox', icon: Mails, key: 'm' },
  { to: '/projects', label: 'All projects', short: 'Projects', icon: FolderKanban, key: 'p' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, key: 'c' },
  { to: '/insights', label: 'Decision insights', icon: ChartNoAxesColumn, key: 'i' },
  { to: '/activity', label: 'Activity', icon: Activity, key: 'a' },
  { to: '/agents', label: 'Agents', icon: Bot, key: 'e' },
];

export const ME: NavEntry = { to: '/settings', label: 'Settings', icon: Settings, key: 's' };

/**
 * The four phone tabs around the + (item kt3E7, design 2.7): Today · Inbox · + · Calendar ·
 * Projects. Settings sits under the avatar in the phone's top bar; Activity stays in the sidebar,
 * `g a` and the palette.
 */
export const TABS: NavEntry[] = [NAV[0]!, NAV[1]!, NAV[3]!, NAV[2]!];

export function isActivePath(current: string, to: NavPath): boolean {
  return to === '/' ? current === '/' : current === to || current.startsWith(`${to}/`);
}
