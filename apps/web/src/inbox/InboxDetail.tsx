import { attachmentSchema, nextOnPath, runSchema, type Agent } from '@hive/shared';
import { Skeleton } from '../ui/feedback';
import { collection, query, where } from 'firebase/firestore';
import { Link } from '@tanstack/react-router';
import { Check, ExternalLink, Maximize2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { colorIndex } from '../agents/logic';
import { AttachmentPreview } from '../board/AttachmentPreview';
import { PathPanel } from '../board/PathPanel';
import { PathEntryActions, PathEntryBody } from './PathEntry';
import { useSwipe } from '../lib/mobile';
import { isStandalone } from '../shell/pwa';
import { db } from '../lib/db';
import { useLiveCollection, useLiveQuery, type Row } from '../lib/live';
import { formatDuration } from '../activity/logic';
import { formatEur } from '../shell/logic';
import { AgentAvatar } from '../ui/avatar';
import { Badge, Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { Tabs } from '../ui/form';
import { Icon } from '../ui/icon';
import type { Run } from '@hive/shared';
import { firstStepName, type Decision } from './decision';
import type { DialogMode } from './DecisionDialog';
import { gateWaitNote } from '../notify/note';
import { useReminderMap } from '../notify/reminders';
import { approvalLine, gateRuleLine, questionBlocks, waitLabel, type InboxEntry } from './logic';
import { BarNote, DecisionBar, Key } from '../components/DecisionBar';
import { FocusView, Properties } from '../components/FocusView';
import { DonePanel } from '../components/DonePanel';
import { ItemActions } from '../board/itemActions';
import {
  AddFiles,
  EditableSummary,
  EditableTitle,
  TypePicker,
  takePastedFiles,
  useAddFiles,
} from '../board/ItemEdit';
import { canEditItem } from '../board/logic';
import { stepOfText } from '../board/path';
import { useReady } from '../auth/context';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </section>
  );
}

const ts = (t: { toMillis: () => number }) => t.toMillis();

/** "4 s", "12 min", "1 h 5 min": a 4-second run no longer shows as "1 min". */
function runTime(run: Run): string {
  const end = run.endedAt ? ts(run.endedAt) : ts(run.heartbeatAt);
  return formatDuration(end - ts(run.startedAt));
}

/**
 * The decision, in full (SPEC 9.1): breadcrumb, the deliverables with an inline preview, what the
 * agent asks, run facts, findings, approvals so far, the rationale and the actions.
 */
export function InboxDetail({
  entry,
  wid,
  uid,
  now,
  names,
  agents,
  run: shellRun,
  runsLoading,
  findings,
  questions,
  rationale,
  onRationale,
  onDecide,
  onDialog,
  onBack,
  phone,
  position,
  onStep,
  released,
  doneRuns,
}: {
  entry: InboxEntry;
  wid: string;
  uid: string;
  now: number;
  names: Record<string, string>;
  agents: Row<Agent>[];
  run: Row<Run> | null;
  /** The shell's runs feed has not answered yet (runs load after the list): no run is not "no run". */
  runsLoading: boolean;
  findings: InboxEntry['item'][];
  questions: string[];
  rationale: string;
  onRationale: (v: string) => void;
  onDecide: (d: Decision) => string | null;
  onDialog: (mode: DialogMode | 'iterate') => void;
  onBack: () => void;
  phone: boolean;
  /** Where this item sits in the list, for next / previous (phone). */
  position?: { index: number; total: number };
  onStep?: (dir: 1 | -1) => void;
  /** A final approval just made from here: counting down ('releasing') or finished ('done'). */
  released?: 'releasing' | 'done';
  /** The item's runs, for the Done panel. */
  doneRuns?: Row<Run>[];
}) {
  const reminders = useReminderMap();
  const { session } = useReady();
  const { add: addFiles } = useAddFiles(entry.pid, entry.itemId);
  const root = useRef<HTMLElement>(null);
  // Swipe between items; in an installed app (where the browser has no back gesture) the left edge goes back.
  useSwipe(root, {
    onLeft: phone && onStep ? () => onStep(1) : undefined,
    onRight: phone && onStep ? () => onStep(-1) : undefined,
    onEdgeBack: phone && isStandalone() ? onBack : undefined,
  });
  const { item, project, pid, itemId } = entry;
  const base = `workspaces/${wid}/projects/${pid}/items/${itemId}`;
  const attachments = useLiveCollection(base ? `${base}/attachments` : null, attachmentSchema);
  // The shell only holds this month's runs; an older run of this item is looked up on its own.
  const ownRuns = useLiveQuery(
    shellRun || runsLoading ? null : `inbox-runs:${wid}:${pid}:${itemId}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/runs`),
        where('projectId', '==', pid),
        where('itemId', '==', itemId),
      ),
    runSchema,
  );
  const run =
    shellRun ??
    (ownRuns.state === 'ready'
      ? ([...ownRuns.data].sort((a, b) => ts(b.data.startedAt) - ts(a.data.startedAt))[0] ?? null)
      : null);
  // Until the run for this item is known, say so with a placeholder, never "No run yet".
  const runPending = !run && (runsLoading || ownRuns.state === 'loading');
  const [tab, setTab] = useState('');
  const [answerText, setAnswerText] = useState('');
  const [error, setError] = useState<string | undefined>();

  const files =
    attachments.state === 'ready'
      ? [...attachments.data].sort((a, b) => ts(a.data.at) - ts(b.data.at))
      : [];
  const active = files.find((f) => f.id === tab) ?? files[0];
  // The next step on the item's path (card st5INNZj): skipped steps are passed over.
  const next = nextOnPath(project, item) ?? undefined;
  const agent = run ? agents.find((a) => a.id === run.data.agentUid) : undefined;
  const gateLine = approvalLine(project, item, uid, names);

  const step = project.steps.find((s) => s.id === item.stepId);
  const ruleLine = entry.kind === 'approval' ? gateRuleLine(step?.gate) : '';
  const barLabel =
    entry.kind === 'approval'
      ? `${step?.name ?? 'Decision'} · you decide`
      : entry.kind === 'path'
        ? 'Path · you decide'
        : entry.kind === 'proposal'
          ? 'New step · you decide'
          : entry.kind === 'question'
            ? 'Question · your reply'
            : entry.kind === 'finding'
              ? 'Suggestion · you decide'
              : undefined;

  function sendReply() {
    const problem = onDecide({ kind: 'answer', text: answerText });
    if (problem) setError(problem);
  }

  const actions = released ? (
    released === 'releasing' ? (
      <Button variant="approve" loading disabled className="min-w-0 flex-1 sm:flex-none">
        Approve
      </Button>
    ) : null
  ) : entry.kind === 'approval' ? (
    <>
      <Button
        variant="approve"
        className="min-w-0 flex-1 px-2 max-[359px]:basis-full sm:flex-none sm:px-4"
        leading={<Icon icon={Check} />}
        onClick={() => onDecide({ kind: 'approve', rationale })}
      >
        {next ? `Approve → ${next.name}` : 'Approve'}
        <Key>A</Key>
      </Button>
      <Button
        variant="sendback"
        className="shrink-0 px-2.5 max-[359px]:flex-1"
        onClick={() => onDialog('iterate')}
      >
        Send back…
        <Key>R</Key>
      </Button>
      <Button
        variant="sendback"
        className="shrink-0 px-2.5 max-[359px]:flex-1"
        onClick={() => onDialog('reject')}
      >
        Reject
      </Button>
    </>
  ) : entry.kind === 'path' || entry.kind === 'proposal' ? (
    <PathEntryActions entry={entry} />
  ) : entry.kind === 'question' ? (
    <Button className="min-w-0 flex-1 sm:flex-none" onClick={sendReply}>
      Reply
    </Button>
  ) : entry.kind === 'finding' ? (
    <>
      <Button onClick={() => onDecide({ kind: 'intake' })}>Add to {firstStepName(project)}</Button>
      <Button variant="secondary" onClick={() => onDialog('dismiss')}>
        Dismiss…
      </Button>
    </>
  ) : null;

  const canEdit = canEditItem(item, session.me.uid, session.isAdmin);
  const deciders = step?.gate?.deciderUids ?? [];
  const bar = actions ? (
    <DecisionBar
      label={barLabel}
      rule={ruleLine}
      note={
        entry.kind === 'approval' && !released ? (
          <BarNote
            label="Your note (optional)"
            placeholder="Add a note (optional)"
            hint="Saved with the decision."
            value={rationale}
            onChange={onRationale}
            onPaste={(e) => takePastedFiles(e, (f) => void addFiles(f))}
          />
        ) : entry.kind === 'question' ? (
          <BarNote
            label="Your reply"
            placeholder="Your reply, sent to the agent"
            value={answerText}
            error={error}
            onChange={(v) => {
              setAnswerText(v);
              setError(undefined);
            }}
          />
        ) : undefined
      }
    >
      {actions}
    </DecisionBar>
  ) : null;

  return (
    <FocusView
      label={`Decision: ${item.title}`}
      role="article"
      rootRef={root}
      backLabel="Back to inbox"
      backText="Needs you"
      onBack={onBack}
      crumb={
        <>
          <strong>
            {project.emoji} {project.name}
          </strong>
          {step ? ` \u203a ${step.name}` : ''}
        </>
      }
      position={
        position && position.total > 0 && onStep ? { ...position, noun: 'waiting' } : undefined
      }
      onStep={onStep}
      properties={
        <Properties
          rows={[
            {
              label: 'Step',
              value: step ? `${step.name} \u00b7 ${stepOfText(project, item)}` : '\u2014',
            },
            ...(step?.kind === 'human'
              ? [
                  {
                    label: 'Decides',
                    value: deciders.length
                      ? deciders.map((u) => names[u] ?? 'Someone').join(', ')
                      : '\u2014',
                  },
                ]
              : []),
            { label: 'Agent', value: agent?.data.name ?? '\u2014' },
            {
              label: 'Type',
              value:
                canEdit && item.type !== 'finding' ? (
                  <TypePicker pid={pid} itemId={itemId} item={item} />
                ) : (
                  item.type
                ),
            },
            { label: 'Cost', value: run ? formatEur(run.data.costEur) : '\u2014' },
          ]}
        >
          {entry.kind === 'approval' || entry.kind === 'question' ? (
            <ItemActions pid={pid} itemId={itemId} item={item} onGone={onBack} />
          ) : null}
        </Properties>
      }
      bar={bar}
    >
      <div className="flex min-w-0 flex-col gap-5">
        <header className="flex flex-col gap-1">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <Badge>{item.type}</Badge>
              {item.sendBackCount ? <Badge tone="sendback">↩ {item.sendBackCount}</Badge> : null}
            </div>
            <section aria-label="Item detail" className="flex flex-col gap-4">
              <EditableTitle pid={pid} itemId={itemId} item={item} canEdit={canEdit} />
              <Section title="Description">
                <EditableSummary pid={pid} itemId={itemId} item={item} canEdit={canEdit} />
              </Section>
              <Section title="Attachments">
                <AddFiles pid={pid} itemId={itemId}>
                  <p className="text-14 text-text-2">
                    New files are listed with the item&apos;s other attachments.
                  </p>
                </AddFiles>
              </Section>
            </section>
          </div>
        </header>

        {released === 'done' ? (
          <DonePanel
            pid={pid}
            item={{ ...item, status: 'done' }}
            itemId={itemId}
            runs={doneRuns ?? []}
            burst
          />
        ) : null}

        {entry.kind === 'path' || entry.kind === 'proposal' ? null : (
          <PathPanel
            pid={pid}
            itemId={itemId}
            project={project}
            item={released === 'done' ? { ...item, status: 'done' } : item}
            agents={agents}
          />
        )}
        <Link
          to="/p/$pid"
          params={{ pid }}
          search={{ item: itemId }}
          className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-btn text-13 font-medium text-text-2 hov:text-ink"
        >
          <Icon icon={ExternalLink} size={14} /> Open in board
        </Link>

        {entry.kind === 'path' || entry.kind === 'proposal' ? (
          <PathEntryBody entry={entry} agents={agents} names={names} uid={uid} />
        ) : entry.kind === 'finding' ? (
          <Section title="Found while working">
            <p className="text-13 text-text-2">{item.source.label}</p>
            <p className="whitespace-pre-wrap text-14 text-ink">{item.summary || 'No details.'}</p>
          </Section>
        ) : (
          <>
            <Section title="Deliverable">
              {files.length === 0 ? (
                <p className="text-14 text-text-2">
                  {item.summary || 'Nothing attached. The agent left no files.'}
                </p>
              ) : (
                <>
                  <Tabs
                    label="Deliverables"
                    value={active?.id ?? ''}
                    onValueChange={setTab}
                    tabs={files.map((f) => ({
                      value: f.id,
                      label: f.data.name,
                      content: <AttachmentPreview attachment={f.data} />,
                    }))}
                  />
                  {active ? (
                    <Link
                      to="/p/$pid/i/$iid/view/$aid"
                      params={{ pid, iid: itemId, aid: active.id }}
                      className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-btn border border-line-strong px-3 text-13 font-medium text-ink hov:bg-canvas"
                    >
                      <Icon icon={Maximize2} size={14} /> Full page
                    </Link>
                  ) : null}
                </>
              )}
            </Section>

            <Section title={questions.length ? 'Open questions' : 'Run summary'}>
              {questions.length ? (
                <ul className="flex flex-col gap-2">
                  {questions.map((q) => (
                    <li
                      key={q}
                      className="rounded-card border border-gate/60 bg-gate-bg p-3 text-14"
                    >
                      <QuestionText text={q} />
                    </li>
                  ))}
                </ul>
              ) : runPending ? (
                <div aria-busy="true" data-loading="run-summary" className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              ) : (
                <p className="text-14 text-text-2">
                  {run?.data.summary ?? 'Nothing beyond the decision itself.'}
                </p>
              )}
            </Section>

            <Section title="Run facts">
              {run ? (
                <dl className="grid grid-cols-3 gap-3 text-13">
                  <div>
                    <dt className="text-text-2">Agent</dt>
                    <dd className="mt-0.5 inline-flex items-center gap-1.5 font-medium text-ink">
                      {agent ? (
                        <AgentAvatar
                          name={agent.data.name}
                          color={colorIndex(agent.data.color, agent.id)}
                          size="sm"
                        />
                      ) : null}
                      {agent?.data.name ?? 'An agent'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-2">Run time</dt>
                    <dd className="mt-0.5 font-medium text-ink">{runTime(run.data)}</dd>
                  </div>
                  <div>
                    <dt className="text-text-2">Cost</dt>
                    <dd className="mt-0.5 font-medium text-ink">{formatEur(run.data.costEur)}</dd>
                  </div>
                </dl>
              ) : runPending ? (
                <div aria-busy="true" data-loading="run-facts" className="grid grid-cols-3 gap-3">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : (
                <p className="text-14 text-text-2">No run yet.</p>
              )}
            </Section>

            <Section title={`Found while working (${findings.length})`}>
              {findings.length ? (
                <ul className="flex flex-col gap-1 text-14">
                  {findings.slice(0, 3).map((f) => (
                    <li key={f.title} className="text-ink">
                      {f.title}
                    </li>
                  ))}
                  {findings.length > 3 ? (
                    <li className="text-text-2">and {findings.length - 3} more</li>
                  ) : null}
                </ul>
              ) : (
                <p className="text-14 text-text-2">Nothing found outside the scope.</p>
              )}
            </Section>
          </>
        )}

        {entry.kind === 'approval' ? (
          <>
            <Section title="Approvals so far">
              <p className="text-14 text-ink">{gateLine}</p>
              <p className="text-12 text-text-2">
                {gateWaitNote({
                  project: entry.project,
                  item: entry.item,
                  itemId: entry.itemId,
                  sinceMs: entry.since,
                  nowMs: now,
                  reminders,
                }) ?? `Waiting ${waitLabel(entry.since, now)}`}
              </p>
            </Section>
          </>
        ) : null}
      </div>
    </FocusView>
  );
}

/** A question's text with numbered lines shown as a list. */
function QuestionText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2">
      {questionBlocks(text).map((b, i) =>
        b.kind === 'list' ? (
          <ol key={i} className="ml-5 flex list-decimal flex-col gap-1">
            {b.items.map((it, j) => (
              <li key={j} className="whitespace-pre-wrap pl-1">
                {it}
              </li>
            ))}
          </ol>
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            {b.text}
          </p>
        ),
      )}
    </div>
  );
}
