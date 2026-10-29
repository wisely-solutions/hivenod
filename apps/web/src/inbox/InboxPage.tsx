import { firstRunPath, firstRunSchema, nextOnPath } from '@hive/shared';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { doc, setDoc } from 'firebase/firestore';
import { Inbox, SlidersHorizontal } from 'lucide-react';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { colorIndex } from '../agents/logic';
import { firstName, useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveDoc } from '../lib/live';
import { isItemLive } from '../board/logic';
import { displayName, useProfiles } from '../members/data';
import { isLive } from '../shell/logic';
import { useShellData } from '../shell/data';
import { useShortcut } from '../shell/shortcuts';
import { useOptionalCapture } from '../capture/CaptureProvider';
import { AgentAvatar } from '../ui/avatar';
import { Segmented, Select } from '../ui/form';
import { Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState, Skeleton, WorkingDots } from '../ui/feedback';
import { AnimatePresence, motion } from '../ui/motion';
import { Popover, Sheet, useCountdowns } from '../ui/overlay';
import { BriefCard } from '../today/BriefCard';
import { DecisionCard, type DecisionCardHandle } from '../today/DecisionCard';
import { DecisionRow, DoneRow } from '../today/DecisionRow';
import { TidyUps } from '../today/TidyUps';
import { TodayRail } from '../today/TodayRail';
import { useToday } from '../today/useToday';
import { Icon } from '../ui/icon';
import { UndoButton } from '../ui/UndoButton';
import { BAR_BUTTON, BAR_PRIMARY, BarUndo, SelectionBar } from '../board/SelectionBar';
import { rangeKeys } from '../board/bulk';
import { isTypingTarget } from '../shell/shortcuts';
import { Check, X } from 'lucide-react';
import { DecisionDialog, type DialogMode } from './DecisionDialog';
import { InboxRow, type RowAgent } from './InboxRow';
import { isOpenFinding, nextKey, parseFilter, type InboxEntry } from './logic';
import { useNeedsAll } from '../needs/data';
import { ScopeLine } from '../shell/ScopePill';
import { OrgChips } from '../orgs/OrgChips';
import {
  countKinds,
  countNeeds,
  filterByLabel,
  filterKind,
  filterNeeds,
  labelsOfNeeds,
  orderToday,
  parseScope,
  type NeedsEntry,
  type Scope,
} from '../needs/logic';
import { useToast } from '../ui/overlay';
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

/**
 * Screen 1, the heart of Hivenod: everything waiting on me, decided in seconds (SPEC 9.1), across
 * every organization I am in (item 2YZRd), grouped by organization and project.
 */
export function InboxPage() {
  const {
    sel,
    f: rawFilter,
    who: rawWho,
    org: rawOrg,
    label: rawLabel,
  } = useSearch({ strict: false }) as {
    sel?: string;
    f?: string;
    who?: string;
    org?: string;
    label?: string;
  };
  const { session, switchOrg } = useReady();
  const toast = useToast();
  const all = useNeedsAll();
  const scope = parseScope(rawWho);
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
  const loading = shell.loading || (!all.settled && patient);
  const orgFilter = rawOrg && all.orgs.some((o) => o.wid === rawOrg) ? rawOrg : null;
  const manyOrgs = all.orgs.length > 1;
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

  const needs = all.needs;
  const { hidden, decide, decideMany, held, release } = useDecide();
  const countdowns = useCountdowns();
  // Every row of every organization, the suggestions last (their own section).
  const everything = useMemo(
    () => [...needs.todo, ...needs.suggestions],
    [needs.todo, needs.suggestions],
  );
  const byKey = useMemo(() => new Map(everything.map((e) => [e.key, e])), [everything]);
  const visible = useMemo(() => everything.filter((e) => !hidden.has(e.key)), [everything, hidden]);
  // The org picker narrows everything; Only me · Shared · All counts within it.
  const inOrgAll = useMemo(() => filterNeeds(visible, 'all', orgFilter), [visible, orgFilter]);
  // The label filter (Inbox threads only) combines with the organization and the rest.
  const labelOptions = useMemo(() => labelsOfNeeds(inOrgAll), [inOrgAll]);
  const labelFilter = rawLabel ? rawLabel.toLowerCase() : null;
  const inOrg = useMemo(() => filterByLabel(inOrgAll, labelFilter), [inOrgAll, labelFilter]);
  const scoped = useMemo(() => filterNeeds(inOrg, scope), [inOrg, scope]);
  const counts = countKinds(scoped);
  const whoCounts = countNeeds(inOrg);
  // A finally-approved item stays in the list through the Undo window and the Done moment
  // (it is already out of the counts), then Needs you moves on.
  const [heldAt, setHeldAt] = useState(0);
  const shown = useMemo(() => {
    if (!held) return scoped;
    if (scoped.some((e) => e.key === held.entry.key)) return scoped;
    const h = held.entry;
    const hw = h.wid ?? wid;
    const row: NeedsEntry = {
      key: h.key,
      wid: hw,
      org: all.orgs.find((o) => o.wid === hw)?.name ?? '',
      kind: h.kind,
      since: h.since,
      urgent: false,
      who: { only: true },
      group: h.pid,
      entry: h,
    };
    const out = [...scoped];
    out.splice(Math.min(Math.max(heldAt, 0), out.length), 0, row);
    return out;
  }, [scoped, held, heldAt, wid, all.orgs]);
  const filtered = filterKind(shown, filter);
  // Today (item kt3E7): one stack in rank order (design 2.1). Tidy-ups go to their own card
  // unless kept for me; Skip moves a decision to the end for this visit.
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [skipped, setSkipped] = useState<string[]>([]);
  const [done, setDone] = useState<{ key: string; label: string; at: number }[]>([]);
  const tidyAll = filtered.filter((e) => e.tidy);
  const tidy = tidyAll.filter((e) => !kept.has(e.key));
  const ordered = orderToday(
    filtered
      .filter((e) => e.kind !== 'finding')
      .map((e) => (e.tidy && kept.has(e.key) ? { ...e, tidy: false } : e)),
    now,
  );
  const list = [
    ...ordered.filter((e) => !skipped.includes(e.key)),
    ...skipped.flatMap((k) => ordered.filter((e) => e.key === k)),
  ];
  const found = filtered.filter((e) => e.kind === 'finding');
  // Keyboard order and the focus view's position: the list, then the suggestions.
  const nav = [...list, ...found];
  const batch = countdowns.find((c) => c.tag.startsWith('batch-'));
  const waiting = filterNeeds(
    needs.waiting.filter((e) => !hidden.has(e.key)),
    'all',
    orgFilter,
  );

  // The row that is highlighted (desktop: the first one until you pick), and the item opened in
  // the focus view over the list (card ExMNfP8A).
  const focusedRow = nav.find((e) => e.key === sel) ?? null;
  // The focus view opens items of the organization on screen; another one's is opened by
  // switching to it first (openRow).
  const focused = focusedRow?.entry && focusedRow.wid === wid ? focusedRow.entry : null;
  const selectedRow = focusedRow ?? (desktop ? (nav[0] ?? null) : null);
  const selected = selectedRow?.entry ?? null;
  // The thread drawn as the decision card: the focused one, or the first of the stack.
  const cardEntry = (() => {
    const r = selectedRow ?? nav[0];
    return r?.thread ? r : null;
  })();
  const cardRef = useRef<DecisionCardHandle>(null);
  const capture = useOptionalCapture();
  const today = useToday(all, list, tidy, now, done.length);

  // Moving on: the held entry goes in the same render that shows the next selection.
  const heldLeaving = held?.leaving ? held.entry.key : null;
  useEffect(() => {
    if (heldLeaving && selected?.key !== heldLeaving) release();
  }, [heldLeaving, selected?.key, release]);

  const deciderUids = useMemo(
    () => [
      ...new Set(
        [...needs.todo, ...needs.waiting].flatMap((e) =>
          e.entry && e.wid === wid
            ? (e.entry.project.steps.find((s) => s.id === e.entry!.item.stepId)?.gate
                ?.deciderUids ?? [])
            : [],
        ),
      ),
    ],
    [needs, wid],
  );
  const profiles = useProfiles(wid, deciderUids);
  const names = useMemo(
    () => Object.fromEntries(deciderUids.map((u) => [u, displayName(profiles[u], u)])),
    [deciderUids, profiles],
  );
  /** Names for an entry's organization (the one on screen has the freshest profiles). */
  const namesOf = (w: string | undefined) => (!w || w === wid ? names : (all.names[w] ?? {}));

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
    // Runs and agents are only loaded for the organization on screen.
    if (e.wid && e.wid !== wid) return undefined;
    if (e.kind === 'finding')
      return e.item.sourceRunId ? shell.runs.find((r) => r.id === e.item.sourceRunId) : undefined;
    return runsByItem.get(e.itemId);
  }

  function agentOf(e: InboxEntry): RowAgent | null {
    if (e.wid && e.wid !== wid) return null;
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
  const entryOf = (key: string | null) => (key ? (byKey.get(key)?.entry ?? null) : null);
  const dialogEntry = dialog ? entryOf(dialog.key) : null;
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
  const quickEntry = entryOf(quick);

  // Selecting several Approve/Accept rows to decide them together. Questions, findings and path
  // decisions need a real answer each, so they cannot be selected.
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [barHeight, setBarHeight] = useState(56);
  const [bulkReject, setBulkReject] = useState(false);
  const anchor = useRef<string | null>(null);
  const selectable = (e: { kind: string }) => e.kind === 'approval';
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
  /**
   * The selected entries still in Needs you, and how many left meanwhile (decided elsewhere). A
   * selection may span organizations: each is decided in its own (useDecide).
   */
  const pickedNow = () => {
    const live = needs.todo.flatMap((e) =>
      e.entry && picked.has(e.key) && selectable(e) ? [e.entry] : [],
    );
    return { live, gone: picked.size - live.length };
  };
  const decidePicked = (d: Parameters<typeof decideMany>[1]) => {
    const { live, gone } = pickedNow();
    // The selection and its bar stay while the button counts down; they clear when it ends.
    return decideMany(live, d, gone, clearPicked);
  };

  const keep = {
    ...(filter !== 'all' ? { f: filter } : {}),
    ...(scope !== 'all' ? { who: scope as Exclude<Scope, 'all'> } : {}),
    ...(orgFilter ? { org: orgFilter } : {}),
    ...(labelFilter ? { label: labelFilter } : {}),
  };
  const go = (key: string | null, replace = true) =>
    void navigate({
      to: '/',
      search: { ...(key ? { sel: key } : {}), ...keep },
      replace,
    });

  /**
   * Opens a row. An Inbox thread opens on the Inbox screen; an item of another organization
   * switches to that organization first (its detail, send-back and history read from there).
   */
  const openRow = (e: NeedsEntry) => {
    if (e.thread) {
      void navigate({
        to: '/inbox/$wid/t/$tid',
        params: { wid: e.wid, tid: e.thread.id },
        search: { from: 'today' },
      });
      return;
    }
    if (e.wid !== wid) {
      switchOrg(e.wid).then(
        () => go(e.key, false),
        () => toast.push({ message: 'Could not open it. Try again.' }),
      );
      return;
    }
    go(e.key, false);
  };

  // Undo runs up to 5 s after the decision: read where the person is now, not where they were.
  const latest = useRef({ sel, desktop, go, nav, list });
  // Where each decision was, and what came after it: a written decision leaves the list before
  // its card hears back, and the focus must still move to the one below it.
  const placeOf = useRef(new Map<string, { at: number; next: string | null }>());
  useEffect(() => {
    latest.current = { sel, desktop, go, nav, list };
    list.forEach((e, i) => placeOf.current.set(e.key, { at: i, next: nextKey(nav, e.key) }));
  });
  /** A decision card's plan was written: it collapses to its done row, the next one takes focus. */
  const cardDone = (key: string, label: string) => {
    const cur = latest.current;
    const place = placeOf.current.get(key);
    const i = cur.list.findIndex((e) => e.key === key);
    const at = i >= 0 ? i : (place?.at ?? 0);
    setDone((d) => [...d, { key, label, at }]);
    if (cur.sel === key) {
      const next =
        i >= 0
          ? nextKey(cur.nav, key)
          : place?.next && cur.nav.some((e) => e.key === place.next)
            ? place.next
            : (cur.nav[Math.min(at, cur.nav.length - 1)]?.key ?? null);
      cur.go(next);
    }
  };
  const skip = (key: string) => {
    setSkipped((cur) => [...cur.filter((k) => k !== key), key]);
    const following = nextKey(nav, key);
    if (following && following !== key) go(following);
  };

  // The next item slides into focus when the current one leaves.
  const decideEntry = (e: InboxEntry, d: Parameters<typeof decide>[1]) => {
    // Already counting down on its button: a second press (or the A key) does nothing.
    if (countdowns.some((c) => c.key === e.key)) return null;
    const following = nextKey(nav, e.key);
    const fromDetail = sel === e.key;
    setHeldAt(shown.findIndex((x) => x.key === e.key));
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
      const key = selectedRow && selectable(selectedRow) ? selectedRow.key : selectOrder[0];
      if (!key) return;
      e.preventDefault();
      pick(key, e.shiftKey);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const step = (dir: 1 | -1) => {
    if (!nav.length) return;
    // Nothing selected yet on a phone: the first j/k lands on the first item, not the second.
    // On desktop the first one is already the focused decision (Today's card), so j moves on.
    if (!focusedRow && !desktop) return go(nav[0]!.key);
    const i = Math.max(
      0,
      nav.findIndex((e) => e.key === selectedRow?.key),
    );
    const to = nav[Math.min(nav.length - 1, Math.max(0, i + dir))];
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
      const e = selectedRow ?? nav[0];
      if (e && !focused) openRow(e);
    },
  });
  useShortcut({
    id: 'inbox:approve',
    keys: ['a'],
    label: 'Approve',
    group: 'Needs you',
    run: () => {
      if (cardEntry && (!selectedRow || selectedRow.key === cardEntry.key))
        cardRef.current?.approve();
      else if (selected && canApprove)
        decideEntry(selected, { kind: 'approve', rationale: rationales[selected.key] ?? '' });
    },
  });
  useShortcut({
    id: 'today:edit',
    keys: ['e'],
    label: 'Edit the proposal',
    group: 'Needs you',
    run: () => cardRef.current?.edit(),
  });
  useShortcut({
    id: 'today:ask',
    keys: ['c'],
    label: 'Ask the agent for changes',
    group: 'Needs you',
    priority: 1,
    run: () => {
      if (!cardRef.current?.ask?.()) capture?.open();
    },
  });
  useShortcut({
    id: 'today:prev-version',
    keys: ['['],
    label: 'Earlier version of the proposal',
    group: 'Needs you',
    run: () => cardRef.current?.version?.(-1),
  });
  useShortcut({
    id: 'today:next-version',
    keys: [']'],
    label: 'Later version of the proposal',
    group: 'Needs you',
    run: () => cardRef.current?.version?.(1),
  });
  useShortcut({
    id: 'today:skip',
    keys: ['s'],
    label: 'Skip for now',
    group: 'Needs you',
    run: () => {
      const r = selectedRow ?? nav[0];
      if (r && !focused) skip(r.key);
    },
  });
  useShortcut({
    id: 'inbox:iterate',
    keys: ['r'],
    label: 'Send back or reject',
    group: 'Needs you',
    run: () => {
      if (cardEntry && (!selectedRow || selectedRow.key === cardEntry.key))
        cardRef.current?.reject();
      else if (selected && canApprove) setDialog({ mode: 'iterate', key: selected.key });
    },
  });
  useShortcut({
    id: 'inbox:close',
    keys: ['Escape'],
    label: 'Close',
    group: 'Needs you',
    run: () => {
      if (focusedRow) go(null, false);
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

  // From the search as it is now (not this render's copy): two quick changes must both stick.
  const setSearch = (patch: Partial<{ f: string; who: string; org: string; label: string }>) =>
    void navigate({
      to: '/',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        delete next.sel;
        for (const k of Object.keys(next)) if (!next[k] || next[k] === 'all') delete next[k];
        return next as never;
      },
      replace: true,
    });
  // Only me · Shared · All shows when it can tell rows apart (or is in use, or several
  // organizations are listed): one organization where everything is only yours keeps the old,
  // shorter header on a phone.
  const showWho = manyOrgs || scope !== 'all' || (whoCounts.onlyYou > 0 && whoCounts.shared > 0);
  const activeFilters =
    (filter !== 'all' ? 1 : 0) + (scope !== 'all' ? 1 : 0) + (labelFilter ? 1 : 0);
  const chips = (
    <div className="flex flex-col gap-3">
      <Segmented
        label="Filter"
        value={filter}
        onValueChange={(v) => setSearch({ f: v })}
        options={filterOptions}
      />
      {showWho ? (
        <Segmented
          label="Who can act"
          value={scope}
          onValueChange={(v) => setSearch({ who: v })}
          options={[
            { value: 'mine', label: 'Only me', count: whoCounts.onlyYou },
            { value: 'shared', label: 'Shared', count: whoCounts.shared },
            { value: 'all', label: 'All', count: whoCounts.total },
          ]}
        />
      ) : null}
      {labelOptions.length > 0 || labelFilter ? (
        <Select
          label="Filter by label"
          hideLabel
          inline
          value={labelFilter ?? 'all'}
          onValueChange={(v) => setSearch({ label: v })}
          options={[
            { value: 'all', label: 'All labels' },
            ...labelOptions.map((o) => ({ value: o.key, label: `${o.label} (${o.count})` })),
            ...(labelFilter && !labelOptions.some((o) => o.key === labelFilter)
              ? [{ value: labelFilter, label: labelFilter }]
              : []),
          ]}
        />
      ) : null}
    </div>
  );

  const agentNameOf = (w: string, id: string) =>
    (w === wid ? shell.agents.find((a) => a.id === id)?.data.name : undefined) ?? 'Your agent';
  const orgTag = (wid: string) => (manyOrgs ? today.orgOf(wid) : null);
  const renderRow = (r: NeedsEntry) => {
    if (!r.entry) {
      if (cardEntry?.key === r.key)
        return (
          <motion.li key={r.key} layout={false} className="pb-3" data-card-row={r.key}>
            <DecisionCard
              ref={cardRef}
              key={r.key}
              entry={r}
              org={today.orgOf(r.wid)}
              area={today.areaOf(r)}
              sender={today.senderOf(r)}
              now={now}
              busy={today.busy}
              agentName={(id) => agentNameOf(r.wid, id)}
              onOpen={() => openRow(r)}
              onSkip={() => skip(r.key)}
              onDone={(label) => cardDone(r.key, label)}
              swipe={!desktop}
            />
          </motion.li>
        );
      return (
        <DecisionRow
          key={r.key}
          entry={r}
          sender={today.senderOf(r)?.name ?? null}
          org={orgTag(r.wid)}
          now={now}
          onFocus={() => go(r.key, false)}
        />
      );
    }
    const e = r.entry;
    return (
      <InboxRow
        key={r.key}
        org={orgTag(r.wid)?.name}
        entry={e}
        selected={desktop && selectedRow?.key === r.key}
        now={now}
        uid={uid}
        names={namesOf(r.wid)}
        agent={agentOf(e)}
        summary={e.kind === 'finding' ? '' : (runOf(e)?.data.summary ?? '')}
        who={r.who}
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
          !desktop && picked.size > 0 && selectable(e) ? pick(e.key, false) : openRow(r)
        }
        onSwipe={(a) => setDialog({ mode: a === 'approve' ? 'approve' : 'iterate', key: e.key })}
        onLongPress={() => (selectable(e) ? pick(e.key, false) : setQuick(e.key))}
      />
    );
  };

  /** The stack's rows, with the decisions made this visit collapsed where they were. */
  const flat = (entries: NeedsEntry[], withDone: boolean) => {
    const out: ReactNode[] = [];
    const doneRows = withDone ? [...done].sort((a, b) => a.at - b.at) : [];
    let d = 0;
    entries.forEach((r, i) => {
      while (d < doneRows.length && doneRows[d]!.at <= i) {
        const x = doneRows[d++]!;
        if (!entries.some((e) => e.key === x.key))
          out.push(<DoneRow key={`done:${x.key}:${d}`} label={x.label} />);
      }
      out.push(renderRow(r));
    });
    for (; d < doneRows.length; d++) {
      const x = doneRows[d]!;
      if (!entries.some((e) => e.key === x.key))
        out.push(<DoneRow key={`done:${x.key}:${d}`} label={x.label} />);
    }
    return out;
  };

  const rows = (
    <ul aria-label="Needs you" className="flex flex-col">
      <AnimatePresence initial={false} mode="popLayout">
        {flat(allRows ? list : list.slice(0, FIRST_ROWS), true)}
      </AnimatePresence>
    </ul>
  );

  const suggestionList = found.length ? (
    <section aria-label="New suggestions" className="mt-4 flex flex-col gap-2">
      <Eyebrow>New suggestions · add or dismiss</Eyebrow>
      <ul className="flex flex-col">
        <AnimatePresence initial={false} mode="popLayout">
          {flat(found, false)}
        </AnimatePresence>
      </ul>
    </section>
  ) : null;

  const waitingList = waiting.length ? (
    <section aria-label="Waiting on others" className="mt-4 flex flex-col gap-2">
      <Eyebrow>Waiting on others</Eyebrow>
      <ul className="flex flex-col">
        {waiting.map((r) => (
          <InboxRow
            key={r.key}
            entry={r.entry!}
            selected={false}
            now={now}
            uid={uid}
            names={namesOf(r.wid)}
            agent={agentOf(r.entry!)}
            summary=""
            swipeable={false}
            onOpen={() => {
              const open = () =>
                void navigate({
                  to: '/p/$pid',
                  params: { pid: r.entry!.pid },
                  search: { item: r.entry!.itemId },
                });
              if (r.wid === wid) open();
              else
                switchOrg(r.wid).then(open, () =>
                  toast.push({ message: 'Could not open it. Try again.' }),
                );
            }}
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
        position={{ index: nav.findIndex((e) => e.key === focused.key), total: nav.length }}
        onStep={step}
        released={held && held.entry.key === focused.key ? held.phase : undefined}
        doneRuns={shell.runs.filter((r) => r.data.itemId === focused.itemId)}
      />
    </Suspense>
  ) : null;

  // Everything, in every organization and filter.
  const total = visible.length;
  const summaryLine = total
    ? `${total} ${total === 1 ? 'thing needs' : 'things need'} you.`
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
            wid={dialogEntry.wid}
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

  const filtersButton = (
    <Popover
      label="Filters"
      align="end"
      contentClassName="w-[min(26rem,calc(100vw-16px))] p-3 sm:p-4"
      trigger={
        <Button
          variant="secondary"
          className="min-h-9"
          leading={<Icon icon={SlidersHorizontal} size={15} />}
        >
          Filters{activeFilters ? ` · ${activeFilters}` : ''}
        </Button>
      }
    >
      {chips}
    </Popover>
  );
  // The organization chips (item icVly): a filter of this page only, kept in the URL.
  const orgChips = manyOrgs ? (
    <OrgChips
      className="mb-4"
      orgs={all.orgs}
      value={orgFilter}
      onChange={(w) => setSearch({ org: w ?? 'all' })}
      hint="Tap an organization to see only its decisions"
    />
  ) : null;
  const stackHead = (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
        Needs you · {list.length}
      </h2>
      <span className="ml-auto hidden items-center gap-1 text-12 text-text-3 [@media(hover:hover)]:sm:inline-flex">
        J/K move · A approve · E edit
      </span>
      <span className="max-sm:ml-auto">{filtersButton}</span>
    </div>
  );

  return (
    <>
      <div className="mb-5">
        <BriefCard
          brief={loading ? null : today.brief}
          name={firstName(session.profile.name)}
          now={now}
          loading={loading}
          scope={
            manyOrgs ? (
              <ScopeLine className="mt-1.5">
                {loading ? null : (
                  <span data-today-count="">
                    {total === 0 ? 'Nothing waits for you' : `${total} waiting for you`}
                  </span>
                )}
              </ScopeLine>
            ) : null
          }
        />
        {/* The count for screen readers (and the old summary line's place). */}
        <p aria-live="polite" className="sr-only">
          {loading || total === 0 ? '\u00a0' : summaryLine}
        </p>
      </div>
      {loading ? (
        <div role="status" aria-label="Loading Needs you" className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}
      {loading ? null : (
        <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start xl:gap-6">
          <div className="min-w-0">
            {total === 0 && waiting.length === 0 ? (
              <>
                {orgFilter ? orgChips : null}
                {activeFilters ? stackHead : null}
                <div className="mt-2">{empty}</div>
              </>
            ) : (
              <>
                {orgChips}
                {stackHead}
                {list.length === 0 && found.length === 0 && tidyAll.length === 0 ? (
                  <p className="py-4 text-14 text-text-2">Nothing in this filter.</p>
                ) : list.length ? (
                  rows
                ) : null}
                <TidyUps
                  entries={tidyAll}
                  kept={kept}
                  onKeep={(key, on) =>
                    setKept((cur) => {
                      const next = new Set(cur);
                      if (on) next.add(key);
                      else next.delete(key);
                      return next;
                    })
                  }
                  onDone={(keys) => {
                    if (keys.length)
                      setDone((d) => [
                        ...d,
                        {
                          key: `tidy:${keys.join(',')}`,
                          label: `Approved ${keys.length} ${keys.length === 1 ? 'tidy-up' : 'tidy-ups'}`,
                          at: list.length,
                        },
                      ]);
                  }}
                />
                {suggestionList}
                {waitingList}
              </>
            )}
          </div>
          <aside aria-label="Your day" className="mt-6 xl:mt-0">
            <TodayRail
              agenda={today.agenda}
              freeMinutes={today.freeMinutes}
              waiting={today.waiting}
              working={today.working}
              now={now}
            />
          </aside>
        </div>
      )}
      {showFirstRun ? (
        <div className="mt-6">
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
