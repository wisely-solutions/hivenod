import { Link } from '@tanstack/react-router';
import { ChevronRight, Settings } from 'lucide-react';
import { useReady } from '../auth/context';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { activityText } from '../shell/logic';
import { ORG_NAV } from '../shell/nav';
import { Eyebrow } from '../ui/badge';
import { Icon } from '../ui/icon';
import { OrgSwitcher } from './OrgSwitcher';

const row =
  'flex min-h-14 items-center gap-3 px-4 text-15 text-ink transition-colors hov:bg-canvas foc:outline-2 foc:-outline-offset-2 foc:outline-focus';

/**
 * The organization hub (item icVly, model A): the phone's fifth tab. The organization picked in the
 * switcher, with its agents, activity, insights and settings, and the switcher itself.
 * Today and Inbox stay across all organizations.
 */
export function OrgHubPage() {
  const { session } = useReady();
  const { activity } = useShellData();
  const name = session.workspace.name;
  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader title="Organization" />
      <OrgSwitcher detailed />
      <p className="mt-2 text-13 text-text-2">
        Switching changes this tab only. Today and Inbox always show every organization.
      </p>

      <section aria-labelledby="hub-org" className="mt-6">
        <Eyebrow className="mb-2 block">
          <span id="hub-org">{name}</span>
        </Eyebrow>
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {ORG_NAV.map((n, i) => (
            <li key={n.to} className={i ? 'border-t border-line' : undefined}>
              <Link to={n.to} className={row}>
                <Icon icon={n.icon} size={18} className="text-text-2" />
                <span className="flex-1">{n.label}</span>
                <Icon icon={ChevronRight} size={16} className="text-text-3" />
              </Link>
            </li>
          ))}
          <li className="border-t border-line">
            <Link to="/settings/$tab" params={{ tab: 'organization' }} className={row}>
              <Icon icon={Settings} size={18} className="text-text-2" />
              <span className="flex-1">Organization settings</span>
              <Icon icon={ChevronRight} size={16} className="text-text-3" />
            </Link>
          </li>
        </ul>
        <p className="mt-3 px-1 text-13 text-text-2 tabular-nums">{activityText(activity)}</p>
      </section>
    </div>
  );
}
