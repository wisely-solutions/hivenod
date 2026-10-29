/**
 * One subject (item 4PEHrOW5IfXBQWgOK9wo, part 3; laid out like the thread page in item
 * kt3E7u9EliL3q2veDDI0, design 2.5): its threads on the left, open first, as cards with their
 * state and latest message, the timeline in a disclosure; related subjects and the label on the
 * right. Rename, area, merge and split sit in the ⋯ menu.
 */
import {
  mergeSubjects,
  renameSubject,
  setSubjectArea,
  splitSubject,
  type ActionPlan,
} from '@hive/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronRight,
  Combine,
  MoreHorizontal,
  Pencil,
  Split,
  Tag,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { useThreadMessages } from '../today/data';
import { SenderAvatar } from '../today/parts';
import { Button, IconButton } from '../ui/button';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { Skeleton } from '../ui/feedback';
import { Input, Select } from '../ui/form';
import { Dialog, useToast } from '../ui/overlay';
import { useMySubjects, useSubject } from './data';
import { eventText, forMember, sortThreads, timeline } from './logic';
import { BackLink, errorText, Section, StateChip, UrgentMark, when } from './parts';
import { LabelChip } from './labels';
import { RelatedSubjects } from './RelatedSubjects';

export function SubjectPage() {
  const { wid, sid } = useParams({ from: '/inbox/$wid/s/$sid' });
  const { session, actionContext, run } = useReady();
  const uid = session.me.uid;
  const { subject, threads, events } = useSubject(wid, sid, uid);
  const toast = useToast();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [editingArea, setEditingArea] = useState(false);
  const [area, setArea] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);

  const rows = useMemo(
    () =>
      sortThreads(
        (threads.state === 'ready' ? threads.data : []).map((t) => ({
          wid,
          id: t.id,
          data: t.data,
        })),
      ),
    [threads, wid],
  );
  const mine = useMySubjects(wid, uid);
  const knownAreas = useMemo(
    () =>
      [
        ...new Set(
          (mine.state === 'ready' ? mine.data : [])
            .map((x) => x.data.area?.trim() ?? '')
            .filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [mine],
  );
  const refs = useMemo(() => rows.map((r) => ({ wid, id: r.id })), [rows, wid]);
  const latest = useThreadMessages(uid, refs);
  const entries = useMemo(
    () => timeline([], events.state === 'ready' ? events.data : []).reverse(),
    [events],
  );

  if (subject.state === 'loading')
    return (
      <div className="mx-auto w-full max-w-3xl" aria-hidden>
        <Skeleton className="mb-4 h-10 w-2/3" />
        <Skeleton className="h-40" />
      </div>
    );
  if (subject.state === 'error' || !subject.data || subject.data.memberUid !== uid)
    return (
      <div className="mx-auto w-full max-w-3xl">
        <BackLink>Inbox</BackLink>
        <p role="alert" className="text-14 text-text-2">
          This subject is not in your Inbox. It may have been merged into another one.
        </p>
      </div>
    );
  const s = subject.data;
  const waiting = rows.filter((r) => forMember(r.data.state)).length;

  async function act(make: () => Pick<ActionPlan, 'ops'>, done: string, after?: () => void) {
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
      toast.push({ message: done });
      after?.();
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
      id: 'rename',
      label: 'Rename',
      icon: Pencil,
      onSelect: () => {
        setName(s.name);
        setRenaming(true);
      },
    },
    {
      id: 'area',
      label: s.area ? `Area: ${s.area}` : 'Set area',
      icon: Tag,
      onSelect: () => {
        setArea(s.area ?? '');
        setEditingArea(true);
      },
    },
    { id: 'merge', label: 'Merge…', icon: Combine, onSelect: () => setMergeOpen(true) },
    {
      id: 'split',
      label: 'Split…',
      icon: Split,
      disabled: rows.length === 0,
      onSelect: () => setSplitOpen(true),
    },
  ];

  return (
    <div className="mx-auto w-full">
      <BackLink>Inbox</BackLink>
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
        <div className="min-w-0">
          {renaming ? (
            <form
              className="mb-2 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  () => renameSubject(ctx(), { subjectId: sid, subject: s, name }),
                  'Renamed.',
                  () => setRenaming(false),
                );
              }}
            >
              <div className="min-w-0 flex-1 basis-60">
                <Input
                  label="Subject name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <Button type="submit" variant="primary" loading={busy}>
                Save
              </Button>
              <Button variant="secondary" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="mb-1 flex items-start gap-2">
              <h1 className="min-w-0 flex-1 text-24 font-semibold text-ink [overflow-wrap:anywhere]">
                {s.name}
              </h1>
              <ActionMenu
                label="Subject actions"
                actions={menu}
                trigger={
                  <IconButton label="Subject actions">
                    <Icon icon={MoreHorizontal} size={18} />
                  </IconButton>
                }
              />
            </div>
          )}
          <p className="text-14 text-text-2">
            {waiting > 0 ? `${waiting} waiting for you · ` : ''}
            {rows.length} thread{rows.length === 1 ? '' : 's'}
          </p>
          {editingArea ? (
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  () => setSubjectArea(ctx(), { subjectId: sid, subject: s, area }),
                  area.trim() ? 'Area saved.' : 'Area cleared.',
                  () => setEditingArea(false),
                );
              }}
            >
              <div className="min-w-0 flex-1 basis-60">
                <Input
                  label="Area or tag"
                  list="inbox-areas"
                  placeholder="A client, a product, admin (empty: none)"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                />
                <datalist id="inbox-areas">
                  {knownAreas.map((a) => (
                    <option key={a} value={a} />
                  ))}
                </datalist>
              </div>
              <Button type="submit" variant="primary" loading={busy}>
                Save area
              </Button>
              <Button variant="secondary" onClick={() => setEditingArea(false)}>
                Cancel
              </Button>
            </form>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-14 text-sendback">
              {error}
            </p>
          ) : null}

          <Section title="Threads">
            {rows.length === 0 ? (
              <p className="text-14 text-text-2">No threads in this subject.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {rows.map((t) => {
                  const ms = latest.get(`${wid}/${t.id}`) ?? [];
                  const last = ms[ms.length - 1];
                  return (
                    <li key={t.id}>
                      <Link
                        to="/inbox/$wid/t/$tid"
                        params={{ wid, tid: t.id }}
                        data-thread={t.id}
                        className="flex gap-3 rounded-card border border-line bg-surface p-3.5 transition-colors duration-120 hov:bg-canvas foc:outline-2 foc:outline-offset-2 foc:outline-focus"
                      >
                        <SenderAvatar name={last?.sender.name ?? t.data.title} size="sm" />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex items-start gap-2">
                            <span className="min-w-0 flex-1 truncate text-14 font-semibold text-ink">
                              {t.data.title || 'Untitled thread'}
                            </span>
                            <UrgentMark on={t.data.urgent} />
                            <StateChip state={t.data.state} waiting={t.data.waiting} />
                          </span>
                          {last ? (
                            <span className="line-clamp-2 text-13 text-text-2">
                              {last.direction === 'out' ? 'You' : last.sender.name}: {last.text}
                            </span>
                          ) : null}
                          <span className="text-12 text-text-3">
                            {when(t.data.lastMessageAt.toMillis())}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <div className="mt-6 border-t border-line pt-3">
            <button
              type="button"
              aria-expanded={timelineOpen}
              onClick={() => setTimelineOpen((v) => !v)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-btn text-14 font-medium text-text-2 hov:text-ink foc:outline-2 foc:outline-focus"
            >
              <Icon icon={timelineOpen ? ChevronDown : ChevronRight} size={16} />
              Timeline <span className="text-text-3">({entries.length})</span>
            </button>
            {timelineOpen ? (
              entries.length === 0 ? (
                <p className="text-14 text-text-2">Nothing yet.</p>
              ) : (
                <ol className="mt-2 flex flex-col gap-2" aria-label="Timeline">
                  {entries.map((e) =>
                    e.kind === 'event' ? (
                      <li
                        key={e.id}
                        data-event={e.event.type}
                        className="flex gap-3 text-14 text-text-2"
                      >
                        <span className="shrink-0 tabular-nums">{when(e.at)}</span>
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {eventText(e.event)}
                          {e.event.threadId ? (
                            <>
                              {' · '}
                              <Link
                                to="/inbox/$wid/t/$tid"
                                params={{ wid, tid: e.event.threadId }}
                                className="text-agent underline"
                              >
                                {rows.find((r) => r.id === e.event.threadId)?.data.title ||
                                  'thread'}
                              </Link>
                            </>
                          ) : null}
                        </span>
                      </li>
                    ) : null,
                  )}
                </ol>
              )
            ) : null}
          </div>
        </div>

        <aside
          aria-label="About this subject"
          className="mt-6 flex flex-col gap-4 lg:sticky lg:top-4 lg:mt-0"
        >
          <section className="rounded-panel border border-line bg-surface p-4 shadow-e1">
            <h2 className="mb-2 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
              Label and area
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <LabelChip wid={wid} subjectId={sid} subject={s} withAdd />
              {s.area ? (
                <span className="inline-flex h-6 items-center rounded-full bg-canvas px-2.5 text-12 font-medium text-text-2">
                  {s.area}
                </span>
              ) : null}
            </div>
          </section>
          <div className="rounded-panel border border-line bg-surface px-4 pb-4 shadow-e1 [&>section]:mt-4">
            <RelatedSubjects wid={wid} sid={sid} uid={uid} />
          </div>
        </aside>
      </div>

      <MergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        wid={wid}
        uid={uid}
        sid={sid}
        busy={busy}
        onMerge={(intoId, intoName) =>
          void act(
            () =>
              mergeSubjects(ctx(), {
                fromId: sid,
                from: s,
                intoId,
                into: { memberUid: uid, name: intoName },
                threadIds: rows.map((r) => r.id),
              }),
            `Merged into “${intoName}”.`,
            () => {
              setMergeOpen(false);
              void navigate({ to: '/inbox/$wid/s/$sid', params: { wid, sid: intoId } });
            },
          )
        }
      />
      <SplitDialog
        open={splitOpen}
        onOpenChange={setSplitOpen}
        threads={rows.map((r) => ({ id: r.id, title: r.data.title }))}
        busy={busy}
        onSplit={(newName, ids) => {
          let made = '';
          void act(
            () => {
              const p = splitSubject(ctx(), {
                fromId: sid,
                from: s,
                name: newName,
                threadIds: ids,
              });
              made = p.subjectId;
              return p;
            },
            `Split off into “${newName}”.`,
            () => {
              setSplitOpen(false);
              if (made) void navigate({ to: '/inbox/$wid/s/$sid', params: { wid, sid: made } });
            },
          );
        }}
      />
    </div>
  );
}

function MergeDialog({
  open,
  onOpenChange,
  wid,
  uid,
  sid,
  busy,
  onMerge,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  wid: string;
  uid: string;
  sid: string;
  busy: boolean;
  onMerge: (intoId: string, intoName: string) => void;
}) {
  const subjects = useMySubjects(wid, uid);
  const options =
    subjects.state === 'ready'
      ? subjects.data
          .filter((x) => x.id !== sid)
          .sort((a, b) => a.data.name.localeCompare(b.data.name))
      : [];
  const [to, setTo] = useState('');
  const target = options.find((o) => o.id === to) ?? options[0];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Merge into another subject"
      description="Every thread of this subject moves to the one you pick, and this subject goes away."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!target}
            onClick={() => target && onMerge(target.id, target.data.name)}
          >
            Merge
          </Button>
        </>
      }
    >
      {options.length === 0 ? (
        <p className="text-14 text-text-2">You have no other subject in this organization.</p>
      ) : (
        <Select
          label="Merge into"
          value={target?.id ?? ''}
          onValueChange={setTo}
          options={options.map((o) => ({ value: o.id, label: o.data.name }))}
        />
      )}
    </Dialog>
  );
}

function SplitDialog({
  open,
  onOpenChange,
  threads,
  busy,
  onSplit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  threads: { id: string; title: string }[];
  busy: boolean;
  onSplit: (name: string, ids: string[]) => void;
}) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Split into a new subject"
      description="The threads you pick move to a new subject with its own name."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!name.trim() || picked.size === 0}
            onClick={() => onSplit(name, [...picked])}
          >
            Split
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input label="New subject name" value={name} onChange={(e) => setName(e.target.value)} />
        <fieldset>
          <legend className="mb-1 text-13 font-medium text-ink">Threads that move</legend>
          <ul className="flex flex-col">
            {threads.map((t) => (
              <li key={t.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-14 text-ink">
                  <input
                    type="checkbox"
                    className="size-5 accent-[var(--color-agent)]"
                    checked={picked.has(t.id)}
                    onChange={() => toggle(t.id)}
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {t.title || 'Untitled thread'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      </div>
    </Dialog>
  );
}
