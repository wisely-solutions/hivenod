import { Link } from '@tanstack/react-router';
import { Fragment, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { useCapture } from '../capture/CaptureProvider';
import { Badge } from '../ui/badge';
import { Icon } from '../ui/icon';
import { useShellData } from './data';
import { TABS } from './nav';

/** Hides while scrolling down, comes back on any scroll up (or near the top). */
export function useScrollHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const y = Math.max(0, window.scrollY);
        const delta = y - last;
        if (y < 64) setHidden(false);
        else if (delta > 8) setHidden(true);
        else if (delta < -8) setHidden(false);
        if (Math.abs(delta) > 8 || y < 64) last = y;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  return hidden;
}

/** Phone bottom tabs (SPEC section 8). Targets are 56 px tall, inset by the home indicator. */
export function TabBar({ hidden }: { hidden: boolean }) {
  const { needs: liveNeeds, needsReady } = useShellData();
  const needs = needsReady ? liveNeeds : { total: 0 };
  const capture = useCapture();
  return (
    <nav
      aria-label="Tabs"
      data-tab-bar
      style={{ viewTransitionName: 'shell-tabs' }}
      className={
        'fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur-sm ' +
        'transition-transform duration-200 ease-standard motion-reduce:transition-none sm:hidden ' +
        (hidden ? 'translate-y-full focus-within:translate-y-0' : 'translate-y-0')
      }
    >
      <ul className="grid grid-cols-[1fr_1fr_4rem_1fr_1fr]">
        {TABS.map((t, i) => (
          <Fragment key={t.to}>
            {i === 2 ? (
              <li>
                <button
                  type="button"
                  aria-label="Add an item"
                  onClick={() => capture.open()}
                  className="flex min-h-14 w-full items-center justify-center foc:outline-2 foc:outline-focus"
                >
                  <span className="grid size-11 place-items-center rounded-full bg-ink text-surface shadow-e2 transition-transform duration-120 ease-standard act:scale-95">
                    <Icon icon={Plus} size={22} />
                  </span>
                </button>
              </li>
            ) : null}
            <li>
              <Link
                to={t.to}
                activeOptions={{ exact: t.to === '/' }}
                aria-label={
                  t.badge && needs.total > 0 ? `${t.label} ${needs.total} waiting` : t.label
                }
                // The label comes first in the DOM (shown below the icon by flex-col-reverse), so
                // the visible text reads "Needs you 5" like the start of the aria-label (axe
                // label-content-name-mismatch at 390).
                className="relative flex min-h-14 flex-col-reverse items-center justify-center gap-0.5 whitespace-nowrap text-12 font-medium text-text-2 transition-colors data-[status=active]:text-ink"
              >
                <span>{t.label}</span>{' '}
                <span className="relative">
                  <Icon icon={t.icon} size={22} />
                  {t.badge && needs.total > 0 ? (
                    <Badge tone="gate" count={needs.total} className="absolute -right-3 -top-2" />
                  ) : null}
                </span>
              </Link>
            </li>
          </Fragment>
        ))}
      </ul>
    </nav>
  );
}
