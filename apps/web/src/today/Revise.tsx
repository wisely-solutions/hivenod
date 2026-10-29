/**
 * Ask for changes (item L7OzWKMYZ1O2dX33Xkrj): the box under a proposal's buttons (quick chips,
 * an instruction of up to 500 characters, Ask agent), the "<agent> is revising" strip, the
 * version switcher ("‹ v2 of 3 ›") and the inline word diff between a version and the one before.
 */
import { INBOX_LIMITS, REVISE_CHIP_LABELS, REVISE_CHIPS, type ReviseChip } from '@hive/shared';
import { Check, ChevronLeft, ChevronRight, Loader2, Sparkles } from 'lucide-react';
import { useId } from 'react';
import { Key } from '../components/DecisionBar';
import type { DiffPart } from '../threads/logic';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';

const MAX = INBOX_LIMITS.reviseInstruction;

/** "Shorter, Add my availability · “Mention 14:00 as a backup”". */
export function askedText(asked: { chips: readonly string[]; instruction: string | null }): string {
  const chips = asked.chips.map((c) => REVISE_CHIP_LABELS[c as ReviseChip] ?? c).join(', ');
  const text = asked.instruction ? `“${asked.instruction}”` : '';
  return [chips, text].filter(Boolean).join(' · ');
}

export function AskBox({
  chips,
  text,
  next,
  busy,
  onChips,
  onText,
  onCancel,
  onAsk,
}: {
  chips: readonly string[];
  text: string;
  /** The version the agent will write. */
  next: number;
  busy: boolean;
  onChips: (c: string[]) => void;
  onText: (t: string) => void;
  onCancel: () => void;
  onAsk: () => void;
}) {
  const id = useId();
  const can = (chips.length > 0 || text.trim() !== '') && text.trim().length <= MAX;
  return (
    <form
      data-ask-box=""
      aria-label="Ask for changes"
      className="mt-3 rounded-card border border-agent/40 bg-surface p-3.5 shadow-e1 sm:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (can && !busy) onAsk();
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={`${id}-text`} className="text-14 font-semibold text-ink">
          What should change?
        </label>
        <span
          className={cn(
            'text-12 tabular-nums',
            text.length > MAX ? 'text-sendback' : 'text-text-2',
          )}
          aria-live="polite"
        >
          {text.length} / {MAX}
        </span>
      </div>
      <div role="group" aria-label="Quick changes" className="mt-2 flex flex-wrap gap-2">
        {REVISE_CHIPS.map((c) => {
          const on = chips.includes(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={on}
              data-revise-chip={c}
              onClick={() => onChips(on ? chips.filter((x) => x !== c) : [...chips, c])}
              className={cn(
                'inline-flex min-h-9 items-center gap-1 rounded-full border px-3 text-13 font-medium transition-colors duration-120',
                'foc:outline-2 foc:outline-offset-2 foc:outline-focus',
                on
                  ? 'border-agent bg-agent-soft text-agent'
                  : 'border-line bg-surface text-ink hov:bg-canvas',
              )}
            >
              {on ? <Icon icon={Check} size={13} /> : null}
              {REVISE_CHIP_LABELS[c]}
            </button>
          );
        })}
      </div>
      <textarea
        id={`${id}-text`}
        rows={2}
        value={text}
        maxLength={MAX + 50}
        aria-describedby={`${id}-hint`}
        placeholder="Mention 14:00 as a backup, Sam prefers afternoons"
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (can && !busy) onAsk();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        className={cn(
          'mt-3 block min-h-16 w-full rounded-btn border border-line-strong bg-surface px-3 py-2 text-16 text-ink sm:text-15',
          'placeholder:text-text-3 foc:border-focus foc:outline-2 foc:outline-offset-0 foc:outline-focus',
        )}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p id={`${id}-hint`} className="min-w-0 flex-1 text-12 text-text-2 max-sm:basis-full">
          The agent writes v{next} in this card. v{next - 1} stays, nothing is sent.
        </p>
        <Button type="button" variant="ghost" onClick={onCancel} className="max-sm:flex-1">
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={!can}
          className="bg-agent! text-surface! max-sm:flex-[2]"
          leading={<Icon icon={Sparkles} size={15} />}
        >
          Ask agent
          <Key>⌘↵</Key>
        </Button>
      </div>
    </form>
  );
}

export function RevisingStrip({
  agent,
  asked,
}: {
  agent: string;
  asked: { chips: readonly string[]; instruction: string | null };
}) {
  const what = askedText(asked);
  return (
    <p
      data-revising=""
      role="status"
      className="mt-3 flex items-start gap-2 rounded-btn border border-dashed border-agent/50 bg-surface px-3 py-2 text-13 text-agent [overflow-wrap:anywhere]"
    >
      <Icon icon={Loader2} size={15} className="mt-0.5 shrink-0 motion-safe:animate-spin" />
      <span className="min-w-0">
        <span className="font-semibold">{agent} is revising</span>
        {what ? <span> · {what}</span> : null}
      </span>
    </p>
  );
}

export function VersionSwitcher({
  n,
  of,
  onGo,
}: {
  n: number;
  of: number;
  onGo: (n: number) => void;
}) {
  const btn =
    'inline-flex size-8 items-center justify-center rounded-btn text-text-2 hov:bg-canvas disabled:opacity-40 foc:outline-2 foc:outline-focus';
  return (
    <span
      data-versions=""
      className="inline-flex items-center rounded-btn border border-line bg-surface"
      role="group"
      aria-label="Versions"
    >
      <button
        type="button"
        className={btn}
        disabled={n <= 1}
        aria-label="Previous version"
        aria-keyshortcuts="["
        onClick={() => onGo(n - 1)}
      >
        <Icon icon={ChevronLeft} size={15} />
      </button>
      <span className="px-1 text-13 font-semibold tabular-nums text-ink" data-version={n}>
        v{n} of {of}
      </span>
      <button
        type="button"
        className={btn}
        disabled={n >= of}
        aria-label="Next version"
        aria-keyshortcuts="]"
        onClick={() => onGo(n + 1)}
      >
        <Icon icon={ChevronRight} size={15} />
      </button>
    </span>
  );
}

/** The sentence of a version with what changed since the one before. */
export function DiffText({ parts }: { parts: DiffPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.op === 'same' ? (
          <span key={i}>{p.text}</span>
        ) : p.op === 'ins' ? (
          <ins
            key={i}
            data-diff="ins"
            className="rounded-sm bg-approve-bg text-approve-text underline decoration-approve-text/60 underline-offset-2"
          >
            <span className="sr-only">[added: </span>
            {p.text}
            <span className="sr-only">]</span>
          </ins>
        ) : (
          <del
            key={i}
            data-diff="del"
            className="rounded-sm bg-sendback-bg text-sendback line-through decoration-sendback/70"
          >
            <span className="sr-only">[removed: </span>
            {p.text}
            <span className="sr-only">]</span>
          </del>
        ),
      )}
    </>
  );
}
