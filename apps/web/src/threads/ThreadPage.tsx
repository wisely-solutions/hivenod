/**
 * One Inbox thread as a decision page (item OE8FmrTaIxFVGcaeGG3N, slice 2; design 3): the header,
 * the top card (ask, answer, recommendation, buttons, freshness), the short version (bullets and
 * visuals), then More detail and Everything folded (D and E toggle them). A plan is a sticky right
 * rail from 1024 px and a fold on a phone. Opened from Today (?from=today) it adds the briefing
 * bar and moves on to the next decision once one is made. The member's other actions sit in ⋯.
 */
import {
  agentSchema,
  planView,
  summaryPaths,
  closeThread,
  createItem,
  dueThread,
  flagThread,
  ignoreThread,
  makeItemFromThread,
  moveThread,
  projectSchema,
  restoreThread,
  shapesNewItems,
  type ActionPlan,
} from '@hive/shared';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { collection, query, where } from 'firebase/firestore';
import {
  ArrowRightLeft,
  Ban,
  CalendarClock,
  CircleCheck,
  Flag,
  ListChecks,
  MoreHorizontal,
  RotateCcw,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { isOnline } from '../agents/logic';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveCollection, useLiveDoc, useLiveQuery } from '../lib/live';
import { useShortcut } from '../shell/shortcuts';
import type { DecisionCardHandle } from '../today/DecisionCard';
import { useNeedsAll } from '../needs/data';
import { orgColor } from '../orgs/color';
import { useBriefing, type BriefingFrom } from '../today/briefing';
import { dueShort } from '../today/logic';
import { Chip, OrgChip } from '../today/parts';
import { Pill } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { cn } from '../ui/cn';
import { Skeleton } from '../ui/feedback';
import { Input, Select, Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { Dialog, useToast } from '../ui/overlay';
import { BriefingBar } from './BriefingBar';
import { useMySubjects, useThread } from './data';
import {
  freshness,
  looseSummarySchema,
  planFoldParts,
  everythingHint,
  threadImages,
  topState,
} from './decision';
import {
  detailHint,
  Everything,
  everythingLinks,
  Fold,
  HintPills,
  MoreDetail,
  ShortVersion,
} from './DecisionLayers';
import { DecisionTop, ProposalEffects } from './DecisionTop';
import { planInputOf, planLive, planMain } from './plan';
import { PlanPanel } from './PlanPanel';
import { LabelChip } from './labels';
import { timeline } from './logic';
import { BackLink, errorText, StateChip } from './parts';

const myProjectsIn = (wid: string, uid: string) =>
  query(collection(db, `workspaces/${wid}/projects`), where('memberUids', 'array-contains', uid));

const WIDE = '(min-width: 1024px)';
function subscribeWide(cb: () => void) {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
/** Two columns from 1024 px; below, the agent panel is a bottom sheet. */
export function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

export function ThreadPage() {
  const { wid, tid } = useParams({ from: '/inbox/$wid/t/$tid' });
  const { from } = useSearch({ strict: false }) as { from?: BriefingFrom };
  const { session, actionContext, run } = useReady();
  const navigate = useNavigate();
  const uid = session.me.uid;
  const { thread, messages, outcomes, events, plans, attachments, subject } = useThread(
    wid,
    tid,
    uid,
  );
  const agents = useLiveCollection(`workspaces/${wid}/agents`, agentSchema);
  const all = useNeedsAll();
  const wide = useWide();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [makeOpen, setMakeOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  // The folds (design 3.1): More detail and Everything start folded; D and E toggle them.
  const [detailOpen, setDetailOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const topRef = useRef<DecisionCardHandle>(null);
  // The summary (item OE8FmrTaIxFVGcaeGG3N): read only once the thread says one exists.
  const hasSummary = thread.state === 'ready' && !!thread.data?.summary;
  const summaryDoc = useLiveDoc(
    hasSummary ? summaryPaths.summary(wid, tid) : null,
    looseSummarySchema,
  );
  // The thread's files (slice 4); its images are what image visuals may show.
  const attachRows = useMemo(
    () => (attachments.state === 'ready' ? attachments.data : []),
    [attachments],
  );
  const images = useMemo(() => threadImages(attachRows, tid), [attachRows, tid]);
  useShortcut({
    id: 'thread-detail',
    keys: ['d'],
    label: 'Show or hide More detail',
    group: 'Thread',
    run: () => setDetailOpen((v) => !v),
  });
  useShortcut({
    id: 'thread-everything',
    keys: ['e'],
    label: 'Show or hide Everything',
    group: 'Thread',
    run: () => setAllOpen((v) => !v),
  });
  useShortcut({
    id: 'thread-approve',
    keys: ['a'],
    label: 'Approve',
    group: 'Thread',
    run: () => topRef.current?.approve(),
  });
  useShortcut({
    id: 'thread-not-now',
    keys: ['n'],
    label: 'Not now',
    group: 'Thread',
    run: () => topRef.current?.notNow?.(),
  });
  useShortcut({
    id: 'thread-ask',
    keys: ['c'],
    label: 'Ask for changes',
    group: 'Thread',
    priority: 1,
    run: () => void topRef.current?.ask?.(),
  });

  // Briefing mode: where this thread is in Today's order, and the one after it.
  const key = `t:${wid}:${tid}`;
  const briefing = useBriefing(from, key, now);
  const nextRef = useRef<string | null>(null);
  // Remembered while this thread is still listed: once decided it leaves the list.
  const nextKey =
    briefing && briefing.index >= 0
      ? (briefing.list[briefing.index + 1] ?? briefing.list[briefing.index - 1])?.key
      : undefined;
  useEffect(() => {
    if (nextKey !== undefined) nextRef.current = nextKey;
  }, [nextKey]);
  const goNext = () => {
    if (!from || !briefing) return;
    const n = briefing.list.find((e) => e.key === nextRef.current && e.key !== key);
    if (n?.thread)
      void navigate({
        to: '/inbox/$wid/t/$tid',
        params: { wid: n.wid, tid: n.thread.id },
        search: { from },
      });
    else if (n) void navigate({ to: '/', search: { sel: n.key } });
    else void navigate({ to: '/' });
  };

  const agentName = (id: string) =>
    (agents.state === 'ready' && agents.data.find((a) => a.id === id)?.data.name) || 'An agent';

  const entries = useMemo(
    () =>
      timeline(
        messages.state === 'ready' ? messages.data : [],
        events.state === 'ready' ? events.data : [],
      ),
    [messages, events],
  );

  if (thread.state === 'loading')
    return (
      <div className="mx-auto w-full max-w-3xl" aria-hidden>
        <Skeleton className="mb-4 h-10 w-2/3" />
        <Skeleton className="h-40" />
      </div>
    );
  if (thread.state === 'error' || !thread.data || thread.data.memberUid !== uid)
    return (
      <div className="mx-auto w-full max-w-3xl">
        <BackLink>Inbox</BackLink>
        <p role="alert" className="text-14 text-text-2">
          This thread is not in your Inbox. Only the person a thread is for can open it.
        </p>
      </div>
    );
  const t = thread.data;
  const row = { id: tid, data: t };
  const allOutcomes = (outcomes.state === 'ready' ? outcomes.data : []).sort(
    (a, b) => a.data.createdAt.toMillis() - b.data.createdAt.toMillis(),
  );
  const open = (o: (typeof allOutcomes)[number]) =>
    o.data.state === 'proposed' || o.data.state === 'revising';
  // A plan's steps show in its checklist (item qwFAWxZM5xkcE7PPjAzi), not as single outcomes.
  const single = allOutcomes.filter((o) => !o.data.planId);
  const proposed = single.filter(open);
  const decided = single.filter((o) => !open(o));
  const planRows = (plans.state === 'ready' ? plans.data : []).sort(
    (a, b) => b.data.createdAt.toMillis() - a.data.createdAt.toMillis(),
  );
  // The plan on show: the live one, else the latest; older plans go to Everything.
  const shownPlan = planRows.find((p) => planLive(p.data.state)) ?? planRows[0] ?? null;
  const pastPlans = planRows.filter((p) => p !== shownPlan);
  const subjectName = subject.state === 'ready' ? (subject.data?.name ?? '') : '';
  const closed = t.state === 'done' || t.state === 'ignored';
  const urgent = t.urgent === true;
  const msgs = messages.state === 'ready' ? messages.data.map((m) => m.data) : [];
  const people = [...new Set(msgs.filter((m) => m.direction === 'in').map((m) => m.sender.name))];
  const channels = [...new Set(msgs.map((m) => m.source))];
  const notes = (events.state === 'ready' ? events.data : []).filter(
    (e) => e.data.type === 'thread.note',
  );
  const org = all.orgs.find((o) => o.wid === wid);
  const due = t.due ? t.due.toMillis() : null;

  // The summary as read (a doc that fails the schema shows as none: the fallback top).
  const summary =
    hasSummary && summaryDoc.state === 'ready' && summaryDoc.data ? summaryDoc.data : null;
  const home = agents.state === 'ready' ? agents.data.find((a) => a.id === t.fetchedBy) : undefined;
  const agentInfo = {
    name: agentName(t.fetchedBy),
    online: home ? isOnline(home.data, [], home.id, now) : false,
    lastSeen: home?.data.lastSeenAt?.toMillis() ?? null,
    cliVersion: home?.data.cliVersion ?? null,
  };
  const pl = shownPlan ? planInputOf(shownPlan, allOutcomes) : null;
  const view = pl ? planView(pl.plan, pl.outcomes) : null;
  const main = pl && shownPlan && planLive(shownPlan.data.state) ? planMain(pl) : null;
  const top = topState({
    thread: {
      state: t.state,
      question: t.question ? { text: t.question.text, answer: t.question.answer } : null,
      waiting: t.waiting,
      updatedAt: t.updatedAt.toMillis(),
    },
    plan: view ? { view, main, label: null, error: null } : null,
    proposals: main ? 0 : proposed.length,
    agent: agentInfo.name,
  });
  const fresh = freshness({
    summary: summary ? { version: summary.version, at: summary.at.toMillis() } : null,
    updatedAt: t.updatedAt.toMillis(),
    now,
    agent: agentInfo,
  });
  // What the agent checked: the open proposal's checks, else the waiting step's.
  const checkRow =
    proposed[0] ??
    (main?.kind === 'step' ? allOutcomes.find((o) => o.id === main.outcomeId) : undefined);
  const checks = checkRow?.data.checks ?? [];
  const links = everythingLinks(summary?.refs ?? [], msgs);
  const openEverything = () => {
    setAllOpen(true);
    requestAnimationFrame(() =>
      document.getElementById('everything-h')?.scrollIntoView({ block: 'start' }),
    );
  };

  async function act(make: () => Pick<ActionPlan, 'ops'>) {
    setError(null);
    let plan;
    try {
      plan = make();
    } catch (e) {
      setError(errorText(e));
      return false;
    }
    setBusy(true);
    try {
      await run(plan);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const ctx = () => {
    const c = actionContext(wid);
    if (!c) throw new Error('Not signed in.');
    return c;
  };

  const menu = [
    {
      id: 'move',
      label: 'Move to subject…',
      icon: ArrowRightLeft,
      onSelect: () => setMoveOpen(true),
    },
    {
      id: 'urgent',
      label: urgent ? 'Not urgent' : 'Mark urgent',
      icon: Flag,
      onSelect: () =>
        void act(() => flagThread(ctx(), { threadId: tid, thread: t, urgent: !urgent })),
    },
    {
      id: 'due',
      label: due ? 'Due date…' : 'Set a due date…',
      icon: CalendarClock,
      onSelect: () => setDueOpen(true),
    },
    { id: 'make', label: 'Make it work…', icon: ListChecks, onSelect: () => setMakeOpen(true) },
    ...(closed
      ? [
          {
            id: 'restore',
            label: 'Bring back',
            icon: RotateCcw,
            onSelect: () => void act(() => restoreThread(ctx(), { threadId: tid, thread: t })),
          },
        ]
      : [
          {
            id: 'close',
            label: 'Mark done',
            icon: CircleCheck,
            onSelect: () => void act(() => closeThread(ctx(), { threadId: tid, thread: t })),
          },
          {
            id: 'ignore',
            label: 'Ignore',
            icon: Ban,
            tone: 'danger' as const,
            onSelect: () => void act(() => ignoreThread(ctx(), { threadId: tid, thread: t })),
          },
        ]),
  ];

  const sender = (() => {
    const last = [...msgs].reverse().find((m) => m.direction === 'in');
    return last
      ? { name: last.sender.name, source: last.source, at: last.receivedAt.toMillis() }
      : null;
  })();
  const planPanel = (p: (typeof planRows)[number], rail: boolean) => (
    <PlanPanel
      key={p.id}
      wid={wid}
      thread={row}
      plan={p}
      outcomes={allOutcomes}
      sender={sender}
      now={now}
      agentName={agentName}
      rail={rail}
    />
  );
  const rail = wide && shownPlan;

  return (
    <div className={cn('mx-auto w-full', !rail && 'max-w-3xl')}>
      {from && briefing ? (
        <BriefingBar from={from} list={briefing.list} index={briefing.index} />
      ) : t.subjectId ? (
        <BackLink subject={{ wid, sid: t.subjectId }}>{subjectName || 'Subject'}</BackLink>
      ) : (
        <BackLink>Inbox</BackLink>
      )}
      <div
        data-decision-page=""
        className={cn(rail && 'lg:grid lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-start lg:gap-6')}
      >
        <div className="min-w-0">
          <header>
            <div className="flex items-start gap-2">
              <h1 className="min-w-0 flex-1 text-20 font-semibold leading-tight text-ink [overflow-wrap:anywhere] sm:text-24">
                {t.title || 'Untitled thread'}
              </h1>
              <ActionMenu
                label="Thread actions"
                actions={menu}
                trigger={
                  <IconButton label="Thread actions" disabled={busy}>
                    <Icon icon={MoreHorizontal} size={18} />
                  </IconButton>
                }
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {org ? <OrgChip name={org.name} color={orgColor(wid, all.orgs)} /> : null}
              {t.subjectId && subject.state === 'ready' && subject.data?.label ? (
                <LabelChip wid={wid} subjectId={t.subjectId} subject={subject.data} />
              ) : subject.state === 'ready' && subject.data?.area ? (
                <Chip>{subject.data.area}</Chip>
              ) : null}
              <StateChip state={t.state} waiting={t.waiting} agent={agentName(t.fetchedBy)} />
              {urgent ? (
                <Pill tone="sendback">
                  <span data-urgent="">Urgent</span>
                </Pill>
              ) : null}
              {due ? (
                <Pill tone={due < now ? 'sendback' : 'gate'}>
                  <span data-due="">{due < now ? 'Overdue' : `Due ${dueShort(due, now)}`}</span>
                </Pill>
              ) : null}
            </div>
            <p className="mt-2 text-14 text-text-2">
              {subjectName ? `${subjectName} · ` : 'Not filed yet · '}
              {people.length ? `${people.join(', ')} · ` : ''}
              {channels.length ? `${channels.join(', ')} · ` : ''}
              brought in by {agentName(t.fetchedBy)}
            </p>
          </header>
          {error ? (
            <p role="alert" className="mt-3 text-14 text-sendback">
              {error}
            </p>
          ) : null}
          <DecisionTop
            ref={topRef}
            wid={wid}
            uid={uid}
            thread={row}
            summary={summary}
            proposals={proposed}
            plan={shownPlan}
            outcomes={allOutcomes}
            messages={msgs}
            now={now}
            agentName={agentName}
            agent={agentInfo}
            onDone={() => (from ? goNext() : undefined)}
            compact={!wide}
          />
          <ShortVersion
            summary={summary}
            images={images}
            asks={top.kind === 'person' || top.kind === 'question'}
            firstMessage={msgs[0]?.text ?? ''}
            why={fresh.kind === 'none' ? fresh.why : null}
            onOpenEverything={openEverything}
          />
          {!rail && shownPlan && view ? (
            <Fold
              id="plan-fold"
              anchor="plan"
              title="Plan"
              hint={<HintPills parts={planFoldParts(view)} />}
              open={planOpen}
              onToggle={() => setPlanOpen((v) => !v)}
            >
              <div className="-mx-4 -my-3 sm:-mx-5">{planPanel(shownPlan, false)}</div>
            </Fold>
          ) : null}
          <Fold
            id="detail"
            title="More detail"
            hint={detailHint(summary?.details ?? null, checks.length)}
            open={detailOpen}
            onToggle={() => setDetailOpen((v) => !v)}
          >
            <MoreDetail details={summary?.details ?? null} checks={checks} agent={agentInfo.name} />
            {!wide && proposed[0] && !main ? (
              <ProposalEffects outcome={proposed[0]} agentName={agentName} sender={sender} />
            ) : null}
          </Fold>
          <Fold
            id="everything"
            title="Everything"
            hint={everythingHint({
              messages: msgs.length,
              notes: notes.length,
              outcomes: decided.length,
              links: links.length,
              files: attachRows.length,
            })}
            open={allOpen}
            onToggle={() => setAllOpen((v) => !v)}
          >
            <Everything
              wid={wid}
              uid={uid}
              thread={row}
              entries={entries}
              messages={msgs}
              decided={decided}
              plans={planRows}
              outcomes={allOutcomes}
              refs={summary?.refs ?? []}
              attachments={attachRows}
              now={now}
              agentName={agentName}
              pastPlans={
                pastPlans.length ? (
                  <div className="overflow-hidden rounded-card border border-line">
                    {pastPlans.map((p) => planPanel(p, false))}
                  </div>
                ) : null
              }
            />
          </Fold>
        </div>
        {rail ? (
          <aside
            aria-label="Plan rail"
            id="plan"
            data-plan-rail=""
            className="mt-6 overflow-hidden rounded-panel border border-line bg-surface shadow-e1 scroll-mt-20 lg:sticky lg:top-4 lg:mt-0"
          >
            {planPanel(shownPlan, true)}
          </aside>
        ) : null}
      </div>

      <MoveDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        wid={wid}
        uid={uid}
        current={t.subjectId}
        busy={busy}
        onMove={(sid) =>
          void act(() => moveThread(ctx(), { threadId: tid, thread: t, subjectId: sid })).then(
            (ok) => ok && setMoveOpen(false),
          )
        }
      />
      <DueDialog
        open={dueOpen}
        onOpenChange={setDueOpen}
        due={due}
        busy={busy}
        onSave={(iso) =>
          void act(() => dueThread(ctx(), { threadId: tid, thread: t, due: iso })).then(
            (ok) => ok && setDueOpen(false),
          )
        }
      />
      <MakeItWork
        open={makeOpen}
        onOpenChange={setMakeOpen}
        wid={wid}
        tid={tid}
        thread={t}
        subjectName={subjectName}
        firstText={msgs[0]?.text ?? ''}
      />
    </div>
  );
}

function MoveDialog({
  open,
  onOpenChange,
  wid,
  uid,
  current,
  busy,
  onMove,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  wid: string;
  uid: string;
  current: string | null;
  busy: boolean;
  onMove: (sid: string) => void;
}) {
  const subjects = useMySubjects(wid, uid);
  const [to, setTo] = useState('');
  const options =
    subjects.state === 'ready'
      ? subjects.data
          .filter((s) => s.id !== current)
          .sort((a, b) => a.data.name.localeCompare(b.data.name))
          .map((s) => ({ value: s.id, label: s.data.name }))
      : [];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Move to another subject"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!to || busy} onClick={() => to && onMove(to)}>
            Move
          </Button>
        </>
      }
    >
      {options.length === 0 ? (
        <p className="text-14 text-text-2">You have no other subject in this organization.</p>
      ) : (
        <Select
          label="Move to subject"
          value={to}
          onValueChange={setTo}
          options={[{ value: '', label: 'Pick a subject…' }, ...options]}
        />
      )}
    </Dialog>
  );
}

const localInput = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** Sets or clears the thread's deadline (thread.due, the member's own). */
function DueDialog({
  open,
  onOpenChange,
  due,
  busy,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  due: number | null;
  busy: boolean;
  onSave: (iso: string | null) => void;
}) {
  const [value, setValue] = useState(() => (due ? localInput(due) : ''));
  const [seen, setSeen] = useState({ open, due });
  if (seen.open !== open || seen.due !== due) {
    setSeen({ open, due });
    if (open) setValue(due ? localInput(due) : '');
  }
  const ms = value ? new Date(value).getTime() : NaN;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Due date"
      description="Today ranks the thread by it: due within a day comes first."
      footer={
        <>
          {due ? (
            <Button variant="secondary" disabled={busy} onClick={() => onSave(null)}>
              Clear the due date
            </Button>
          ) : null}
          <Button
            variant="primary"
            loading={busy}
            disabled={Number.isNaN(ms)}
            onClick={() => onSave(new Date(ms).toISOString())}
          >
            Save
          </Button>
        </>
      }
    >
      <Input
        label="Due"
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </Dialog>
  );
}

function MakeItWork({
  open,
  onOpenChange,
  wid,
  tid,
  thread,
  subjectName,
  firstText,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  wid: string;
  tid: string;
  thread: Parameters<typeof makeItemFromThread>[1]['thread'] & { title: string };
  subjectName: string;
  firstText: string;
}) {
  const { session, actionContext, run } = useReady();
  const uid = session.me.uid;
  const toast = useToast();
  const navigate = useNavigate();
  const projects = useLiveQuery(
    open ? `mw:${wid}:${uid}` : null,
    () => myProjectsIn(wid, uid),
    projectSchema,
  );
  const live = projects.state === 'ready' ? projects.data.filter((p) => !p.data.archivedAt) : [];
  const [pid, setPid] = useState('');
  const [title, setTitle] = useState(thread.title);
  const [brief, setBrief] = useState(() => firstText.slice(0, 2000));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = live.find((p) => p.id === pid) ?? live[0];

  async function create() {
    const ctx = actionContext(wid);
    if (!ctx || !chosen) return;
    setError(null);
    let plan;
    try {
      const link = `${window.location.origin}/inbox/${wid}/t/${tid}`;
      const item = createItem(ctx, {
        project: chosen.data,
        projectId: chosen.id,
        title: title.trim(),
        type: 'task',
        summary:
          `${brief.trim()}\n\nFrom Inbox${subjectName ? ` (${subjectName})` : ''}: ${link}`.trim(),
        source: { kind: 'inbox', label: subjectName.slice(0, 200) || 'Inbox' },
        unshaped: shapesNewItems(chosen.data),
      });
      if (!title.trim()) throw new Error('The item needs a title.');
      plan = makeItemFromThread(ctx, {
        threadId: tid,
        thread,
        item,
        projectId: chosen.id,
        title: title.trim(),
      });
    } catch (e) {
      setError(errorText(e));
      return;
    }
    setBusy(true);
    try {
      await run(plan);
      onOpenChange(false);
      const itemId = plan.itemId;
      const projectId = chosen.id;
      toast.push({
        message: `Item made in ${chosen.data.name}.`,
        actionLabel: 'Open',
        onAction: () =>
          void navigate({ to: '/p/$pid', params: { pid: projectId }, search: { item: itemId } }),
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Make it work"
      description="A Hivenod item in one of your projects, made by you and linked on this thread. Its project's people see what you put in it."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!chosen || !title.trim()}
            onClick={() => void create()}
          >
            Create item
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {projects.state === 'ready' && live.length === 0 ? (
          <p className="text-14 text-text-2">You are in no project of this organization.</p>
        ) : (
          <Select
            label="Project"
            value={chosen?.id ?? ''}
            onValueChange={setPid}
            options={live.map((p) => ({ value: p.id, label: p.data.name }))}
          />
        )}
        <Input label="Item title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea label="Brief" value={brief} onChange={(e) => setBrief(e.target.value)} />
        {error ? (
          <p role="alert" className="text-14 text-sendback">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
