/**
 * The Off switch on screen (scheduled tasks slice 7, design 9.4): the pill on every page ("Agents
 * on", or amber "Agents off" / "Off: Hive"), the panel that turns all agents or some Off and On
 * again (never by itself; turning on lists what will start first), and the Today banner.
 */
import {
  cliSupports,
  inboxOutcomeSchema,
  isOffFor,
  minVersionFor,
  outcomeType,
} from '@hive/shared';
import { Power } from 'lucide-react';
import { collection, query, where } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveQuery } from '../lib/live';
import { useNeedsAll } from '../needs/data';
import { useShellData } from '../shell/data';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Toggle } from '../ui/form';
import { Icon } from '../ui/icon';
import { Dialog } from '../ui/overlay';
import { useOff } from './data';
import { isOffDoc, sinceText, willStart, type WaitingStep } from './logic';

/** The pill: `full` in the wide sidebar and on Today, `compact` in the phone header, `icon` in the narrow sidebar. */
export function OffPill({ variant = 'full' }: { variant?: 'full' | 'compact' | 'icon' }) {
  const { summary } = useOff();
  const [open, setOpen] = useState(false);
  const off = summary.off;
  const label = `${summary.label}: change`;
  return (
    <>
      <button
        type="button"
        data-off-pill={off ? 'off' : 'on'}
        aria-label={label}
        title={off ? `${summary.label} · nothing automated acts` : 'Agents on · turn them Off'}
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium transition-colors foc:outline-2 foc:outline-offset-2 foc:outline-focus',
          variant === 'icon' ? 'size-11 justify-center' : 'min-h-11 px-3 text-13',
          variant === 'compact' && 'min-h-9 px-2.5',
          off
            ? 'border-gate/60 bg-gate-bg text-gate-text hov:brightness-105'
            : 'border-line bg-surface text-text-2 hov:bg-canvas hov:text-ink',
        )}
      >
        {variant === 'icon' ? (
          <Icon icon={Power} size={18} />
        ) : (
          <>
            <span
              aria-hidden
              className={cn('size-2 rounded-full', off ? 'bg-gate' : 'bg-approve')}
            />
            <span className="max-w-[9rem] truncate">{summary.label}</span>
          </>
        )}
      </button>
      <OffDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

/** One organization's steps that will start once On (read only while the dialog shows them). */
function OrgWaiting({
  wid,
  sinceMs,
  agents,
  onRows,
}: {
  wid: string;
  sinceMs: number;
  /** null: all agents. */
  agents: readonly string[] | null;
  onRows: (wid: string, rows: { id: string; text: string }[] | null) => void;
}) {
  const { session } = useReady();
  const uid = session.me.uid;
  const all = useNeedsAll();
  const input = all.inputs.find((i) => i.wid === wid);
  const live = useLiveQuery(
    `off-waiting:${wid}:${uid}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/inboxOutcomes`),
        where('memberUid', '==', uid),
        where('state', '==', 'approved'),
      ),
    inboxOutcomeSchema,
  );
  const rows = useMemo(() => {
    if (live.state !== 'ready') return null;
    const plans = new Map((input?.livePlans ?? []).map((p) => [p.id, p.data] as const));
    const titles = new Map((input?.threads ?? []).map((t) => [t.id, t.data.title] as const));
    const steps: WaitingStep[] = live.data
      .filter(
        (o) =>
          o.data.executor &&
          (agents === null || isOffFor({ all: false, agents: [...agents] }, o.data.executor)),
      )
      .map((o) => ({
        id: o.id,
        threadId: o.data.threadId,
        type: o.data.type,
        decidedMs: (o.data.decision?.at ?? o.data.createdAt).toMillis(),
        planId: o.data.planId ?? null,
      }));
    return willStart(steps, sinceMs, (pid, oid) => {
      const p = plans.get(pid);
      return !!p && p.state !== 'blocked' && p.steps[p.cursor] === oid;
    }).map((s) => ({
      id: s.id,
      text: `${outcomeType(s.type)?.label ?? s.type} · ${titles.get(s.threadId) ?? 'a thread'}`,
    }));
  }, [live, input, agents, sinceMs]);
  useEffect(() => onRows(wid, rows), [wid, rows, onRows]);
  useEffect(() => () => onRows(wid, null), [wid, onRows]);
  return null;
}

/** The panel: all agents (every organization) or some of this one; Off, then On after a look at what starts. */
export function OffDialog({
  open,
  onOpenChange,
  confirmFirst,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open on "Turn agents on?" (the Today banner's Turn on). */
  confirmFirst?: boolean;
}) {
  const { session } = useReady();
  const { agents } = useShellData();
  const { orgs, summary, cantRun, turnOff, turnOn } = useOff();
  const wid = session.workspaceId;
  const here = orgs.find((o) => o.wid === wid)?.off ?? null;
  const [all, setAll] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Record<string, { id: string; text: string }[] | null>>({});
  const onRows = useCallback((w: string, rows: { id: string; text: string }[] | null) => {
    setWaiting((cur) => (cur[w] === rows ? cur : { ...cur, [w]: rows }));
  }, []);

  // Each opening starts from what is saved.
  const [shown, setShown] = useState(false);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setAll(summary.off ? summary.all || !!here?.all : true);
      setPicked(here && !here.all && isOffDoc(here) ? [...here.agents] : []);
      setConfirm(!!confirmFirst && summary.off);
      setError(null);
    }
  }

  const live = agents.filter((a) => !a.data.revokedAt);
  const changed = all
    ? !summary.all
    : !here ||
      here.all ||
      !isOffDoc(here) ||
      picked.length !== here.agents.length ||
      picked.some((p) => !here.agents.includes(p));
  const nothing = !all && picked.length === 0;

  async function act(f: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await f();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const rows = Object.values(waiting).flatMap((r) => r ?? []);
  const loadingRows = Object.values(waiting).some((r) => r === null);

  if (confirm) {
    return (
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title="Turn agents on?"
        description="They pick up where they stopped. This starts once you confirm:"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Back
            </Button>
            <Button variant="approve" loading={busy} onClick={() => void act(turnOn)}>
              Turn on
            </Button>
          </>
        }
      >
        {orgs
          .filter((o) => isOffDoc(o.off))
          .map((o) => (
            <OrgWaiting
              key={o.wid}
              wid={o.wid}
              sinceMs={o.off.sinceMs ?? 0}
              agents={o.off.all ? null : o.off.agents}
              onRows={onRows}
            />
          ))}
        <div data-off-will-start="" className="flex flex-col gap-3 text-14">
          {loadingRows ? (
            <p className="text-text-2">Looking at what waits…</p>
          ) : rows.length ? (
            <ul className="flex flex-col gap-1.5">
              {rows.slice(0, 8).map((r) => (
                <li key={r.id} className="flex items-start gap-2 text-ink">
                  <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-agent" />
                  <span className="min-w-0">{r.text}</span>
                </li>
              ))}
              {rows.length > 8 ? <li className="text-text-2">and {rows.length - 8} more</li> : null}
            </ul>
          ) : (
            <p className="text-text-2">No approved step waits: nothing starts at once.</p>
          )}
          <p className="text-text-2">
            Messages and nudges held while Off come in too.
            {cantRun
              ? ` ${cantRun} scheduled ${cantRun === 1 ? 'run' : 'runs'} couldn't happen: decide ${cantRun === 1 ? 'it' : 'them'} on Today (Run now or Skip).`
              : ''}
          </p>
          {error ? (
            <p role="alert" className="text-sendback">
              {error}
            </p>
          ) : null}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        summary.off ? `Agents off since ${sinceText(summary.sinceMs ?? 0)}` : 'Turn agents off'
      }
      description="Off stops what agents do on their own: approved steps, scheduled runs, bringing in messages, nudges. What you do yourself still goes through. Only you turn them back on."
      footer={
        <>
          {summary.off ? (
            <Button variant="secondary" onClick={() => setConfirm(true)}>
              Turn on…
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
          <Button
            variant="gate"
            loading={busy}
            disabled={nothing || !changed}
            onClick={() => void act(() => turnOff(all ? { all: true } : { agents: picked }))}
          >
            {summary.off ? 'Save' : 'Turn off'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1" data-off-panel="">
        <Toggle
          label="All agents"
          description="Every agent, in all your organizations"
          checked={all}
          onCheckedChange={setAll}
        />
        {!all ? (
          <fieldset className="mt-2 border-t border-line pt-2">
            <legend className="sr-only">Agents of {session.workspace.name}</legend>
            <p className="pb-1 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
              {session.workspace.name}
            </p>
            {live.length === 0 ? (
              <p className="py-2 text-14 text-text-2">No agents connected here yet.</p>
            ) : (
              live.map((a) => {
                const old = cliSupports('off', a.data.cliVersion) === 'old';
                return (
                  <Toggle
                    key={a.id}
                    label={a.data.name}
                    description={
                      old
                        ? `${a.data.name} (CLI ${a.data.cliVersion}) can't be silenced by Hivenod: update it to ${minVersionFor('off')}`
                        : here && isOffDoc(here) && isOffFor(here, a.id)
                          ? 'Off for you'
                          : undefined
                    }
                    checked={picked.includes(a.id)}
                    onCheckedChange={(v) =>
                      setPicked((cur) => (v ? [...cur, a.id] : cur.filter((x) => x !== a.id)))
                    }
                  />
                );
              })
            )}
          </fieldset>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-14 text-sendback">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Today's banner while Off: since when, what it means, the runs that couldn't happen, Turn on. */
export function OffBanner() {
  const { summary, cantRun } = useOff();
  const [open, setOpen] = useState(false);
  if (!summary.off) return null;
  const who =
    summary.label === 'Agents off'
      ? 'Agents are Off'
      : summary.agents.length > 1
        ? `${summary.agents.length} agents are Off`
        : `${summary.label.slice(5)} is Off`;
  return (
    <section
      aria-label="Agents off"
      data-off-banner=""
      className="rounded-panel border border-gate/60 bg-gate-bg p-4"
    >
      <p className="font-semibold text-gate-text">
        {who} since {sinceText(summary.sinceMs ?? 0)}
      </p>
      <p className="mt-1 text-14 text-ink">
        Nothing automated acts: no approved steps run, no scheduled runs fire, nothing is brought
        in.
        {cantRun ? ` ${cantRun} scheduled ${cantRun === 1 ? 'run' : 'runs'} couldn't happen.` : ''}
      </p>
      <div className="mt-3">
        <Button
          variant="secondary"
          onClick={() => setOpen(true)}
          leading={<Icon icon={Power} size={16} />}
        >
          Turn on…
        </Button>
      </div>
      <OffDialog open={open} onOpenChange={setOpen} confirmFirst />
    </section>
  );
}
