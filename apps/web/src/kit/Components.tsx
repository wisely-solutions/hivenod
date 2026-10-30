import { ArrowRight, Bell, Inbox, Plus, Search, Settings, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Avatar, AgentAvatar, AvatarStack } from '../ui/avatar';
import { Badge, Eyebrow, Pill, StepPill } from '../ui/badge';
import { Button, IconButton, type ButtonVariant } from '../ui/button';
import { Card } from '../ui/card';
import { ItemCard } from './ItemCard';
import {
  BarChart,
  CountUp,
  EmptyState,
  Kpi,
  ProgressRing,
  Skeleton,
  SkeletonSwap,
  WorkingDots,
} from '../ui/feedback';
import { Segmented, Input, RadioCards, Select, Tabs, Textarea, Toggle } from '../ui/form';
import { Icon } from '../ui/icon';
import { Dialog, Popover, Sheet, Tooltip, useToast } from '../ui/overlay';
import { BOARD_ITEMS, INBOX, PORTRAIT } from './sample';

export function Section({
  id,
  eyebrow,
  title,
  intro,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20 py-8">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 id={`${id}-h`} className="mt-1 text-28 font-semibold tracking-tight text-ink">
        {title}
      </h2>
      {intro ? <p className="mt-1 max-w-prose text-14 text-text-2">{intro}</p> : null}
      <div className="mt-5 flex flex-col gap-6">{children}</div>
    </section>
  );
}

export function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-13 font-semibold text-ink">{title}</h3>
      {children}
    </div>
  );
}

const VARIANTS: Array<[ButtonVariant, string]> = [
  ['primary', 'Primary'],
  ['secondary', 'Secondary'],
  ['ghost', 'Ghost'],
  ['approve', 'Approve → Plan'],
  ['sendback', 'Send back to Draft'],
  ['gate', 'Needs you'],
];

export function ButtonsSection() {
  return (
    <>
      <Sub title="Variants and states">
        <div className="relative overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[640px] border-collapse text-left text-13">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="p-3">
                  <Eyebrow>Variant</Eyebrow>
                </th>
                {['Default', 'Hover', 'Focus', 'Active', 'Disabled', 'Loading'].map((h) => (
                  <th key={h} scope="col" className="p-3">
                    <Eyebrow>{h}</Eyebrow>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {VARIANTS.map(([v, label]) => (
                <tr key={v} className="border-b border-line last:border-0">
                  <th scope="row" className="p-3 font-medium text-ink">
                    {v}
                  </th>
                  <td className="p-3">
                    <Button variant={v}>{label}</Button>
                  </td>
                  <td className="p-3">
                    <Button variant={v} force="hover" tabIndex={-1}>
                      {label}
                    </Button>
                  </td>
                  <td className="p-3">
                    <Button variant={v} force="focus" tabIndex={-1}>
                      {label}
                    </Button>
                  </td>
                  <td className="p-3">
                    <Button variant={v} force="active" tabIndex={-1}>
                      {label}
                    </Button>
                  </td>
                  <td className="p-3">
                    <Button variant={v} disabled>
                      {label}
                    </Button>
                  </td>
                  <td className="p-3">
                    <Button variant={v} loading>
                      {label}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-13 text-text-2">
          Hover, focus and active columns are forced so you can compare them. Try the real states on
          the first column.
        </p>
      </Sub>
      <Sub title="Icon buttons">
        <div className="flex flex-wrap items-center gap-3">
          <IconButton label="Search">
            <Icon icon={Search} size={18} />
          </IconButton>
          <IconButton label="Notifications" variant="secondary">
            <Icon icon={Bell} size={18} />
          </IconButton>
          <IconButton label="Settings" variant="primary">
            <Icon icon={Settings} size={18} />
          </IconButton>
          <IconButton label="Hover" force="hover" variant="secondary">
            <Icon icon={Plus} size={18} />
          </IconButton>
          <IconButton label="Focus" force="focus" variant="secondary">
            <Icon icon={Plus} size={18} />
          </IconButton>
          <IconButton label="Disabled" disabled variant="secondary">
            <Icon icon={Plus} size={18} />
          </IconButton>
          <IconButton label="Loading" loading variant="secondary" />
        </div>
      </Sub>
    </>
  );
}

export function BadgesSection() {
  const [n, setN] = useState(3);
  return (
    <>
      <Sub title="Pills and step pills">
        <div className="flex flex-wrap items-center gap-2">
          <Pill>Neutral</Pill>
          <Pill tone="gate">Waiting for you</Pill>
          <Pill tone="agent">Agent working</Pill>
          <Pill tone="approve">Approved</Pill>
          <Pill tone="sendback">Sent back</Pill>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <StepPill label="Intake" kind="agent" state="done" />
          <StepPill label="Research" kind="agent" state="current" selected />
          <StepPill label="Go or no-go" kind="human" count={2} />
          <StepPill label="Build" kind="agent" />
        </div>
      </Sub>
      <Sub title="Badge with number roll">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone="gate" count={n}>
            Needs you
          </Badge>
          <Badge tone="agent" count={n * 2} />
          <Button variant="secondary" onClick={() => setN((v) => v + 1)}>
            Add one
          </Button>
          <Button variant="ghost" onClick={() => setN((v) => Math.max(0, v - 1))}>
            Remove one
          </Button>
        </div>
      </Sub>
    </>
  );
}

export function AvatarsSection() {
  const [live, setLive] = useState(true);
  return (
    <>
      <Sub title="Humans and agents">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name="João" photoUrl={PORTRAIT} size="lg" />
          <Avatar name="Maria" size="lg" />
          <AgentAvatar name="Research agent" color={1} live={live} size="lg" />
          <AgentAvatar name="Writer" color={3} size="lg" />
          <AvatarStack
            size="md"
            people={[
              { name: 'João', photoUrl: PORTRAIT },
              { name: 'Research agent', agentColor: 1, live },
              { name: 'Writer', agentColor: 3 },
              { name: 'Planner', agentColor: 5 },
              { name: 'Builder', agentColor: 6 },
            ]}
          />
          <Toggle label="Run is alive" checked={live} onCheckedChange={setLive} />
        </div>
      </Sub>
      <Sub title="Eight agent colours">
        <div className="flex flex-wrap gap-3">
          {Array.from({ length: 8 }, (_, i) => (
            <AgentAvatar key={i} name={`Agent ${i + 1}`} color={i + 1} size="lg" />
          ))}
        </div>
      </Sub>
    </>
  );
}

export function CardsSection() {
  return (
    <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
      <Sub title="Card">
        <Card>
          <Eyebrow>Plain</Eyebrow>
          <p className="mt-1 text-14 text-ink">Surface, 12px radius, level one shadow.</p>
        </Card>
        <Card tone="gate" className="mt-3">
          <Eyebrow className="text-gate-text">Needs you</Eyebrow>
          <p className="mt-1 text-14 text-ink">Amber is reserved for human decisions.</p>
        </Card>
      </Sub>
      <Sub title="Item cards">
        <div className="flex flex-col gap-3">
          <ItemCard item={INBOX[0]!} onOpen={() => undefined} />
          <ItemCard item={BOARD_ITEMS[0]!} />
          <ItemCard item={INBOX[2]!} />
        </div>
      </Sub>
    </div>
  );
}

export function FormsSection() {
  const [sel, setSel] = useState('week');
  const [radio, setRadio] = useState('any');
  const [on, setOn] = useState(true);
  const [chip, setChip] = useState('all');
  const [tab, setTab] = useState('report');
  const [text, setText] = useState('');
  return (
    <div className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
      <div className="flex flex-col gap-4">
        <Input label="Item title" placeholder="Add an idea, request or bug" />
        <Input label="Hover" placeholder="Forced hover" force="hover" />
        <Input label="Focus" force="focus" placeholder="Forced focus" />
        <Input label="With an error" defaultValue="x" error="Use at least 10 characters." />
        <Input label="Disabled" disabled defaultValue="Locked" />
        <Textarea
          label="Why?"
          hint={`${text.length} of 10 characters minimum`}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Select
          label="Range"
          value={sel}
          onValueChange={setSel}
          options={[
            { value: 'week', label: 'Last 7 days' },
            { value: 'month', label: 'Last 30 days' },
            { value: 'quarter', label: 'Last 90 days' },
          ]}
        />
      </div>
      <div className="flex flex-col gap-4">
        <RadioCards
          label="Approval rule"
          value={radio}
          onValueChange={setRadio}
          options={[
            {
              value: 'any',
              title: 'Any one of them',
              description: 'The first person to approve decides.',
            },
            { value: 'all', title: 'Everyone', description: 'All deciders must approve.' },
            {
              value: 'off',
              title: 'Specific people',
              description: 'Not available yet.',
              disabled: true,
            },
          ]}
        />
        <Toggle
          label="Remind me after 24 hours"
          description="An in-app badge, no email."
          checked={on}
          onCheckedChange={setOn}
        />
        <Toggle label="Disabled" checked={false} onCheckedChange={() => undefined} disabled />
        <Sub title="Segmented control">
          <Segmented
            label="Filter"
            value={chip}
            onValueChange={setChip}
            options={[
              { value: 'all', label: 'All', count: 7 },
              { value: 'approvals', label: 'Approvals', count: 4 },
              { value: 'questions', label: 'Questions', count: 2 },
              { value: 'findings', label: 'Findings', count: 1 },
              { value: 'urgent', label: 'Urgent' },
            ]}
          />
        </Sub>
        <Tabs
          label="Deliverables"
          value={tab}
          onValueChange={setTab}
          tabs={[
            {
              value: 'report',
              label: 'report.html',
              content: <p className="text-14 text-text-2">Inline preview of the report.</p>,
            },
            {
              value: 'sources',
              label: 'sources.pdf',
              content: <p className="text-14 text-text-2">Eleven sources, linked.</p>,
            },
            {
              value: 'links',
              label: 'Links',
              content: <p className="text-14 text-text-2">Three links.</p>,
            },
            {
              value: 'log',
              label: 'Agent log',
              content: <p className="text-14 text-text-2">Run log lines appear here.</p>,
            },
          ]}
        />
      </div>
    </div>
  );
}

export function OverlaysSection() {
  const [dialog, setDialog] = useState(false);
  const [sheet, setSheet] = useState(false);
  const toast = useToast();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Tooltip content="Tooltips are for extra detail, never the only label.">
        <Button variant="secondary">Tooltip</Button>
      </Tooltip>
      <Popover label="Run facts" trigger={<Button variant="secondary">Popover</Button>}>
        <Eyebrow>Run facts</Eyebrow>
        <p className="mt-1 text-14 text-ink">Research agent · 4 min · €0.12</p>
      </Popover>
      <Button variant="secondary" onClick={() => setDialog(true)}>
        Dialog
      </Button>
      <Button variant="secondary" onClick={() => setSheet(true)}>
        Sheet
      </Button>
      <Button
        variant="secondary"
        onClick={() =>
          toast.push({
            message: 'Sent for review',
            undoLabel: 'Undo',
            duration: 5000,
            onUndo: () => undefined,
          })
        }
      >
        Toast with undo
      </Button>
      <Dialog
        open={dialog}
        onOpenChange={setDialog}
        title="Stop this item?"
        description="It moves to the archive and agents will not retry it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Keep working
            </Button>
            <Button variant="sendback" onClick={() => setDialog(false)}>
              Stop item
            </Button>
          </>
        }
      >
        <Button
          variant="secondary"
          onClick={() => toast.push({ message: 'A notification over the dialog', duration: 20000 })}
        >
          Show a notification
        </Button>
      </Dialog>
      <Sheet
        open={sheet}
        onOpenChange={setSheet}
        title="Sheet"
        description="Drag the handle down to dismiss, or use Close."
        footer={<Button onClick={() => setSheet(false)}>Done</Button>}
      >
        <p className="text-14 text-text-2">
          Sheets respect the bottom safe area and stop at 92% of the screen height.
        </p>
        <Input label="Your rationale" placeholder="Optional" />
        <Button
          variant="secondary"
          onClick={() => toast.push({ message: 'A notification over the dialog', duration: 20000 })}
        >
          Show a notification
        </Button>
      </Sheet>
    </div>
  );
}

export function FeedbackSection() {
  const [loading, setLoading] = useState(true);
  return (
    <div className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
      <Sub title="Skeleton to content cross-fade">
        <Button variant="secondary" onClick={() => setLoading((v) => !v)} className="mb-3">
          {loading ? 'Show content' : 'Show skeleton'}
        </Button>
        <SkeletonSwap
          loading={loading}
          skeleton={
            <div className="rounded-card border border-line bg-surface p-3.5">
              <Skeleton className="mb-2 h-5 w-16" />
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="mt-3 h-4 w-1/2" />
            </div>
          }
        >
          <ItemCard
            item={{
              ...INBOX[0]!,
              agent: undefined,
              approvals: undefined,
              attachments: 'report.html',
              waitingForYou: false,
            }}
          />
        </SkeletonSwap>
      </Sub>
      <Sub title="Empty state">
        <EmptyState
          icon={Inbox}
          title="Nothing needs you"
          description="Agents are working on 4 items."
          action={
            <Button variant="secondary" leading={<Icon icon={Sparkles} />}>
              See what they are doing
            </Button>
          }
        >
          <AvatarStack
            people={[
              { name: 'Research agent', agentColor: 1, live: true },
              { name: 'Writer', agentColor: 3, live: true },
              { name: 'Builder', agentColor: 6 },
            ]}
            size="md"
          />
        </EmptyState>
      </Sub>
      <Sub title="Progress ring and working dots">
        <div className="flex items-center gap-5">
          <ProgressRing value={1} max={4} size={36} label="One of four" />
          <ProgressRing value={3} max={4} size={36} label="Three of four" />
          <ProgressRing value={4} max={4} size={36} label="Done" />
          <span className="inline-flex items-center gap-2 text-13 text-text-2">
            <WorkingDots /> Working
          </span>
        </div>
      </Sub>
      <Sub title="Numbers and bars (animate when first in view)">
        <div className="grid grid-cols-2 gap-3">
          <Kpi label="Decisions">
            <CountUp to={128} />
          </Kpi>
          <Kpi label="Approved first time">
            <CountUp to={86.4} decimals={1} suffix="%" />
          </Kpi>
        </div>
        <div className="mt-4 rounded-card border border-line bg-surface p-4">
          <Eyebrow>Why things were sent back</Eyebrow>
          <div className="mt-3">
            <BarChart
              title="Why things were sent back"
              data={[
                { label: 'Wrong audience', value: 9 },
                { label: 'Too long', value: 6 },
                { label: 'Off brand voice', value: 4 },
                { label: 'Missing tests', value: 2 },
              ]}
            />
          </div>
        </div>
      </Sub>
    </div>
  );
}

export function IconsSection() {
  return (
    <div className="flex flex-wrap items-center gap-4 text-ink">
      {[ArrowRight, Bell, Inbox, Plus, Search, Settings, Sparkles].map((G, i) => (
        <span
          key={i}
          className="grid size-11 place-items-center rounded-btn border border-line bg-surface"
        >
          <Icon icon={G} size={20} />
        </span>
      ))}
      <span className="text-13 text-text-2">Lucide, 1.75 stroke, 16 or 20 px.</span>
    </div>
  );
}
