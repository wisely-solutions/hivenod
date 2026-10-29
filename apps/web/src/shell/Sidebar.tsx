import { Link, useRouterState } from '@tanstack/react-router';
import { Bot, Search, Settings } from 'lucide-react';
import { useReady } from '../auth/context';
import { Logo } from '../components/Logo';
import { PersonAvatar } from '../components/PersonAvatar';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { Tooltip } from '../ui/overlay';
import { useShellData } from './data';
import { activityText, spendText } from './logic';
import { ME, ORG_NAV, YOU_NAV } from './nav';
import { useWaitingThreads } from '../threads/data';
import { OrgSwitcher } from '../orgs/OrgSwitcher';
import { BellButton } from '../bell/Bell';
import { useNeedsAll } from '../needs/data';
import { NeedsBadge, needsLabel } from '../needs/NeedsBadge';

/** A zone's heading: "YOU · all organizations", "ORGANIZATION" (hidden in the icon-only sidebar). */
const zoneHead =
  'px-3 pb-1.5 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3 max-xl:hidden';

/** The organization tabs of Settings (item icVly): the sidebar's Organization settings entry. */
const ORG_SETTINGS = /^\/settings\/(organization|members|groups|projects|labels)\/?$/;

/** What each You entry spans, for its tooltip. */
function scopeTitle(to: string): string {
  if (to === '/') return 'Today: everything waiting for you, in all your organizations';
  if (to === '/inbox') return 'Inbox: your threads, in all your organizations';
  if (to === '/calendar') return 'Calendar: your calendars, in all your organizations';
  return '';
}

const item =
  'group relative flex min-h-11 items-center gap-3 rounded-btn px-3 text-14 text-text-2 transition-colors ' +
  'hover:bg-canvas hover:text-ink data-[status=active]:bg-canvas data-[status=active]:font-medium data-[status=active]:text-ink ' +
  'max-xl:justify-center max-xl:px-0';

/** Left sidebar for tablet and desktop. Full labels from 1280 px, icons only below. */
export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { session } = useReady();
  const { projects, needs: liveNeeds, needsReady, activity, spend } = useShellData();
  // Hidden until the count is final, so the badge never climbs.
  const needs = needsReady ? liveNeeds : { total: 0, byProject: {} as Record<string, number> };
  // The badge counts every organization (item 2YZRd); per-project counts stay this one's.
  const all = useNeedsAll();
  const count = all.ready ? all.counts : { total: 0, onlyYou: 0 };
  const path = useRouterState({ select: (s) => s.location.pathname });
  const waiting = useWaitingThreads() ?? 0;
  const orgName = session.workspace.name;
  const orgSettings = ORG_SETTINGS.test(path);
  const live = projects.filter((p) => !p.data.archivedAt);
  const total = activity.working + activity.idle;
  // An agent may work on several items at once (card cGSENsRF) and park some (item QjTTL).
  const line = activityText(activity);

  return (
    <aside
      aria-label="Main"
      style={{ viewTransitionName: 'shell-sidebar' }}
      className="sticky top-0 hidden h-dvh max-h-dvh w-16 shrink-0 flex-col overflow-y-auto overflow-x-hidden border-r border-line bg-surface sm:flex xl:w-64"
    >
      <div className="flex h-14 items-center gap-2.5 px-4 max-xl:justify-center max-xl:px-0">
        <Link to="/" aria-label="Hivenod home" className="flex items-center gap-2.5 rounded-btn">
          <Logo />
          <span className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-gate-text max-xl:hidden">
            Hivenod
          </span>
        </Link>
        <span className="ml-auto max-xl:hidden">
          <BellButton />
        </span>
      </div>

      <div className="px-2 pb-1 xl:hidden">
        <div className="flex justify-center">
          <BellButton />
        </div>
      </div>

      <div className="px-2">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search ⌘K"
          aria-keyshortcuts="Control+K Meta+K"
          className="flex min-h-11 w-full items-center gap-2 rounded-btn border border-line bg-canvas px-3 text-14 text-text-2 transition-colors hover:border-line-strong max-xl:justify-center max-xl:px-0"
        >
          <Icon icon={Search} />
          <span className="flex-1 text-left max-xl:hidden">Search</span>
          <kbd className="font-mono text-12 text-text-3 max-xl:hidden">⌘K</kbd>
        </button>
      </div>

      {/* Zone 1 (item icVly, model A): you, across every organization. The switcher never changes it. */}
      <nav aria-label="You, all organizations" data-zone="you" className="mt-4 flex flex-col px-2">
        <p aria-hidden className={zoneHead}>
          You
          <span className="ml-1.5 font-sans font-normal normal-case tracking-normal text-text-3">
            · all organizations
          </span>
        </p>
        <div className="flex flex-col gap-0.5">
          {YOU_NAV.map((n) => {
            const inbox = n.to === '/inbox';
            const badge = n.badge ? count.total > 0 : inbox && waiting > 0;
            return (
              <Link
                key={n.to}
                to={n.to}
                activeOptions={{ exact: n.to === '/' }}
                aria-label={
                  n.badge
                    ? needsLabel(n.label, count.total, count.onlyYou)
                    : inbox && waiting > 0
                      ? `${n.label} ${waiting} waiting`
                      : n.label
                }
                title={scopeTitle(n.to)}
                className={item}
              >
                <Icon icon={n.icon} size={18} />
                <span className="flex-1 max-xl:hidden">{n.label}</span>{' '}
                {n.badge && badge ? (
                  <NeedsBadge
                    total={count.total}
                    onlyYou={count.onlyYou}
                    className="max-xl:hidden"
                  />
                ) : null}
                {inbox && badge ? (
                  <span aria-hidden data-inbox-badge className="max-xl:hidden">
                    <Badge count={waiting} />
                  </span>
                ) : null}
                {badge ? (
                  <span
                    aria-hidden
                    className={cn(
                      'absolute right-2.5 top-2 size-2 rounded-full xl:hidden',
                      n.badge ? 'bg-gate' : 'bg-line-strong',
                    )}
                  />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>

      <div aria-hidden className="mx-4 my-3 border-t border-line max-xl:mx-3" />

      {/* Zone 2: the organization picked in the switcher. Switching changes only this part. */}
      <nav
        aria-label={`Organization, ${orgName}`}
        data-zone="org"
        className="flex min-h-0 flex-1 flex-col px-2 [@media(max-height:560px)]:min-h-fit [@media(max-height:560px)]:flex-none"
      >
        <p aria-hidden className={zoneHead}>
          Organization
        </p>
        <div className="xl:hidden">
          <div className="flex flex-col">
            <OrgSwitcher compact />
          </div>
        </div>
        <div className="max-xl:hidden">
          <OrgSwitcher detailed />
        </div>
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto [@media(max-height:560px)]:overflow-visible">
          {live.length ? (
            <ul className="flex flex-col gap-0.5">
              {live.map((p) => {
                const n = needs.byProject[p.id] ?? 0;
                return (
                  <li key={p.id}>
                    <Link
                      to="/p/$pid"
                      params={{ pid: p.id }}
                      title={
                        n > 0
                          ? `${p.data.name}: ${n} ${n === 1 ? 'needs' : 'need'} you in ${orgName}`
                          : p.data.name
                      }
                      className={cn(
                        item,
                        path === `/p/${p.id}` && 'bg-canvas font-medium text-ink',
                      )}
                    >
                      <span aria-hidden className="w-[18px] text-center text-16 leading-none">
                        {p.data.emoji || p.data.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="flex-1 truncate max-xl:sr-only">{p.data.name}</span>
                      {n > 0 ? (
                        <Badge tone="gate" className="max-xl:absolute max-xl:right-1 max-xl:top-1">
                          <span className="sr-only">Needs you: </span>
                          {n}
                        </Badge>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className={cn('flex flex-col gap-0.5', live.length > 0 && 'mt-1')}>
            {ORG_NAV.map((n) => (
              <Link key={n.to} to={n.to} aria-label={n.label} title={n.label} className={item}>
                <Icon icon={n.icon} size={18} />
                <span className="flex-1 max-xl:hidden">{n.label}</span>
              </Link>
            ))}
            <Link
              to="/settings/$tab"
              params={{ tab: 'organization' }}
              aria-label="Organization settings"
              title={`Organization settings · ${orgName}`}
              data-status={orgSettings ? 'active' : undefined}
              className={item}
            >
              <Icon icon={Settings} size={18} />
              <span className="flex-1 max-xl:hidden">Organization settings</span>
            </Link>
          </div>
        </div>
      </nav>

      <div className="shrink-0 border-t border-line p-2">
        <div
          className="mb-1 px-3 py-1 text-13 text-text-2 max-xl:hidden"
          aria-label="Organization status"
        >
          <p className="flex items-center gap-2">
            <span className="relative flex size-2">
              {activity.working > 0 ? (
                <span className="absolute inset-0 animate-heartbeat rounded-full bg-agent" />
              ) : null}
              <span
                className={cn(
                  'relative size-2 rounded-full',
                  activity.working > 0 ? 'bg-agent' : 'bg-line-strong',
                )}
              />
            </span>
            {line}
          </p>
          <p className="mt-0.5 tabular-nums">
            Spend this month {spendText(spend.spent, spend.known, 'org')}
          </p>
        </div>
        <div className="mb-1 hidden justify-center xl:hidden sm:flex">
          <Tooltip content={`${line}. Spend ${spendText(spend.spent, spend.known, 'org')}`}>
            <button
              type="button"
              aria-label={`${activity.working} of ${total} ${total === 1 ? 'agent' : 'agents'} working. Spend this month ${spendText(spend.spent, spend.known, 'org')}`}
              className="relative grid size-11 place-items-center text-text-2"
            >
              <Icon icon={Bot} size={18} />
              {activity.working > 0 ? (
                <span className="absolute right-2.5 top-2.5 size-2 rounded-full bg-agent" />
              ) : null}
            </button>
          </Tooltip>
        </div>
        <Link
          to={ME.to}
          title="Settings"
          className={item}
          aria-label={`${session.profile.name}, Settings`}
        >
          {session.status === 'ready' ? (
            <PersonAvatar
              name={session.profile.name}
              photoURL={session.profile.photoURL}
              color={session.profile.color}
              size="sm"
            />
          ) : null}
          <span className="flex-1 truncate max-xl:hidden">{session.profile.name}</span>
          <Icon icon={Settings} size={16} className="text-text-2 max-xl:hidden" />
        </Link>
      </div>
    </aside>
  );
}
