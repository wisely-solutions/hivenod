import {
  attachmentSchema,
  eventSchema,
  clearHold,
  decisionSchema,
  isOnHold,
  isWorkStoppable,
  resumeWork,
  stopGateFor,
  parkOf,
  formatTokens,
  logLineSchema,
  newTokens,
  messageSchema,
  postMessage,
  runSchema,
  type Agent,
  type Item,
  type Project,
} from '@hive/shared';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { Link } from '@tanstack/react-router';
import { FileText, Maximize2, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { colorIndex } from '../agents/logic';
import { DecidePanel } from '../components/DecidePanel';
import { FocusView, Properties } from '../components/FocusView';
import { DonePanel } from '../components/DonePanel';
import { StopWorkDialog } from '../components/StopWorkDialog';
import { db } from '../lib/db';
import { useLiveCollection, useLiveQuery, type Row } from '../lib/live';
import { displayName, useProfiles } from '../members/data';
import { timeAgo } from '../projects/logic';
import { formatEur } from '../shell/logic';
import { AgentAvatar } from '../ui/avatar';
import { Badge, Eyebrow, Pill } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Skeleton, WorkingDots } from '../ui/feedback';
import { Textarea, Tabs } from '../ui/form';
import { Icon } from '../ui/icon';
import { FoundWhileWorking } from '../review/ReviewPanel';
import { useShellData } from '../shell/data';
import { ItemTimeline } from '../activity/ItemTimeline';
import { AttachmentPreview } from './AttachmentPreview';
import { ItemActions } from './itemActions';
import { AddFiles, EditableSummary, EditableTitle, TypePicker } from './ItemEdit';
import { canEditItem, isItemLive, isNewAttachment, sinceText } from './logic';
import { stepOfText } from './path';
import { LiveRun } from './LiveRun';
import { PathPanel } from './PathPanel';
import { decisionText } from './sendback';

const ts = (t: { toMillis: () => number }) => t.toMillis();

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </section>
  );
}

function RunLog({ wid, runId }: { wid: string; runId: string }) {
  const live = useLiveCollection(`workspaces/${wid}/runs/${runId}/log`, logLineSchema);
  if (live.state !== 'ready') return <p className="text-13 text-text-2">Loading log…</p>;
  const lines = [...live.data].sort((a, b) => ts(a.data.at) - ts(b.data.at));
  if (!lines.length) return <p className="text-13 text-text-2">No log lines.</p>;
  return (
    // The pre itself never wraps and scrolls sideways. The extra-arguments line holds copyable
    // flags and stays on one line; the other lines wrap inside their own block.
    <pre
      aria-label="Run log"
      className="max-h-48 overflow-auto whitespace-pre rounded-btn bg-canvas p-2.5 font-mono text-12"
    >
      {lines.map((l) => (
        <div
          key={l.id}
          className={
            l.data.text.startsWith('Extra Claude arguments:')
              ? 'whitespace-pre'
              : 'whitespace-pre-wrap break-words'
          }
        >
          {`${l.data.level === 'info' ? '' : `[${l.data.level}] `}${l.data.text}`}
        </div>
      ))}
    </pre>
  );
}

/** The item, in full: where it is, what the agents made, what was said and decided. */
export function ItemDetail({
  pid,
  itemId,
  project,
  item,
  agents,
  onClose,
  position,
  onStep,
  onDecided,
  backText,
}: {
  pid: string;
  itemId: string;
  project: Project;
  item: Item;
  agents: Row<Agent>[];
  onClose: () => void;
  /** Where this item sits among the ones waiting for the person (J / K step through them). */
  position?: { index: number; total: number };
  onStep?: (dir: 1 | -1) => void;
  /** The person's approval was written: open the next waiting item. */
  onDecided?: () => void;
  /** "Board" or "List": where Esc goes back to. */
  backText: string;
}) {
  const { session, actionContext, run } = useReady();
  const wid = session.workspaceId;
  const { suggestions: allSuggestions } = useShellData();
  const base = `workspaces/${wid}/projects/${pid}/items/${itemId}`;
  const attachments = useLiveCollection(`${base}/attachments`, attachmentSchema);
  const messages = useLiveCollection(`${base}/messages`, messageSchema);
  const decisions = useLiveQuery(
    `decisions:${wid}:${pid}:${itemId}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/projects/${pid}/decisions`),
        where('itemId', '==', itemId),
      ),
    decisionSchema,
  );
  // Restore writes an event, not a decision: the Decisions list adds those so the stop and the
  // restore read together (card rLntxm7C). Same query as the History tab, one listener.
  const events = useLiveQuery(
    `timeline:${wid}:${pid}:${itemId}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/events`),
        where('projectId', '==', pid),
        where('itemId', '==', itemId),
        orderBy('at', 'desc'),
        limit(200),
      ),
    eventSchema,
  );
  const runs = useLiveQuery(
    `runs-of:${wid}:${pid}:${itemId}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/runs`),
        where('projectId', '==', pid),
        where('itemId', '==', itemId),
      ),
    runSchema,
  );
  const people = useMemo(() => {
    const ids = new Set<string>();
    if (decisions.state === 'ready') decisions.data.forEach((d) => ids.add(d.data.byUid));
    if (messages.state === 'ready')
      messages.data.forEach((m) => m.data.by.type === 'human' && ids.add(m.data.by.id));
    if (item.createdBy.type === 'human') ids.add(item.createdBy.id);
    if (item.workStopped) ids.add(item.workStopped.byUid);
    const gate = project.steps.find((x) => x.id === item.stepId)?.gate;
    gate?.deciderUids.forEach((u) => ids.add(u));
    return [...ids];
  }, [decisions, messages, item.createdBy, item.workStopped, item.stepId, project.steps]);
  const profiles = useProfiles(wid, people);
  const who = (a: { type: string; id: string }) =>
    a.type === 'agent'
      ? (agents.find((x) => x.id === a.id)?.data.name ?? 'Removed agent')
      : displayName(profiles[a.id], a.id);

  const [view, setView] = useState<'details' | 'timeline'>('details');
  const [tab, setTab] = useState('');
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [now] = useState(() => Date.now());

  // The panels below read these four lists. Until they have all answered, one skeleton stands in,
  // so "Nothing attached yet" or a missing preview never appears and then shoves the page around.
  const loaded = [attachments, messages, decisions, runs].every((l) => l.state !== 'loading');
  const files = attachments.state === 'ready' ? attachments.data : [];
  const sortedFiles = [...files].sort((a, b) => ts(a.data.at) - ts(b.data.at));
  const activeFile = sortedFiles.find((f) => f.id === tab) ?? sortedFiles[0];
  const thread =
    messages.state === 'ready'
      ? [...messages.data].sort((a, b) => ts(a.data.at) - ts(b.data.at))
      : [];
  const history =
    decisions.state === 'ready'
      ? [...decisions.data].sort((a, b) => ts(b.data.at) - ts(a.data.at))
      : [];
  const restores =
    events.state === 'ready'
      ? events.data
          .filter((e) => e.data.type === 'item.restored')
          .map((e) => ({
            id: e.id,
            by: e.data.actor.name || 'Someone',
            stepId: typeof e.data.data.stepId === 'string' ? e.data.data.stepId : '',
            at: ts(e.data.at),
          }))
      : [];
  const runList =
    runs.state === 'ready'
      ? [...runs.data].sort((a, b) => ts(b.data.startedAt) - ts(a.data.startedAt))
      : [];
  const agent = item.claim ? agents.find((a) => a.id === item.claim?.agentUid) : undefined;
  const live = isItemLive(item, now);
  const parked = parkOf(item);
  // The burst plays only when the item turns Done while this view is open, never on a plain open.
  const [seenStatus, setSeenStatus] = useState(item.status);
  const [burst, setBurst] = useState(false);
  if (seenStatus !== item.status) {
    setSeenStatus(item.status);
    setBurst(item.status === 'done' && seenStatus !== 'done');
  }
  // Who asked the question the item waits for. Older holds carry reason 'tokenLimit' (a guardrail
  // that no longer exists): they read as ordinary open questions.
  const hold = item.awaitingAnswer;
  const holdQuestion = hold ? thread.find((m) => m.id === hold.questionId) : undefined;
  const heldBy = holdQuestion ? 'agent' : 'unknown';

  // Stop work (card BrK0r2FE): admins and the deciders of any gate of the project.
  const stopGate = stopGateFor(project, session.me.uid, session.isAdmin);
  const canStop = stopGate !== null;
  const stoppable = isWorkStoppable(project, item);
  const [stopOpen, setStopOpen] = useState(false);
  const claimedRun = item.claim ? runList.find((r) => r.id === item.claim?.runId) : undefined;
  const canEdit = canEditItem(item, session.me.uid, session.isAdmin);
  const stop = item.workStopped;
  const showLive = live && !stop;
  const stoppedBy = stop ? who({ type: 'human', id: stop.byUid }) : '';
  const [resuming, setResuming] = useState(false);
  async function resume() {
    const ctx = actionContext(wid);
    if (!ctx) return;
    setResuming(true);
    try {
      await run(resumeWork(ctx, { projectId: pid, itemId, item, gateStepId: stopGate }));
    } finally {
      setResuming(false);
    }
  }

  const [unholding, setUnholding] = useState(false);
  async function unhold() {
    const ctx = actionContext(wid);
    if (!ctx) return;
    setUnholding(true);
    try {
      await run(clearHold(ctx, { projectId: pid, itemId, item }));
    } finally {
      setUnholding(false);
    }
  }

  async function addNote() {
    const ctx = actionContext(wid);
    if (!ctx || !text.trim()) return;
    setSending(true);
    try {
      await run(postMessage(ctx, { projectId: pid, itemId, kind: 'note', text: text.trim() }));
      setText('');
    } finally {
      setSending(false);
    }
  }

  const stepNow = project.steps.find((x) => x.id === item.stepId);
  const deciders = stepNow?.gate?.deciderUids ?? [];
  const cost = runList.reduce((sum, r) => sum + r.data.costEur, 0);

  return (
    <FocusView
      label="Item detail"
      inner={`Item: ${item.title}`}
      role="region"
      backLabel="Close item"
      backText={backText}
      onBack={onClose}
      crumb={
        <>
          <strong>
            {project.emoji} {project.name}
          </strong>
          {stepNow ? ` \u203a ${stepNow.name}` : ''}
        </>
      }
      position={position ? { ...position, noun: 'waiting' } : undefined}
      onStep={onStep}
      properties={
        <Properties
          rows={[
            {
              label: 'Step',
              value: stepNow ? `${stepNow.name} \u00b7 ${stepOfText(project, item)}` : '\u2014',
            },
            ...(stepNow?.kind === 'human'
              ? [
                  {
                    label: 'Decides',
                    value: deciders.length
                      ? deciders.map((u) => displayName(profiles[u], u)).join(', ')
                      : '\u2014',
                  },
                ]
              : []),
            { label: 'Agent', value: agent?.data.name ?? '\u2014' },
            // Item DhsO9: who made it; an agent's create_item says so.
            {
              label: 'Created by',
              value: (
                <span data-testid="created-by">
                  {who(item.createdBy)}
                  {item.createdBy.type === 'agent' ? ' \u00b7 agent' : ''}
                </span>
              ),
            },
            {
              label: 'Type',
              value:
                canEdit && item.type !== 'finding' ? (
                  <TypePicker pid={pid} itemId={itemId} item={item} />
                ) : (
                  item.type
                ),
            },
            { label: 'Cost', value: formatEur(cost) },
          ]}
        >
          <ItemActions pid={pid} itemId={itemId} item={item} onGone={onClose} />
        </Properties>
      }
      bar={
        <DecidePanel
          project={project}
          projectId={pid}
          itemId={itemId}
          item={item}
          onDecided={onDecided}
        />
      }
    >
      <div className="flex min-w-0 flex-col gap-5">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              {item.sendBackCount ? <Badge tone="sendback">↩ {item.sendBackCount}</Badge> : null}
              {item.status === 'stopped' ? <Pill tone="sendback">Stopped</Pill> : null}
              {item.status === 'suggested' ? <Pill tone="neutral">Suggestion</Pill> : null}
              {parked ? (
                <Pill tone="agent" className="max-w-full min-w-0">
                  <span className="truncate" title={`Waiting: ${parked.reason}`}>
                    Waiting: {parked.reason}
                  </span>
                  <span className="shrink-0 whitespace-nowrap">
                    · since {sinceText(parked.at.toMillis(), now)}
                  </span>
                </Pill>
              ) : null}
            </div>
            <EditableTitle pid={pid} itemId={itemId} item={item} canEdit={canEdit} />
            {agent && !showLive ? (
              <p className="mt-2 inline-flex items-center gap-2 text-13 text-text-2">
                <AgentAvatar
                  name={agent.data.name}
                  color={colorIndex(agent.data.color, agent.id)}
                  live={live}
                  size="sm"
                />
                {agent.data.name}
                {live ? (
                  <>
                    <WorkingDots /> <span>working now</span>
                  </>
                ) : null}
              </p>
            ) : null}
            {stoppable && canStop && !showLive ? (
              <div className="mt-2">
                <Button
                  variant="sendback"
                  leading={<Icon icon={Square} size={14} />}
                  onClick={() => setStopOpen(true)}
                >
                  Stop work
                </Button>
              </div>
            ) : null}
          </div>
        </header>

        <PathPanel
          pid={pid}
          itemId={itemId}
          project={project}
          item={item}
          agents={agents}
          decisions={decisions.state === 'ready' ? decisions.data : []}
        />

        {showLive ? (
          <LiveRun
            wid={wid}
            item={item}
            agent={agent}
            run={claimedRun}
            files={sortedFiles
              .filter((f) => f.data.runId && f.data.runId === item.claim?.runId)
              .map((f) => ({ id: f.id, name: f.data.name, at: ts(f.data.at) }))}
            onStop={stoppable && canStop ? () => setStopOpen(true) : null}
            onOpenFile={(id) => {
              setView('details');
              setTab(id);
            }}
          />
        ) : null}

        {stop && isOnHold(item) ? (
          <div
            role="status"
            data-testid="onhold-banner"
            className="flex flex-wrap items-center gap-3 rounded-card border border-gate/50 bg-gate-bg p-3.5"
          >
            <div className="min-w-0 flex-1 text-14 text-gate-text">
              <p>
                <span className="font-semibold">On hold: stopped by {stoppedBy}.</span> No agent
                takes this item until someone presses Resume.
              </p>
              {stop.reason ? <p className="mt-1 text-ink">“{stop.reason}”</p> : null}
            </div>
            {canStop ? (
              <Button variant="secondary" loading={resuming} onClick={resume}>
                Resume
              </Button>
            ) : null}
          </div>
        ) : null}
        {stop?.mode === 'cancel' && item.status === 'stopped' ? (
          <div
            role="status"
            data-testid="cancelled-banner"
            className="rounded-card border border-sendback-border bg-sendback-bg p-3.5 text-14 text-sendback"
          >
            <p>
              <span className="font-semibold">Cancelled: work stopped by {stoppedBy}.</span>
            </p>
            {stop.reason ? <p className="mt-1 text-ink">“{stop.reason}”</p> : null}
          </div>
        ) : null}

        {stoppable && canStop ? (
          <StopWorkDialog
            open={stopOpen}
            onOpenChange={setStopOpen}
            project={project}
            projectId={pid}
            itemId={itemId}
            item={item}
            agentName={agent?.data.name ?? 'Removed agent'}
            run={
              claimedRun
                ? { costEur: claimedRun.data.costEur, endedAt: claimedRun.data.endedAt }
                : null
            }
          />
        ) : null}

        {item.awaitingAnswer ? (
          <div
            role="status"
            data-testid="held-banner"
            className="flex flex-wrap items-center gap-3 rounded-card border border-gate/50 bg-gate-bg p-3.5"
          >
            <p className="min-w-0 flex-1 text-14 text-gate-text">
              <span className="font-semibold">Waiting for an answer.</span>{' '}
              {heldBy === 'agent'
                ? 'The agent asked a question and gave the item back'
                : 'A question is open'}{' '}
              (see Messages). No agent takes this item until someone answers it.
            </p>
            {session.isAdmin ? (
              <Button variant="secondary" loading={unholding} onClick={unhold}>
                Let agents take it
              </Button>
            ) : null}
          </div>
        ) : null}

        {item.status === 'done' ? (
          loaded ? (
            <DonePanel pid={pid} item={item} itemId={itemId} runs={runList} burst={burst} />
          ) : (
            <Skeleton className="h-[5.5rem]" />
          )
        ) : null}
        {!loaded ? (
          <Skeleton className="h-96" />
        ) : (
          <Tabs
            label="Item views"
            value={view}
            onValueChange={(v) => setView(v as 'details' | 'timeline')}
            tabs={[
              {
                value: 'details',
                label: 'Details',
                content: (
                  <div className="flex flex-col gap-5">
                    <Section title="Description">
                      <EditableSummary pid={pid} itemId={itemId} item={item} canEdit={canEdit} />
                    </Section>

                    <Section title="Attachments">
                      <AddFiles pid={pid} itemId={itemId}>
                        {sortedFiles.length === 0 ? (
                          <p className="text-14 text-text-2">Nothing attached yet.</p>
                        ) : (
                          <>
                            <Thumbs files={sortedFiles} activeId={activeFile?.id} onPick={setTab} />
                            <Tabs
                              label="Attachments"
                              bleed={false}
                              value={activeFile?.id ?? ''}
                              onValueChange={setTab}
                              tabs={sortedFiles.map((f) => ({
                                value: f.id,
                                label: isNewAttachment(ts(f.data.at), now)
                                  ? `${f.data.name} · new`
                                  : f.data.name,
                                content: (
                                  <div className="flex flex-col gap-2">
                                    <AttachmentPreview attachment={f.data} />
                                    <Link
                                      to="/p/$pid/i/$iid/view/$aid"
                                      params={{ pid, iid: itemId, aid: f.id }}
                                      className="inline-flex min-h-11 items-center gap-1.5 self-start text-14 font-medium underline underline-offset-4"
                                    >
                                      Full page <Icon icon={Maximize2} size={16} />
                                    </Link>
                                  </div>
                                ),
                              }))}
                            />
                          </>
                        )}
                      </AddFiles>
                    </Section>

                    <FoundWhileWorking
                      pid={pid}
                      itemId={itemId}
                      project={project}
                      item={item}
                      items={allSuggestions[pid] ?? []}
                    />

                    <Section title="Messages">
                      {thread.length === 0 ? (
                        <p className="text-14 text-text-2">No messages.</p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {thread.map((m) => (
                            <li
                              key={m.id}
                              className={cn(
                                'rounded-card border p-2.5 text-14',
                                m.data.kind === 'question'
                                  ? 'border-gate/60 bg-gate-bg'
                                  : 'border-line bg-surface',
                              )}
                            >
                              <p className="mb-0.5 text-12 text-text-2">
                                {who(m.data.by)} · {m.data.kind} · {timeAgo(ts(m.data.at), now)}
                              </p>
                              <p className="whitespace-pre-wrap text-ink">{m.data.text}</p>
                              <TagList
                                tags={history.find((d) => m.id === `${d.id}-note`)?.data.tags ?? []}
                              />
                            </li>
                          ))}
                        </ul>
                      )}
                      <Textarea
                        label="Add a note"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                      />
                      <Button
                        variant="secondary"
                        className="self-start"
                        loading={sending}
                        disabled={!text.trim()}
                        onClick={addNote}
                      >
                        Add note
                      </Button>
                    </Section>

                    <Section title="Runs">
                      {runList.length === 0 ? (
                        <p className="text-14 text-text-2">No agent has worked on this yet.</p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {runList.map((r) => {
                            const a = agents.find((x) => x.id === r.data.agentUid);
                            return (
                              <li
                                key={r.id}
                                className="rounded-card border border-line bg-surface p-2.5 text-14"
                              >
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                                  <span className="font-medium text-ink">
                                    {a?.data.name ?? 'Removed agent'}
                                  </span>
                                  <span className="text-text-2">
                                    {timeAgo(ts(r.data.startedAt), now)}
                                  </span>
                                  <span className="text-text-2">
                                    {r.data.status === 'stopped'
                                      ? `stopped by ${r.data.stoppedBy?.name || 'a person'}`
                                      : r.data.status}
                                  </span>
                                  <span className="text-text-2">{formatEur(r.data.costEur)}</span>
                                  {r.data.tokensIn || r.data.tokensOut ? (
                                    <span
                                      className="text-text-2 tabular-nums"
                                      data-testid="run-tokens"
                                    >
                                      {formatTokens(newTokens(r.data))} tokens
                                    </span>
                                  ) : null}
                                  {r.data.model ? (
                                    <span className="text-text-2" data-testid="run-model">
                                      {r.data.model}
                                    </span>
                                  ) : null}
                                  {r.data.remote ? (
                                    <a
                                      href={r.data.remote.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="min-h-11 content-center text-13 font-medium underline underline-offset-4"
                                      data-testid="run-remote"
                                    >
                                      Open in Claude
                                    </a>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="ml-auto min-h-11 text-13 font-medium underline underline-offset-4"
                                    aria-expanded={openLog === r.id}
                                    onClick={() => setOpenLog(openLog === r.id ? null : r.id)}
                                  >
                                    {openLog === r.id ? 'Hide log' : 'Show log'}
                                  </button>
                                </div>
                                {r.data.summary ? (
                                  <p className="text-text-2">{r.data.summary}</p>
                                ) : null}
                                {openLog === r.id ? <RunLog wid={wid} runId={r.id} /> : null}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </Section>

                    <Section title="Decisions">
                      {history.length === 0 && restores.length === 0 ? (
                        <p className="text-14 text-text-2">No decisions yet.</p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {[
                            ...history.map((d) => ({ at: ts(d.data.at), d, r: null })),
                            ...restores.map((r) => ({ at: r.at, d: null, r })),
                          ]
                            .sort((x, y) => y.at - x.at)
                            .map(({ d, r }) =>
                              r ? (
                                <li
                                  key={r.id}
                                  className="rounded-card border border-line bg-surface p-2.5 text-14"
                                >
                                  <p className="text-12 text-text-2">
                                    {r.by} · Restored
                                    {r.stepId
                                      ? ` to ${project.steps.find((s) => s.id === r.stepId)?.name ?? r.stepId}`
                                      : ''}{' '}
                                    · {timeAgo(r.at, now)}
                                  </p>
                                </li>
                              ) : d ? (
                                <li
                                  key={d.id}
                                  className="rounded-card border border-line bg-surface p-2.5 text-14"
                                >
                                  <p className="text-12 text-text-2">
                                    {who({ type: 'human', id: d.data.byUid })} ·{' '}
                                    {decisionText(
                                      d.data,
                                      (id) => project.steps.find((s) => s.id === id)?.name ?? id,
                                    )}{' '}
                                    · {timeAgo(ts(d.data.at), now)}
                                    {d.data.via === 'telegram' ? ' · via Telegram' : ''}
                                  </p>
                                  {d.data.rationale ? (
                                    <p className="text-ink">{d.data.rationale}</p>
                                  ) : null}
                                  <TagList tags={d.data.tags} />
                                </li>
                              ) : null,
                            )}
                        </ul>
                      )}
                    </Section>
                  </div>
                ),
              },
              {
                value: 'timeline',
                label: 'History',
                content: (
                  <ItemTimeline
                    wid={wid}
                    pid={pid}
                    itemId={itemId}
                    title={item.title}
                    agents={agents}
                    detail={{
                      decisions: decisions.state === 'ready' ? decisions.data : [],
                      runs: runs.state === 'ready' ? runs.data : [],
                      attachments: files,
                      source: item.source,
                    }}
                  />
                ),
              },
            ]}
          />
        )}
      </div>
    </FocusView>
  );
}

/**
 * Files as thumbnails: a picture for images, an icon for the rest. A mouse shortcut to the tabs
 * below (the tabs stay the keyboard and screen-reader way, so these carry no text of their own).
 */
function Thumbs({
  files,
  activeId,
  onPick,
}: {
  files: Array<{ id: string; data: { kind: string; content?: string | null } }>;
  activeId: string | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <div aria-hidden className="flex flex-wrap gap-2">
      {files.map((f) => (
        <button
          key={f.id}
          type="button"
          tabIndex={-1}
          onClick={() => onPick(f.id)}
          className={cn(
            'grid size-16 place-items-center overflow-hidden rounded-btn border bg-canvas text-text-2',
            f.id === activeId ? 'border-ink' : 'border-line hov:border-text-2',
          )}
        >
          {f.data.kind === 'image' && f.data.content?.startsWith('data:image/') ? (
            <img src={f.data.content} alt="" className="size-full object-cover" />
          ) : (
            <Icon icon={FileText} size={22} />
          )}
        </button>
      ))}
    </div>
  );
}

/** Send-back tags, as small chips under the reason. */
function TagList({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul aria-label="Tags" className="mt-1.5 flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <li key={t}>
          <Badge tone="sendback" className="font-medium">
            {t}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
