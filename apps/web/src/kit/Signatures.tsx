import { Check, X } from 'lucide-react';
import { Dialog as RadixDialog } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentAvatar } from '../ui/avatar';
import { Badge, Eyebrow, NumberRoll, Pill } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { ItemCard, type ItemCardData } from '../ui/card';
import { FoldedColumn, Stepper } from '../ui/feedback';
import { Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import {
  AnimatePresence,
  motion,
  SharedLayout,
  spring,
  tween,
  useReducedMotion,
} from '../ui/motion';
import { Sheet, useToast } from '../ui/overlay';
import { cn } from '../ui/cn';
import { BOARD_ITEMS, INBOX, STEPS } from './sample';
import { Sub } from './Components';

/* ----------------------- 5. Send back sheet ----------------------- */

const CURRENT = 4; // "Approve spec"
const QUICK_TAGS = [
  'Wrong audience',
  'Too long',
  'Off brand voice',
  'Factually wrong',
  'Missing tests',
];

function SendBackBody({
  target,
  setTarget,
  reason,
  setReason,
}: {
  target: string | null;
  setTarget: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Stepper
        steps={STEPS}
        currentIndex={CURRENT}
        value={target}
        onChange={setTarget}
        label="Send back to"
      />
      <div>
        <Textarea
          label="Why?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="At least 10 characters. The next agent run reads this."
        />
        <div className="mt-2 flex flex-wrap gap-2">
          {QUICK_TAGS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setReason((reason ? reason + ' ' : '') + t + '.')}
              className="min-h-11 rounded-full border border-line bg-surface px-3 text-13 text-text-2 transition-colors hover:border-line-strong foc:outline-2 foc:outline-focus"
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <p className="text-13 text-text-2">
        This is the 3rd "wrong audience" rejection at Draft spec this month.
      </p>
    </div>
  );
}

function SendBackSheet({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (targetName: string) => void;
}) {
  const [target, setTarget] = useState<string | null>('research');
  const [reason, setReason] = useState('');
  const valid = target && reason.trim().length >= 10;
  const name = STEPS.find((s) => s.id === target)?.name ?? '';
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Send back"
      description="Pick the step it goes back to, and say why."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="sendback"
            disabled={!valid}
            onClick={() => {
              onOpenChange(false);
              onConfirm(name);
              setReason('');
            }}
          >
            Send back to {name || '…'}
          </Button>
        </>
      }
    >
      <SendBackBody target={target} setTarget={setTarget} reason={reason} setReason={setReason} />
    </Sheet>
  );
}

export function SendBackDemo() {
  const [target, setTarget] = useState<string | null>('research');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <div data-testid="demo-sendback" className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
      <div className="rounded-card border border-line bg-surface p-4">
        <Eyebrow>Inline stepper</Eyebrow>
        <div className="mt-2">
          <SendBackBody
            target={target}
            setTarget={setTarget}
            reason={reason}
            setReason={setReason}
          />
        </div>
      </div>
      <div className="flex flex-col items-start gap-3">
        <p className="text-14 text-text-2">
          Pick an earlier step. The path draws back from where the item is now, and the target
          glows.
        </p>
        <Button variant="sendback" onClick={() => setOpen(true)}>
          Open as a sheet
        </Button>
        <SendBackSheet
          open={open}
          onOpenChange={setOpen}
          onConfirm={(n) => toast.push({ message: `Sent back to ${n}`, duration: 3000 })}
        />
      </div>
    </div>
  );
}

/* ----------------------- 1. Decide flow ----------------------- */

function ApproveButton({
  done,
  onClick,
  label,
}: {
  done: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <motion.button
      layout
      transition={spring.ui}
      type="button"
      onClick={onClick}
      disabled={done}
      aria-label={done ? 'Approved' : undefined}
      style={{ borderRadius: 7 }}
      className={cn(
        'inline-flex min-h-11 items-center justify-center overflow-hidden bg-approve-solid text-14 font-medium text-on-solid',
        'foc:outline-2 foc:outline-offset-2 foc:outline-focus hov:brightness-110',
        done ? 'w-11' : 'px-4',
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {done ? (
          <motion.span
            key="c"
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={spring.ui}
          >
            <Icon icon={Check} size={20} />
          </motion.span>
        ) : (
          <motion.span
            key="t"
            exit={{ opacity: 0 }}
            transition={tween.fast}
            className="whitespace-nowrap"
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

export function DecideDemo() {
  const [items, setItems] = useState<ItemCardData[]>(INBOX);
  const [approving, setApproving] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [offline, setOffline] = useState(false);
  const [queued, setQueued] = useState(0);
  const [sheet, setSheet] = useState(false);
  const toast = useToast();
  const removed = useRef<Map<string, { item: ItemCardData; index: number }>>(new Map());
  const offlineRef = useRef(offline);
  useEffect(() => {
    offlineRef.current = offline;
  }, [offline]);
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  const commit = useCallback((title: string) => {
    if (offlineRef.current) {
      setQueued((q) => q + 1);
      setLog((l) => [`Queued offline: ${title}`, ...l].slice(0, 4));
    } else {
      setLog((l) => [`Saved: ${title}`, ...l].slice(0, 4));
    }
  }, []);

  function approve(item: ItemCardData) {
    if (approving) return;
    setApproving(item.id);
    window.setTimeout(
      () => {
        const index = items.findIndex((i) => i.id === item.id);
        removed.current.set(item.id, { item, index });
        setItems((cur) => cur.filter((i) => i.id !== item.id));
        setApproving(null);
        if (navigator.vibrate) navigator.vibrate(8);
        toast.push({
          message: `Approved: ${item.title.slice(0, 28)}…`,
          undoLabel: 'Undo',
          duration: 5000,
          onUndo: () => {
            const r = removed.current.get(item.id);
            if (!r) return;
            setItems((cur) => {
              const next = [...cur];
              next.splice(Math.min(r.index, next.length), 0, r.item);
              return next;
            });
          },
          onCommit: () => commit(item.title),
        });
      },
      reduced ? 0 : 450,
    );
  }

  // Keyboard: A approves the first item while focus is anywhere inside this demo.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (e.key.toLowerCase() !== 'a' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!rootRef.current?.contains(t) || t?.closest('input, textarea, [role=dialog]')) return;
      if (items[0]) approve(items[0]);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function reset() {
    setItems(INBOX);
    setLog([]);
    setQueued(0);
  }

  return (
    <div
      ref={rootRef}
      data-testid="demo-decide"
      className="grid gap-6 md:grid-cols-[1fr_16rem] [&>*]:min-w-0"
    >
      <div role="list" aria-label="Inbox" className="flex flex-col gap-3">
        <AnimatePresence mode="popLayout" initial={false}>
          {items.map((item, i) => (
            <motion.div
              role="listitem"
              key={item.id}
              layout
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96, transition: tween.base }}
              transition={spring.ui}
              className={cn('rounded-card', i === 0 && 'ring-2 ring-focus/40')}
            >
              <ItemCard item={item} />
              {i === 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <ApproveButton
                    done={approving === item.id}
                    onClick={() => approve(item)}
                    label="Approve → Plan"
                  />
                  <Button variant="sendback" onClick={() => setSheet(true)}>
                    Send back…
                  </Button>
                  <span className="text-13 text-text-3">or press A</span>
                </div>
              ) : null}
            </motion.div>
          ))}
        </AnimatePresence>
        {items.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-14 text-text-2">
            Nothing needs you.{' '}
            <button
              type="button"
              className="min-h-11 font-medium text-agent underline"
              onClick={reset}
            >
              Reset the demo
            </button>
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-3 text-13">
        <Eyebrow>Writes</Eyebrow>
        <label className="flex min-h-11 items-center gap-2 text-ink">
          <input
            type="checkbox"
            checked={offline}
            onChange={(e) => setOffline(e.target.checked)}
            className="size-5"
          />
          Pretend I am offline
        </label>
        <p className="text-text-2">
          Commits when the toast ends or on navigation. Queued writes: <NumberRoll value={queued} />
        </p>
        <ul aria-live="polite" className="flex flex-col gap-1 text-text-2">
          {log.map((l, i) => (
            <li key={`${l}-${i}`}>{l}</li>
          ))}
        </ul>
        {queued > 0 ? (
          <Button
            variant="secondary"
            onClick={() => {
              setLog((l) => [`Synced ${queued} queued`, ...l].slice(0, 4));
              setQueued(0);
              setOffline(false);
            }}
          >
            Go back online
          </Button>
        ) : null}
        <Button variant="ghost" onClick={reset}>
          Reset
        </Button>
      </div>
      <SendBackSheet
        open={sheet}
        onOpenChange={setSheet}
        onConfirm={(n) => {
          const first = items[0];
          if (!first) return;
          setItems((cur) => cur.slice(1));
          toast.push({ message: `Sent back to ${n}`, duration: 3000 });
        }}
      />
    </div>
  );
}

/* ----------------------- 2. Shared-element open ----------------------- */

export function SharedElementDemo() {
  const [openId, setOpenId] = useState<string | null>(null);
  const item = INBOX.find((i) => i.id === openId);
  return (
    <SharedLayout id="kit-shared">
      <div data-testid="demo-shared" className="grid gap-3 md:grid-cols-3 [&>*]:min-w-0">
        {INBOX.map((it) => (
          <div key={it.id} className="min-h-[120px]">
            {it.id !== openId ? (
              <ItemCard item={it} layoutId={`card-${it.id}`} onOpen={() => setOpenId(it.id)} />
            ) : null}
          </div>
        ))}
      </div>
      <RadixDialog.Root open={!!item} onOpenChange={(o) => !o && setOpenId(null)}>
        <AnimatePresence>
          {item ? (
            <RadixDialog.Portal forceMount>
              <RadixDialog.Overlay asChild forceMount>
                <motion.div
                  className="fixed inset-0 z-40 bg-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={tween.base}
                />
              </RadixDialog.Overlay>
              <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
                <RadixDialog.Content asChild forceMount aria-describedby={undefined}>
                  <motion.div
                    layoutId={`card-${item.id}`}
                    transition={spring.sheet}
                    style={{ borderRadius: 12 }}
                    className="pointer-events-auto max-h-[85dvh] w-full max-w-xl overflow-y-auto border border-line bg-surface p-5 shadow-e3 outline-hidden"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <RadixDialog.Title className="text-20 font-semibold text-ink">
                        {item.title}
                      </RadixDialog.Title>
                      <RadixDialog.Close asChild>
                        <IconButton label="Back" className="-mr-2 -mt-2">
                          <Icon icon={X} size={18} />
                        </IconButton>
                      </RadixDialog.Close>
                    </div>
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ ...tween.base, delay: 0.12 }}
                      className="mt-3 flex flex-col gap-3 text-14 text-text-2"
                    >
                      <p>
                        This card grew from the list into this view. Closing it, with Back, Escape
                        or a tap outside, plays the same move in reverse.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Pill tone="gate">Waiting for you</Pill>
                        <Badge>{item.type}</Badge>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="approve">Approve → Plan</Button>
                        <Button variant="sendback">Send back…</Button>
                      </div>
                    </motion.div>
                  </motion.div>
                </RadixDialog.Content>
              </div>
            </RadixDialog.Portal>
          ) : null}
        </AnimatePresence>
      </RadixDialog.Root>
    </SharedLayout>
  );
}

/* ----------------------- 3. Folded agent columns ----------------------- */

function GateColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <motion.section
      layout
      transition={spring.ui}
      style={{ borderRadius: 12 }}
      aria-label={`${title}, decision step`}
      className="w-72 shrink-0 border border-gate/60 bg-gate-bg p-2"
    >
      <div className="flex items-center justify-between px-1 py-1.5">
        <span className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-gate-text">
          {title}
        </span>
        <Badge tone="gate" count={1} />
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </motion.section>
  );
}

export function FoldedDemo() {
  const [open, setOpen] = useState<Record<string, boolean>>({
    research: false,
    draft: false,
    check: false,
  });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  return (
    <div data-testid="demo-folded">
      <div className="relative -mx-4 overflow-x-auto px-4 pb-3">
        <div className="flex items-start gap-3">
          <GateColumn title="Go or no-go">
            <ItemCard item={{ ...INBOX[0]!, agent: undefined, approvals: undefined }} />
          </GateColumn>
          <FoldedColumn
            title="Research"
            count={2}
            live={1}
            progress={{ done: 3, total: 5 }}
            expanded={!!open.research}
            onToggle={() => toggle('research')}
          >
            {BOARD_ITEMS.map((b) => (
              <ItemCard key={b.id} item={b} />
            ))}
          </FoldedColumn>
          <FoldedColumn
            title="Draft spec"
            count={1}
            sendBacks={2}
            expanded={!!open.draft}
            onToggle={() => toggle('draft')}
          >
            <ItemCard item={{ ...INBOX[1]!, waitingForYou: false }} />
          </FoldedColumn>
          <FoldedColumn
            title="Check"
            count={0}
            expanded={!!open.check}
            onToggle={() => toggle('check')}
          >
            <p className="p-2 text-13 text-text-2">Nothing here yet.</p>
          </FoldedColumn>
          <GateColumn title="Approve spec">
            <ItemCard
              item={{ ...INBOX[2]!, foundBy: undefined, type: 'task', waitingForYou: true }}
            />
          </GateColumn>
        </div>
      </div>
      <p className="text-13 text-text-2">Tap a strip to open it. Several can stay open at once.</p>
    </div>
  );
}

/* ----------------------- 4. Live presence ----------------------- */

export function PresenceDemo() {
  const [live, setLive] = useState(true);
  const [seq, setSeq] = useState(3);
  const [list, setList] = useState<Array<{ id: number; title: string }>>([
    { id: 2, title: 'Compare three hosting options' },
    { id: 1, title: 'Draft the launch checklist' },
  ]);
  const titles = [
    'New finding: slow image on pricing',
    'Question: which audience?',
    'Report ready: market scan',
  ];
  function drop() {
    const n = seq + 1;
    setSeq(n);
    setList((l) => [{ id: n, title: titles[n % titles.length]! }, ...l].slice(0, 4));
  }
  return (
    <div data-testid="demo-presence" className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <AgentAvatar name="Research agent" color={1} live={live} size="lg" />
        <AgentAvatar name="Writer" color={3} live={live} size="lg" />
        <div className="text-13 text-text-2">
          Needs you <Badge tone="gate" count={list.length} />
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" onClick={drop}>
            Simulate a new item
          </Button>
          <Button variant="ghost" onClick={() => setLive((v) => !v)}>
            {live ? 'End runs' : 'Start runs'}
          </Button>
        </div>
      </div>
      <ul className="mt-4 flex flex-col gap-2" aria-label="Live items" aria-live="polite">
        <AnimatePresence initial={false}>
          {list.map((it, i) => (
            <motion.li
              layout
              key={it.id}
              initial={{ opacity: 0, y: -16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={spring.ui}
              className={cn(
                'rounded-btn border border-line bg-surface px-3 py-2.5 text-14 text-ink',
                i === 0 && it.id > 3 && 'drop-in-highlight',
              )}
            >
              {it.title}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

export function SignatureSection() {
  return (
    <>
      <Sub title="1. Decide flow: approve, collapse, next item slides up, 5 second undo">
        <DecideDemo />
      </Sub>
      <Sub title="2. Shared-element open">
        <SharedElementDemo />
      </Sub>
      <Sub title="3. Folded agent columns">
        <FoldedDemo />
      </Sub>
      <Sub title="4. Live heartbeat and drop-in highlight">
        <PresenceDemo />
      </Sub>
      <Sub title="5. Send-back stepper path">
        <SendBackDemo />
      </Sub>
    </>
  );
}
