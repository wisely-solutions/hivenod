/**
 * One subject (item 4PEHrOW5IfXBQWgOK9wo, part 3): its threads, open and closed, its timeline,
 * and the member's reorganizing: rename, merge into another subject, split threads off.
 */
import {
  mergeSubjects,
  renameSubject,
  setSubjectArea,
  splitSubject,
  type ActionPlan,
} from '@hive/shared';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { Button } from '../ui/button';
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

  return (
    <div className="mx-auto w-full max-w-3xl">
      <BackLink>Inbox</BackLink>
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
            <Input label="Subject name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Button type="submit" variant="primary" loading={busy}>
            Save
          </Button>
          <Button variant="secondary" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <h1 className="mb-1 text-24 font-semibold text-ink [overflow-wrap:anywhere]">{s.name}</h1>
      )}
      <p className="text-14 text-text-2">
        {waiting > 0 ? `${waiting} waiting for you · ` : ''}
        {rows.length} thread{rows.length === 1 ? '' : 's'}
      </p>
      <div className="mt-2">
        <LabelChip wid={wid} subjectId={sid} subject={s} withAdd />
      </div>
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
      <div className="mt-4 flex flex-wrap gap-2">
        {!renaming ? (
          <Button
            variant="secondary"
            onClick={() => {
              setName(s.name);
              setRenaming(true);
            }}
          >
            Rename
          </Button>
        ) : null}
        {!editingArea ? (
          <Button
            variant="secondary"
            onClick={() => {
              setArea(s.area ?? '');
              setEditingArea(true);
            }}
          >
            {s.area ? `Area: ${s.area}` : 'Set area'}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => setMergeOpen(true)}>
          Merge…
        </Button>
        <Button variant="secondary" disabled={rows.length === 0} onClick={() => setSplitOpen(true)}>
          Split…
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-14 text-sendback">
          {error}
        </p>
      ) : null}

      <Section title="Threads">
        {rows.length === 0 ? (
          <p className="text-14 text-text-2">No threads in this subject.</p>
        ) : (
          <ul className="overflow-hidden rounded-card border border-line bg-surface">
            {rows.map((t) => (
              <li key={t.id} className="border-b border-line last:border-b-0">
                <Link
                  to="/inbox/$wid/t/$tid"
                  params={{ wid, tid: t.id }}
                  data-thread={t.id}
                  className="flex min-h-11 items-center gap-3 px-4 py-2 transition-colors hover:bg-canvas foc:outline-2 foc:-outline-offset-2 foc:outline-focus"
                >
                  <span className="min-w-0 flex-1 truncate text-14 text-ink">
                    {t.data.title || 'Untitled thread'}
                  </span>
                  <span className="hidden text-13 text-text-2 sm:inline">
                    {when(t.data.lastMessageAt.toMillis())}
                  </span>
                  <UrgentMark on={t.data.urgent} />
                  <StateChip state={t.data.state} waiting={t.data.waiting} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <RelatedSubjects wid={wid} sid={sid} uid={uid} />

      <Section title="Timeline">
        {entries.length === 0 ? (
          <p className="text-14 text-text-2">Nothing yet.</p>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Timeline">
            {entries.map((e) =>
              e.kind === 'event' ? (
                <li key={e.id} data-event={e.event.type} className="flex gap-3 text-14 text-text-2">
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
                          {rows.find((r) => r.id === e.event.threadId)?.data.title || 'thread'}
                        </Link>
                      </>
                    ) : null}
                  </span>
                </li>
              ) : null,
            )}
          </ol>
        )}
      </Section>

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
