/**
 * The summary's version history (item OE8FmrTaIxFVGcaeGG3N, slice 2; design 4.3): "v7 ▾" opens
 * the kept versions (the last 20), newest first; picking one shows it read-only with its bullets
 * diffed against the current version. Versions are read through the schema, like the summary.
 */
import { collection, query, where } from 'firebase/firestore';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import { useState } from 'react';
import { db } from '../lib/db';
import { useLiveQuery } from '../lib/live';
import { dayLabel, hhmm } from '../today/logic';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { Dialog } from '../ui/overlay';
import { bulletDiff, looseSummarySchema, type ShownSummary } from './decision';

const at = (s: ShownSummary) => {
  const d = new Date(s.at.toMillis());
  return `${dayLabel(d)}, ${hhmm(d)}`;
};

export function SummaryVersions({
  wid,
  uid,
  tid,
  current,
  label,
}: {
  wid: string;
  uid: string;
  tid: string;
  current: ShownSummary;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const versions = useLiveQuery(
    open ? `isv:${wid}/${tid}/${uid}` : null,
    () =>
      query(
        collection(db, `workspaces/${wid}/inboxSummaryVersions`),
        where('memberUid', '==', uid),
        where('threadId', '==', tid),
      ),
    looseSummarySchema,
  );
  const list =
    versions.state === 'ready'
      ? versions.data.map((r) => r.data).sort((a, b) => b.version - a.version)
      : [];
  const shown = picked !== null ? list.find((v) => v.version === picked) : undefined;
  return (
    <>
      <button
        type="button"
        data-versions=""
        aria-haspopup="dialog"
        onClick={() => {
          setPicked(null);
          setOpen(true);
        }}
        className="inline-flex min-h-8 items-center gap-0.5 rounded-btn px-1 font-medium text-text-2 hov:text-ink hov:underline foc:outline-2 foc:outline-focus"
      >
        <span className="sr-only">Summary versions, current </span>
        {label}
        <Icon icon={ChevronDown} size={14} />
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={shown ? `Summary v${shown.version}` : 'Summary versions'}
        description={
          shown
            ? `Written ${at(shown)}. Read only; bullets compared with v${current.version}.`
            : 'The last 20 versions are kept.'
        }
        footer={
          shown ? (
            <>
              <Button
                variant="secondary"
                onClick={() => setPicked(null)}
                leading={<Icon icon={ChevronLeft} size={15} />}
              >
                All versions
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Close
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
          )
        }
      >
        {shown ? (
          <div data-version-view={shown.version} className="flex flex-col gap-2 text-14">
            <p className="font-semibold text-ink [overflow-wrap:anywhere]">
              {shown.ask ?? shown.headline}
            </p>
            {shown.answer ? (
              <p className="text-ink [overflow-wrap:anywhere]">{shown.answer}</p>
            ) : null}
            {shown.recommendation ? (
              <p className="text-text-2 [overflow-wrap:anywhere]">
                Recommended {shown.recommendation.action} · {shown.recommendation.why}
              </p>
            ) : null}
            <ul aria-label="Bullets compared" className="mt-1 flex flex-col gap-1.5">
              {bulletDiff(
                shown.bullets.map((b) => b.text),
                current.bullets.map((b) => b.text),
              ).map((b, i) => (
                <li
                  key={i}
                  data-change={b.change}
                  className={cn(
                    'flex gap-2 [overflow-wrap:anywhere]',
                    b.change === 'removed' && 'text-text-2 line-through',
                    b.change === 'added' && 'font-medium text-ink',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'w-3 shrink-0 font-mono',
                      b.change === 'added' ? 'text-approve-text' : 'text-sendback',
                    )}
                  >
                    {b.change === 'removed' ? '−' : b.change === 'added' ? '+' : '•'}
                  </span>
                  <span className="min-w-0">
                    {b.change === 'removed' ? (
                      <span className="sr-only">Only in v{shown.version}: </span>
                    ) : b.change === 'added' ? (
                      <span className="sr-only">New in v{current.version}: </span>
                    ) : null}
                    {b.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : versions.state === 'loading' ? (
          <p className="text-14 text-text-2">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-14 text-text-2">No versions could be read.</p>
        ) : (
          <ul aria-label="Versions" className="flex flex-col divide-y divide-line">
            {list.map((v) => (
              <li key={v.version}>
                <button
                  type="button"
                  data-version={v.version}
                  onClick={() => setPicked(v.version)}
                  className="flex min-h-11 w-full items-baseline gap-3 py-2 text-left foc:outline-2 foc:outline-focus hov:bg-canvas"
                >
                  <span className="w-9 shrink-0 font-mono text-13 font-semibold text-ink">
                    v{v.version}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-14 text-ink">{v.ask ?? v.headline}</span>
                    <span className="block text-12 text-text-2">
                      {at(v)}
                      {v.version === current.version ? ' · current' : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
