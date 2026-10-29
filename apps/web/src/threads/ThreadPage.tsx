/**
 * One Inbox thread (item 4PEHrOW5IfXBQWgOK9wo; redesigned in item kt3E7u9EliL3q2veDDI0, design
 * 2.3): the conversation on the left (messages as bubbles, agent notes and decisions inline, the
 * full timeline in a disclosure) and the agent panel on the right (what it checked, the proposal
 * with what happens on approval, its question, the outcomes, related subjects). On a phone the
 * panel is a bottom sheet. Opened from Today (?from=today) it adds the briefing bar and moves on
 * to the next decision once one is made. The member's other actions sit in the ⋯ menu.
 */
import {
  agentSchema,
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
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveCollection, useLiveQuery } from '../lib/live';
import { useNeedsAll } from '../needs/data';
import { orgColor } from '../orgs/color';
import { useBriefing, type BriefingFrom } from '../today/briefing';
import { dueShort } from '../today/logic';
import { Chip, OrgChip } from '../today/parts';
import { useMyCalendar } from '../today/useToday';
import { Pill } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Skeleton } from '../ui/feedback';
import { Input, Select, Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { Dialog, useToast } from '../ui/overlay';
import { AgentPanel } from './AgentPanel';
import { BriefingBar } from './BriefingBar';
import { Conversation } from './Conversation';
import { useMySubjects, useThread } from './data';
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
  const { thread, messages, outcomes, events, subject } = useThread(wid, tid, uid);
  const agents = useLiveCollection(`workspaces/${wid}/agents`, agentSchema);
  const all = useNeedsAll();
  const wide = useWide();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const { busy: calendarBusy } = useMyCalendar(all.orgs, now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [makeOpen, setMakeOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);

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
    else void navigate({ to: from === 'calendar' ? '/calendar' : '/' });
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
  const allOutcomes = (outcomes.state === 'ready' ? outcomes.data : []).sort(
    (a, b) => a.data.createdAt.toMillis() - b.data.createdAt.toMillis(),
  );
  const proposed = allOutcomes.filter((o) => o.data.state === 'proposed');
  const decided = allOutcomes.filter((o) => o.data.state !== 'proposed');
  const subjectName = subject.state === 'ready' ? (subject.data?.name ?? '') : '';
  const closed = t.state === 'done' || t.state === 'ignored';
  const urgent = t.urgent === true;
  const msgs = messages.state === 'ready' ? messages.data.map((m) => m.data) : [];
  const people = [...new Set(msgs.filter((m) => m.direction === 'in').map((m) => m.sender.name))];
  const channels = [...new Set(msgs.map((m) => m.source))];
  const notes = (events.state === 'ready' ? events.data : [])
    .filter((e) => e.data.type === 'thread.note')
    .sort((a, b) => a.data.at.toMillis() - b.data.at.toMillis())
    .map((e) => ({ id: e.id, event: e.data }));
  const org = all.orgs.find((o) => o.wid === wid);
  const due = t.due ? t.due.toMillis() : null;

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

  const panel = (
    <AgentPanel
      wid={wid}
      uid={uid}
      thread={{ id: tid, data: t }}
      proposals={proposed}
      decided={decided}
      notes={notes}
      messages={msgs}
      now={now}
      busy={calendarBusy}
      agentName={agentName}
      onDone={() => (from ? goNext() : undefined)}
      sheet={!wide}
    />
  );

  return (
    <div className="mx-auto w-full">
      {from && briefing ? (
        <BriefingBar from={from} list={briefing.list} index={briefing.index} />
      ) : t.subjectId ? (
        <BackLink subject={{ wid, sid: t.subjectId }}>{subjectName || 'Subject'}</BackLink>
      ) : (
        <BackLink>Inbox</BackLink>
      )}
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_25rem] lg:items-start lg:gap-6">
        <div className="min-w-0 max-lg:pb-[45dvh]">
          <header>
            <div className="flex items-start gap-2">
              <h1 className="min-w-0 flex-1 text-24 font-semibold leading-tight text-ink [overflow-wrap:anywhere]">
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
              <StateChip state={t.state} waiting={t.waiting} />
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
          <Conversation entries={entries} now={now} />
        </div>
        {wide ? <div className="lg:sticky lg:top-4">{panel}</div> : panel}
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
