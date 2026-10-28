import { firstRunPath, firstRunSchema, nextOnPath } from '@hive/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { doc, setDoc } from 'firebase/firestore';
import { Inbox } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { colorIndex } from '../agents/logic';
import { firstName, useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveDoc } from '../lib/live';
import { isItemLive } from '../board/logic';
import { displayName, useProfiles } from '../members/data';
import { isLive } from '../shell/logic';
import { useShellData } from '../shell/data';
import { useShortcut } from '../shell/shortcuts';
import { AgentAvatar } from '../ui/avatar';
import { Segmented } from '../ui/form';
import { Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState, Skeleton, WorkingDots } from '../ui/feedback';
import { AnimatePresence } from '../ui/motion';
import { Sheet, useCountdowns } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { BAR_BUTTON, BAR_PRIMARY, BarUndo, SelectionBar } from '../board/SelectionBar';
import { rangeKeys } from '../board/bulk';
import { isTypingTarget } from '../shell/shortcuts';
import { Check, X } from 'lucide-react';
import { DecisionDialog, type DialogMode } from './DecisionDialog';
import { InboxRow, type RowAgent } from './InboxRow';
import {
  buildInbox,
  countByFilter,
  filterEntries,
  isOpenFinding,
  nextKey,
  parseFilter,
  type InboxEntry,
} from './logic';
import { useDecide } from './useDecide';
import { FirstRun } from './FirstRun';
import { firstRunDone, firstRunState } from './firstRun';

const DESKTOP = '(min-width: 1024px)';
// The detail and the send-back dialog are not part of the first screen on a phone: their code
// (item detail, attachments, run log, markdown) loads after the list has painted (card CGPynEQY).
const loadDetail = () => import('./InboxDetail');
const InboxDetail = lazy(() => loadDetail().then((m) => ({ default: m.InboxDetail })));
const loadSendBack = () => import('../components/SendBackDialog');
const SendBackDialog = lazy(() => loadSendBack().then((m) => ({ default: m.SendBackDialog })));

/** Rows drawn in the first paint (more than a tall phone shows). */
const FIRST_ROWS = 10;
function subscribe(cb: () => void) {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );
}

/** Screen 1, the heart of Hivenod: everything waiting on me, decided in seconds (SPEC 9.1). */
export function InboxPage() {
  const { sel, f: rawFilter } = useSearch({ strict: false }) as { sel?: string; f?: string };
  const { session } = useReady();
  const wid = session.workspaceId;
  const uid = session.me.uid;
  const navigate = useNavigate();
  const shell = useShellData();
  const desktop = useIsDesktop();
  const filter = parseFilter(rawFilter);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Counts, rows and the all-caught-up state wait until the server has answered every feed, so
  // nothing climbs or flashes. A feed that never answers must not hide the list for good: after
  // 3 s show what we have (same rule as the Projects screen).
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setPatient(false), 3000);
    return () => clearTimeout(t);
  }, []);
  // Runs (agent and summary on each row) may follow: they are not what the list waits for.
  const loading = shell.loading || (!shell.needsSettled && patient);
  // The first paint draws only the rows a phone screen can show; the rest follow a frame later,
  // so a long list does not hold back the first rows (card CGPynEQY). Counts use the whole list.
  const [allRows, setAllRows] = useState(false);
  useEffect(() => {
    if (loading || allRows) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const raf = requestAnimationFrame(() => {
      t = setTimeout(() => {
        setAllRows(true);
      }, 0);
    });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [loading, allRows]);

  // Warm the code a tap on a row needs, as soon as the screen is here (not after the list has
  // settled): a phone that goes offline right after the list shows must still open a row.
  useEffect(() => {
    void loadDetail().catch(() => undefined);
    void loadSendBack().catch(() => undefined);
  }, []);

  const inbox = useMemo(
    () =>
      buildInbox({
        projects: shell.projects,
        items: shell.items,
        suggestions: shell.suggestions,
        isAdmin: session.isAdmin,
        questions: shell.questions,
        proposals: shell.proposals,
        uid,
      }),
    [
      shell.projects,
      shell.items,
      shell.suggestions,
      shell.questions,
      shell.proposals,
      uid,
      session.isAdmin,
    ],
  );
  const { hidden, decide, decideMany, held, release } = useDecide();
  const countdowns = useCountdowns();
  const visible = useMemo(() => inbox.todo.filter((e) => !hidden.has(e.key)), [inbox.todo, hidden]);
  const counts = countByFilter(visible);
  // A finally-approved item stays in the list through the Undo window and the Done moment
  // (it is already out of the counts), then Needs you moves on.
  const [heldAt, setHeldAt] = useState(0);
  const shown = useMemo(() => {
    if (!held) return visible;
    if (visible.some((e) => e.key === held.entry.key)) return visible;
    const out = [...visible];
    out.splice(Math.min(Math.max(heldAt, 0), out.length), 0, held.entry);
    return out;
  }, [visible, held, heldAt]);
  const list = filterEntries(shown, filter);
  const batch = countdowns.find((c) => c.tag.startsWith('batch-'));
  const waiting = inbox.waiting.filter((e) => !hidden.has(e.key));

  // The row that is highlighted (desktop: the first one until you pick), and the item opened in
  // the focus view over the list (card ExMNfP8A).
  const focused = list.find((e) => e.key === sel) ?? null;
  const selected = focused ?? (desktop ? (list[0] ?? null) : null);

  // Moving on: the held entry goes in the same render that shows the next selection.
  const heldLeaving = held?.leaving ? held.entry.key : null;
  useEffect(() => {
    if (heldLeaving && selected?.key !== heldLeaving) release();
  }, [heldLeaving, selected?.key, release]);

  const deciderUids = useMemo(
    () => [
      ...new Set(
        [...inbox.todo, ...inbox.waiting].flatMap(
          (e) => e.project.steps.find((s) => s.id === e.item.stepId)?.gate?.deciderUids ?? [],
        ),
      ),
    ],
    [inbox],
  );
  const profiles = useProfiles(wid, deciderUids);
  const names = useMemo(
    () => Object.fromEntries(deciderUids.map((u) => [u, displayName(profiles[u], u)])),
    [deciderUids, profiles],
  );

  const runsByItem = useMemo(() => {
    const m = new Map<string, (typeof shell.runs)[number]>();
    for (const r of shell.runs) {
      const cur = m.get(r.data.itemId);
      if (!cur || r.data.startedAt.toMillis() > cur.data.startedAt.toMillis())
        m.set(r.data.itemId, r);
    }
    return m;
  }, [shell]);

  /**
   * The run behind an entry. A finding has no run of its own and is not its parent's work: only
   * the run that raised it counts, never the last run of the item it was found on.
   */
  function runOf(e: InboxEntry) {
    if (e.kind === 'finding')
      return e.item.sourceRunId ? shell.runs.find((r) => r.id === e.item.sourceRunId) : undefined;
    return runsByItem.get(e.itemId);
  }

  function agentOf(e: InboxEntry): RowAgent | null {
    const run = runOf(e);
    const id =
      run?.data.agentUid ?? (e.item.createdBy.type === 'agent' ? e.item.createdBy.id : null);
    const a = id ? shell.agents.find((x) => x.id === id) : undefined;
    return a
      ? {
          name: a.data.name,
          color: colorIndex(a.data.color, a.id),
          live: !!run && isLive(run.data, now) && isItemLive(e.item, now),
        }
      : null;
  }

  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<{ mode: DialogMode | 'iterate'; key: string } | null>(null);
  const [quick, setQuick] = useState<string | null>(null);
  const dialogEntry = dialog ? ([...inbox.todo].find((e) => e.key === dialog.key) ?? null) : null;
  const quickCountdown = countdowns.find((c) => c.key === quick);
  // The quick sheet stays open while its Approve counts down, and closes when that ends.
  const hadQuickCountdown = useRef(false);
  useEffect(() => {
    if (quickCountdown) hadQuickCountdown.current = true;
    else if (hadQuickCountdown.current) {
      hadQuickCountdown.current = false;
      setQuick(null);
    }
  }, [quickCountdown]);
  const quickEntry = quick ? ([...inbox.todo].find((e) => e.key === quick) ?? null) : null;

  // Selecting several Approve/Accept rows to decide them together. Questions, findings and path
  // decisions need a real answer each, so they cannot be selected.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [barHeight, setBarHeight] = useState(56);
  const [bulkReject, setBulkReject] = useState(false);
  const anchor = useRef<string | null>(null);
  const selectable = (e: InboxEntry) => e.kind === 'approval';
  const selectOrder = list.filter(selectable).map((e) => e.key);
  const clearPicked = () => {
    setPicked(new Set());
    anchor.current = null;
  };
  const pick = (key: string, shift: boolean) => {
    if (shift && anchor.current) {
      const keys = rangeKeys(selectOrder, anchor.current, key);
      setPicked((cur) => new Set([...cur, ...keys]));
    } else {
      setPicked((cur) => {
        const next = new Set(cur);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    }
    anchor.current = key;
  };
  /** The selected entries still in Needs you, and how many left meanwhile (decided elsewhere). */
  const pickedNow = () => {
    const live = inbox.todo.filter((e) => picked.has(e.key) && selectable(e));
    return { live, gone: picked.size - live.length };
  };
  const decidePicked = (d: Parameters<typeof decideMany>[1]) => {
    const { live, gone } = pickedNow();
    // The selection and its bar stay while the button counts down; they clear when it ends.
    return decideMany(live, d, gone, clearPicked);
  };

  const go = (key: string | null, replace = true) =>
    void navigate({
      to: '/',
      search: { ...(key ? { sel: key } : {}), ...(filter !== 'all' ? { f: filter } : {}) },
      replace,
    });

  // Undo runs up to 5 s after the decision: read where the person is now, not where they were.
  const latest = useRef({ sel, desktop, go });
  useEffect(() => {
    latest.current = { sel, desktop, go };
  });

  // The next item slides into focus when the current one leaves.
  const decideEntry = (e: InboxEntry, d: Parameters<typeof decide>[1]) => {
    // Already counting down on its button: a second press (or the A key) does nothing.
    if (countdowns.some((c) => c.key === e.key)) return null;
    const following = nextKey(list, e.key);
    const fromDetail = sel === e.key;
    setHeldAt(list.findIndex((x) => x.key === e.key));
    // Approve and Reject count down on their button with the item still on screen; when the
    // window ends the item moves on (a final approval first shows its Done panel).
    const problem = decide(
      e,
      d,
      () => {
        const cur = latest.current;
        // Desktop: the restored item takes the selection back. Phone: it reopens only when it was
        // decided from its own detail and the person is still on the list, never over another item.
        if (fromDetail && (cur.desktop || !cur.sel)) cur.go(e.key);
      },
      () => {
        const cur = latest.current;
        if (cur.sel === e.key) cur.go(cur.desktop ? following : null);
        else release();
      },
    );
    // Other decisions (an answer, a suggestion) leave at once.
    if (!problem && d.kind !== 'approve' && d.kind !== 'reject' && sel === e.key)
      go(desktop ? following : null);
    return problem;
  };

  // x selects the highlighted row (Shift+x a range); Escape clears the selection.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (
        isTypingTarget(e.target) &&
        !(e.target instanceof HTMLInputElement && e.target.type === 'checkbox')
      )
        return;
      if (document.querySelector('[role="dialog"]:not([data-state="closed"])')) return;
      if (e.key === 'Escape' && picked.size > 0) {
        clearPicked();
        return;
      }
      if (e.key.toLowerCase() !== 'x') return;
      const key = selected && selectable(selected) ? selected.key : selectOrder[0];
      if (!key) return;
      e.preventDefault();
      pick(key, e.shiftKey);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const step = (dir: 1 | -1) => {
    if (!list.length) return;
    // Nothing selected yet (phone): the first j/k lands on the first item, not the second.
    if (!focused) return go(list[0]!.key);
    const i = Math.max(
      0,
      list.findIndex((e) => e.key === selected?.key),
    );
    const to = list[Math.min(list.length - 1, Math.max(0, i + dir))];
    if (to) go(to.key);
  };
  const canApprove = selected?.kind === 'approval';
  useShortcut({
    id: 'inbox:next',
    keys: ['j'],
    label: 'Next item',
    group: 'Needs you',
    run: () => step(1),
  });
  useShortcut({
    id: 'inbox:prev',
    keys: ['k'],
    label: 'Previous item',
    group: 'Needs you',
    run: () => step(-1),
  });
  useShortcut({
    id: 'inbox:open',
    keys: ['Enter'],
    label: 'Open item',
    group: 'Needs you',
    run: () => {
      const e = selected ?? list[0];
      if (e && !focused) go(e.key, false);
    },
  });
  useShortcut({
    id: 'inbox:approve',
    keys: ['a'],
    label: 'Approve',
    group: 'Needs you',
    run: () => {
      if (selected && canApprove)
        decideEntry(selected, { kind: 'approve', rationale: rationales[selected.key] ?? '' });
    },
  });
  useShortcut({
    id: 'inbox:iterate',
    keys: ['r'],
    label: 'Send back or reject',
    group: 'Needs you',
    run: () => {
      if (selected && canApprove) setDialog({ mode: 'iterate', key: selected.key });
    },
  });
  useShortcut({
    id: 'inbox:close',
    keys: ['Escape'],
    label: 'Close',
    group: 'Needs you',
    run: () => {
      if (focused) go(null, false);
    },
  });

  const nextNameOf = (e: InboxEntry | null) => {
    if (!e) return undefined;
    return nextOnPath(e.project, e.item)?.name;
  };

  const filterOptions = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'approvals', label: 'Approvals', count: counts.approvals },
    { value: 'questions', label: 'Questions', count: counts.questions },
    { value: 'findings', label: 'Findings', count: counts.findings },
  ];

  const chips = (
    <Segmented
      label="Filter"
      value={filter}
      onValueChange={(v) =>
        void navigate({
          to: '/',
          search: v === 'all' ? {} : { f: v as 'approvals' },
          replace: true,
        })
      }
      options={filterOptions}
    />
  );

  const rows = (
    <ul aria-label="Needs you" className="flex flex-col">
      <AnimatePresence initial={false} mode="popLayout">
        {(allRows ? list : list.slice(0, FIRST_ROWS)).map((e) => (
          <InboxRow
            key={e.key}
            entry={e}
            selected={desktop && selected?.key === e.key}
            now={now}
            uid={uid}
            names={names}
            agent={agentOf(e)}
            summary={e.kind === 'finding' ? '' : (runOf(e)?.data.summary ?? '')}
            swipeable={!desktop && e.kind === 'approval' && picked.size === 0}
            select={
              selectable(e)
                ? {
                    show: desktop || picked.size > 0,
                    checked: picked.has(e.key),
                    onToggle: (shift) => pick(e.key, shift),
                  }
                : undefined
            }
            onOpen={() =>
              !desktop && picked.size > 0 && selectable(e) ? pick(e.key, false) : go(e.key, false)
            }
            onSwipe={(a) =>
              setDialog({ mode: a === 'approve' ? 'approve' : 'iterate', key: e.key })
            }
            onLongPress={() => (selectable(e) ? pick(e.key, false) : setQuick(e.key))}
          />
        ))}
      </AnimatePresence>
    </ul>
  );

  const waitingList = waiting.length ? (
    <section aria-label="Waiting on others" className="mt-4 flex flex-col gap-2">
      <Eyebrow>Waiting on others</Eyebrow>
      <ul className="flex flex-col">
        {waiting.map((e) => (
          <InboxRow
            key={e.key}
            entry={e}
            selected={false}
            now={now}
            uid={uid}
            names={names}
            agent={agentOf(e)}
            summary=""
            swipeable={false}
            onOpen={() =>
              void navigate({ to: '/p/$pid', params: { pid: e.pid }, search: { item: e.itemId } })
            }
            onSwipe={() => undefined}
            onLongPress={() => undefined}
          />
        ))}
      </ul>
    </section>
  ) : null;

  const working = shell.agents.filter(
    (a) =>
      !a.data.revokedAt && shell.runs.some((r) => r.data.agentUid === a.id && isLive(r.data, now)),
  );
  const activeAgents = shell.agents.some((a) => !a.data.revokedAt);
  const saved = useLiveDoc(firstRunPath(uid, wid), firstRunSchema, { synced: true });
  const savedKnown = saved.state === 'ready' && !saved.fromCache;
  const ever = saved.state === 'ready' ? saved.data : null;
  const first = firstRunState({
    projects: shell.projects,
    items: shell.items,
    agents: shell.agents,
    ever,
  });
  // Only on the server's word: a list still loading is not an empty one.
  const showFirstRun =
    !loading && shell.settled && savedKnown && !ever?.dismissed && !firstRunDone(first);
  const synced = shell.settled && savedKnown;
  useEffect(() => {
    if (!synced) return;
    // Remember the steps seen done (and the whole list once it is complete), per person and organization.
    const next = { dismissed: !!ever?.dismissed, ...first };
    const nothing = !first.project && !first.idea && !first.agent;
    const same =
      !!ever &&
      ever.project === first.project &&
      ever.idea === first.idea &&
      ever.agent === first.agent;
    if (same || (nothing && !ever)) return;
    void setDoc(doc(db, firstRunPath(uid, wid)), next).catch(() => undefined);
  }, [synced, first.project, first.idea, first.agent, ever, uid, wid]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstProject = shell.projects.find((p) => !p.data.archivedAt) ?? null;
  const empty = loading ? null : (
    <EmptyState
      icon={Inbox}
      title="Nothing needs you."
      description={
        working.length
          ? `${working.length} ${working.length === 1 ? 'agent is' : 'agents are'} working. New decisions show up here as they arrive.`
          : activeAgents
            ? 'Agents are idle. New decisions show up here as they arrive.'
            : 'New decisions show up here as they arrive.'
      }
    >
      {working.length ? (
        <ul className="flex flex-col items-center gap-2">
          {working.map((a) => (
            <li key={a.id} className="inline-flex items-center gap-2 text-14 text-text-2">
              <AgentAvatar
                name={a.data.name}
                color={colorIndex(a.data.color, a.id)}
                live
                size="sm"
              />
              {a.data.name} <WorkingDots />
            </li>
          ))}
        </ul>
      ) : null}
    </EmptyState>
  );

  const detail = focused ? (
    <Suspense fallback={<DetailSkeleton />}>
      <InboxDetail
        key={focused.key}
        entry={focused}
        wid={wid}
        uid={uid}
        now={now}
        names={names}
        agents={shell.agents}
        run={runOf(focused) ?? null}
        runsLoading={!shell.settled}
        findings={(shell.suggestions[focused.pid] ?? [])
          .filter((r) => r.data.parentItemId === focused.itemId && isOpenFinding(r.data))
          .map((r) => r.data)}
        questions={(shell.questions[focused.pid] ?? [])
          .filter((q) => q.data.itemId === focused.itemId)
          .map((q) => q.data.text)}
        rationale={rationales[focused.key] ?? ''}
        onRationale={(v) => setRationales((cur) => ({ ...cur, [focused.key]: v }))}
        onDecide={(d) => decideEntry(focused, d)}
        onDialog={(mode) => setDialog({ mode, key: focused.key })}
        onBack={() => go(null, false)}
        phone={!desktop}
        position={{ index: list.findIndex((e) => e.key === focused.key), total: list.length }}
        onStep={step}
        released={held && held.entry.key === focused.key ? held.phase : undefined}
        doneRuns={shell.runs.filter((r) => r.data.itemId === focused.itemId)}
      />
    </Suspense>
  ) : null;

  const summaryLine = counts.all
    ? `${counts.all} ${counts.all === 1 ? 'thing needs' : 'things need'} you.`
    : 'You are all caught up.';

  const dialogs = (
    <>
      {dialogEntry ? (
        <Suspense fallback={null}>
          <SendBackDialog
            open={dialog?.mode === 'iterate'}
            onOpenChange={(o) => {
              if (!o) setDialog(null);
            }}
            project={dialogEntry.project}
            projectId={dialogEntry.pid}
            itemId={dialogEntry.itemId}
            item={dialogEntry.item}
          />
        </Suspense>
      ) : null}
      <DecisionDialog
        mode={dialog?.mode === 'iterate' ? null : (dialog?.mode ?? null)}
        entry={dialogEntry}
        initialText={dialogEntry ? (rationales[dialogEntry.key] ?? '') : ''}
        nextName={nextNameOf(dialogEntry)}
        onSubmit={decideEntry}
        onClose={() => setDialog(null)}
      />
      <Sheet
        open={!!quickEntry}
        onOpenChange={(o) => {
          if (!o) setQuick(null);
        }}
        title={quickEntry?.item.title ?? 'Quick actions'}
      >
        {quickEntry ? (
          <div className="flex flex-col gap-2">
            {quickEntry.kind === 'approval' ? (
              <>
                {quickCountdown ? (
                  <UndoButton countdown={quickCountdown} variant="approve" />
                ) : (
                  <Button
                    variant="approve"
                    disabled={!!quickCountdown}
                    onClick={() => decideEntry(quickEntry, { kind: 'approve', rationale: '' })}
                  >
                    Approve
                  </Button>
                )}
                <Button
                  variant="sendback"
                  disabled={!!quickCountdown}
                  onClick={() => {
                    setDialog({ mode: 'iterate', key: quickEntry.key });
                    setQuick(null);
                  }}
                >
                  Send back…
                </Button>
                <Button
                  variant="sendback"
                  disabled={!!quickCountdown}
                  onClick={() => {
                    setDialog({ mode: 'reject', key: quickEntry.key });
                    setQuick(null);
                  }}
                >
                  Reject…
                </Button>
              </>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => {
                go(quickEntry.key, false);
                setQuick(null);
              }}
            >
              Open
            </Button>
          </div>
        ) : null}
      </Sheet>
    </>
  );

  return (
    <>
      <div className="mb-4">
        <Eyebrow>{session.workspace.name}</Eyebrow>
        <h1 className="mt-1 text-28 font-semibold">Hi {firstName(session.profile.name)}</h1>
        <p aria-live="polite" className="mt-0.5 text-14 text-text-2">
          {loading ? ' ' : summaryLine}
        </p>
      </div>
      {loading ? (
        <div role="status" aria-label="Loading Needs you" className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}
      {showFirstRun ? (
        <div className="mb-4">
          <FirstRun
            state={first}
            project={firstProject}
            onDismiss={() => {
              void setDoc(doc(db, firstRunPath(uid, wid)), { ...first, dismissed: true }).catch(
                () => undefined,
              );
            }}
          />
        </div>
      ) : null}
      {loading ? null : chips}
      {loading ? null : list.length === 0 && waiting.length === 0 ? (
        <div className="mt-4">{empty}</div>
      ) : (
        <div className="mt-3 max-w-3xl">
          {list.length === 0 ? (
            <p className="py-4 text-14 text-text-2">Nothing in this filter.</p>
          ) : (
            rows
          )}
          {waitingList}
        </div>
      )}
      {detail}
      {dialogs}
      {picked.size > 0 ? (
        <>
          {/* Keeps the last row scrollable above the fixed bar. */}
          <div
            aria-hidden
            style={{ height: `calc(${barHeight}px + 80px + env(safe-area-inset-bottom))` }}
          />
          <SelectionBar count={picked.size} onHeight={setBarHeight} onClear={clearPicked}>
            {batch?.tag === 'batch-approve' ? (
              <BarUndo countdown={batch} primary />
            ) : (
              <button
                type="button"
                className={BAR_PRIMARY}
                disabled={!!batch}
                onClick={() => decidePicked({ kind: 'approve', rationale: '' })}
              >
                <Check size={16} aria-hidden />
                Approve {picked.size}
              </button>
            )}
            {batch?.tag === 'batch-reject' ? (
              <BarUndo countdown={batch} />
            ) : (
              <button
                type="button"
                className={BAR_BUTTON}
                disabled={!!batch}
                onClick={() => setBulkReject(true)}
              >
                <X size={16} aria-hidden />
                Reject…
              </button>
            )}
          </SelectionBar>
        </>
      ) : null}
      <DecisionDialog
        mode={bulkReject ? 'reject' : null}
        entry={bulkReject ? (pickedNow().live[0] ?? null) : null}
        description={`${picked.size} selected items, one reason for all`}
        onSubmit={(_e, d) => (d.kind === 'reject' ? decidePicked(d) : null)}
        onClose={() => setBulkReject(false)}
      />
    </>
  );
}

function DetailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading the item"
      className="fixed inset-0 z-40 flex flex-col gap-3 bg-canvas p-6"
    >
      <Skeleton className="h-7 w-2/3" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
