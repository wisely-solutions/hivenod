/**
 * One Inbox thread (item 4PEHrOW5IfXBQWgOK9wo, part 3): the agent's question with an answer box,
 * the proposed outcomes (Approve, Edit, Reject), the messages with sender, source and the
 * original text, the investigation notes, and the member's own actions: move to another
 * subject, Make it work, Ignore, Mark done, Bring back.
 */
import {
  agentSchema,
  answerQuestion,
  closeThread,
  createItem,
  flagThread,
  ignoreThread,
  makeItemFromThread,
  moveThread,
  projectSchema,
  restoreThread,
  shapesNewItems,
  type ActionPlan,
  type InboxMessage,
} from '@hive/shared';
import { useNavigate, useParams } from '@tanstack/react-router';
import { collection, query, where } from 'firebase/firestore';
import { Paperclip } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveCollection, useLiveQuery } from '../lib/live';
import { Pill } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Skeleton } from '../ui/feedback';
import { Input, Select, Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import { Dialog, useToast } from '../ui/overlay';
import { useMySubjects, useThread } from './data';
import { eventText, timeline } from './logic';
import { OutcomeCard } from './OutcomeCard';
import { BackLink, errorText, Section, SourceTag, StateChip, when } from './parts';

const myProjectsIn = (wid: string, uid: string) =>
  query(collection(db, `workspaces/${wid}/projects`), where('memberUids', 'array-contains', uid));

export function ThreadPage() {
  const { wid, tid } = useParams({ from: '/inbox/$wid/t/$tid' });
  const { session, actionContext, run } = useReady();
  const uid = session.me.uid;
  const { thread, messages, outcomes, events, subject } = useThread(wid, tid, uid);
  const agents = useLiveCollection(`workspaces/${wid}/agents`, agentSchema);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [makeOpen, setMakeOpen] = useState(false);

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

  async function act(make: () => Pick<ActionPlan, 'ops'>, done?: string) {
    setError(null);
    let plan;
    try {
      plan = make();
    } catch (e) {
      setError(errorText(e));
      return;
    }
    setBusy(true);
    try {
      await run(plan);
      if (done) toast.push({ message: done });
    } catch (e) {
      setError(errorText(e));
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
      {t.subjectId ? (
        <BackLink subject={{ wid, sid: t.subjectId }}>{subjectName || 'Subject'}</BackLink>
      ) : (
        <BackLink>Inbox</BackLink>
      )}
      <div className="mb-2 flex flex-wrap items-start gap-3">
        <h1 className="min-w-0 flex-1 text-24 font-semibold text-ink [overflow-wrap:anywhere]">
          {t.title || 'Untitled thread'}
        </h1>
        <div className="flex shrink-0 items-center gap-2">
          {urgent ? (
            <Pill tone="sendback">
              <span data-urgent="">Urgent</span>
            </Pill>
          ) : null}
          <StateChip state={t.state} waiting={t.waiting} />
        </div>
      </div>
      <p className="text-14 text-text-2">
        {subjectName ? `${subjectName} · ` : 'Not filed yet · '}
        Brought in by {agentName(t.fetchedBy)} · last message {when(t.lastMessageAt.toMillis())}
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <MoveControl
          wid={wid}
          uid={uid}
          current={t.subjectId}
          busy={busy}
          onMove={(sid) =>
            void act(
              () => moveThread(ctx(), { threadId: tid, thread: t, subjectId: sid }),
              'Moved.',
            )
          }
        />
        <Button variant="secondary" onClick={() => setMakeOpen(true)}>
          Make it work
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          aria-pressed={urgent}
          onClick={() =>
            void act(
              () => flagThread(ctx(), { threadId: tid, thread: t, urgent: !urgent }),
              urgent ? 'Not urgent any more.' : 'Marked urgent.',
            )
          }
        >
          {urgent ? 'Not urgent' : 'Mark urgent'}
        </Button>
        {closed ? (
          <Button
            variant="secondary"
            loading={busy}
            onClick={() =>
              void act(
                () => restoreThread(ctx(), { threadId: tid, thread: t }),
                'Back with the agents.',
              )
            }
          >
            Bring back
          </Button>
        ) : (
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void act(() => closeThread(ctx(), { threadId: tid, thread: t }), 'Marked done.')
              }
            >
              Mark done
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(() => ignoreThread(ctx(), { threadId: tid, thread: t }), 'Ignored.')
              }
            >
              Ignore
            </Button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-14 text-sendback">
          {error}
        </p>
      ) : null}

      {t.state === 'needsYou' && t.question && !t.question.answer ? (
        <Card tone="gate" className="mt-6">
          <h2 className="text-16 font-semibold text-ink">{agentName(t.question.by)} asks you</h2>
          <p className="mt-1 whitespace-pre-wrap text-14 text-ink">{t.question.text}</p>
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () => answerQuestion(ctx(), { threadId: tid, thread: t, answer }),
                'Answered.',
              ).then(() => setAnswer(''));
            }}
          >
            <Textarea
              label="Your answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            <div>
              <Button type="submit" variant="primary" loading={busy} disabled={!answer.trim()}>
                Answer
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {proposed.length > 0 ? (
        <Section title="Proposed">
          <div className="flex flex-col gap-3">
            {proposed.map((o) => (
              <OutcomeCard
                key={o.id}
                wid={wid}
                oid={o.id}
                outcome={o.data}
                thread={t}
                othersPending={proposed.length > 1}
                agentName={agentName}
              />
            ))}
          </div>
        </Section>
      ) : null}

      {decided.length > 0 ? (
        <Section title="Outcomes">
          <div className="flex flex-col gap-3">
            {decided.map((o) => (
              <OutcomeCard
                key={o.id}
                wid={wid}
                oid={o.id}
                outcome={o.data}
                thread={t}
                othersPending={false}
                agentName={agentName}
              />
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Timeline">
        <ol className="flex flex-col gap-3" aria-label="Timeline">
          {entries.map((e) =>
            e.kind === 'message' ? (
              <li key={e.id}>
                <MessageView m={e.message} />
              </li>
            ) : (
              <li
                key={e.id}
                data-event={e.event.type}
                className="flex gap-3 px-1 text-14 text-text-2"
              >
                <span className="shrink-0 tabular-nums">{when(e.at)}</span>
                <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {eventText(e.event)}
                </span>
              </li>
            ),
          )}
        </ol>
      </Section>

      <MakeItWork
        open={makeOpen}
        onOpenChange={setMakeOpen}
        wid={wid}
        tid={tid}
        thread={t}
        subjectName={subjectName}
        firstText={messages.state === 'ready' ? (messages.data[0]?.data.text ?? '') : ''}
      />
    </div>
  );
}

function MessageView({ m }: { m: InboxMessage }) {
  const mine = m.direction === 'out';
  return (
    <article
      data-message=""
      className={
        mine
          ? 'rounded-card border border-line bg-canvas p-4'
          : 'rounded-card border border-line bg-surface p-4 shadow-e1'
      }
    >
      <header className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-14 font-semibold text-ink">{mine ? 'You' : m.sender.name}</span>
        {m.sender.handle && !mine ? (
          <span className="text-13 text-text-2 [overflow-wrap:anywhere]">{m.sender.handle}</span>
        ) : null}
        <SourceTag source={m.source} />
        <span className="ml-auto text-13 text-text-2">{when(m.receivedAt.toMillis())}</span>
      </header>
      <p className="whitespace-pre-wrap text-14 text-ink [overflow-wrap:anywhere]">{m.text}</p>
      {m.attachments.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2">
          {m.attachments.map((a) => (
            <li key={a.url}>
              <a
                href={a.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-9 items-center gap-1 rounded-btn border border-line px-2 text-13 text-ink hover:bg-canvas"
              >
                <Icon icon={Paperclip} size={14} />
                {a.name}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {m.permalink ? (
        <a
          href={m.permalink}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex min-h-11 items-center text-14 font-medium text-agent hover:underline"
        >
          Open the original
        </a>
      ) : null}
    </article>
  );
}

function MoveControl({
  wid,
  uid,
  current,
  busy,
  onMove,
}: {
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
  if (options.length === 0) return null;
  return (
    <div className="flex items-end gap-2">
      <Select
        label="Move to subject"
        hideLabel
        inline
        value={to}
        onValueChange={setTo}
        options={[{ value: '', label: 'Move to subject…' }, ...options]}
      />
      <Button variant="secondary" disabled={!to || busy} onClick={() => to && onMove(to)}>
        Move
      </Button>
    </div>
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
