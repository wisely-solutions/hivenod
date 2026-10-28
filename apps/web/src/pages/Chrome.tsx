import type { ReactNode } from 'react';

export function PageHeader({
  title,
  action,
  subtitle,
  reserveSubtitle,
  section,
}: {
  title: string;
  action?: ReactNode;
  subtitle?: string;
  /** Keep the subtitle line's height while the text is still loading (no layout shift). */
  reserveSubtitle?: boolean;
  /** A tab of the Settings page: a section heading (h2) under the page's own h1. */
  section?: boolean;
}) {
  return (
    <div className={section ? 'mb-5' : 'mb-6'}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {section ? (
            <h2 className="text-20 font-semibold">{title}</h2>
          ) : (
            <h1 className="text-28 font-semibold">{title}</h1>
          )}
          {subtitle ? (
            <p className="mt-1 text-14 text-text-2">{subtitle}</p>
          ) : reserveSubtitle ? (
            <p aria-hidden className="mt-1 h-[1.3125rem]" />
          ) : null}
        </div>
        {action}
      </div>
    </div>
  );
}
