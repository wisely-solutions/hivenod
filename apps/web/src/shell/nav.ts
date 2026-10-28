import {
  Activity,
  Bot,
  CalendarDays,
  ChartNoAxesColumn,
  FolderKanban,
  Inbox,
  Mails,
  Settings,
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
}

export const NAV: NavEntry[] = [
  { to: '/', label: 'Needs you', icon: Inbox, badge: true, key: 'n' },
  { to: '/inbox', label: 'Inbox', icon: Mails, key: 'm' },
  { to: '/projects', label: 'All projects', icon: FolderKanban, key: 'p' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, key: 'c' },
  { to: '/insights', label: 'Decision insights', icon: ChartNoAxesColumn, key: 'i' },
  { to: '/activity', label: 'Activity', icon: Activity, key: 'a' },
  { to: '/agents', label: 'Agents', icon: Bot, key: 'e' },
];

export const ME: NavEntry = { to: '/settings', label: 'Settings', icon: Settings, key: 's' };

/** The four phone tabs (SPEC section 8). */
export const TABS: NavEntry[] = [NAV[0]!, NAV[2]!, NAV[5]!, ME];

export function isActivePath(current: string, to: NavPath): boolean {
  return to === '/' ? current === '/' : current === to || current.startsWith(`${to}/`);
}
