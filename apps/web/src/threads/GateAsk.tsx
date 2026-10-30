/**
 * Ask for changes on a gate (item OE8FmrTaIxFVGcaeGG3N, slice 6, design 6.5): the text box under
 * a person step's buttons. Sending it moves the plan back to an earlier agent step (the
 * template's target for this gate, or one the member picks), which the agent carries out again
 * with the text. The third send back leaves the plan blocked for the member.
 */
import { INBOX_LIMITS, MAX_PLAN_SEND_BACKS } from '@hive/shared';
import { Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Select, Textarea } from '../ui/form';
import { Icon } from '../ui/icon';

const MAX = INBOX_LIMITS.reason;

export function GateAsk({
  choices,
  target,
  sentBefore,
  agent,
  busy,
  onCancel,
  onSend,
}: {
  choices: readonly { index: number; label: string }[];
  target: number;
  /** Send backs of this plan so far. */
  sentBefore: number;
  agent: string;
  busy?: boolean;
  onCancel: () => void;
  onSend: (reason: string, toStep: number) => void;
}) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  // Opened from Ask for changes (or C): the cursor goes to the text.
  useEffect(() => box.current?.focus(), []);
  const [to, setTo] = useState(String(target));
  const can = text.trim() !== '' && text.trim().length <= MAX;
  const last = sentBefore + 1 >= MAX_PLAN_SEND_BACKS;
  return (
    <form
      data-gate-ask=""
      aria-label="Ask for changes"
      className="mt-3 rounded-card border border-sendback/40 bg-surface p-3.5 shadow-e1 sm:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (can && !busy) onSend(text.trim(), Number(to));
      }}
    >
      <Textarea
        label="What should change?"
        ref={box}
        rows={2}
        value={text}
        maxLength={MAX + 50}
        error={text.length > MAX ? `At most ${MAX} characters.` : undefined}
        placeholder="The button is too small on the phone"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (can && !busy) onSend(text.trim(), Number(to));
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {choices.length > 1 ? (
        <div className="mt-3">
          <Select
            label="Send back to"
            value={to}
            onValueChange={setTo}
            options={choices.map((c) => ({ value: String(c.index), label: c.label }))}
          />
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <p data-gate-ask-hint="" className="min-w-0 flex-1 text-12 text-text-2 max-sm:basis-full">
          {last
            ? `This is send back ${sentBefore + 1} of ${MAX_PLAN_SEND_BACKS}: the plan then waits for you before ${agent} goes on.`
            : `${agent} does ${choices.find((c) => String(c.index) === to)?.label ?? 'that step'} again with your text; the steps after it run again.`}
        </p>
        <Button type="button" variant="ghost" onClick={onCancel} className="max-sm:flex-1">
          Cancel
        </Button>
        <Button
          type="submit"
          variant="sendback"
          data-gate-send-back=""
          loading={busy}
          disabled={!can}
          className="max-sm:flex-[2]"
          leading={<Icon icon={Undo2} size={15} />}
        >
          Send back
        </Button>
      </div>
    </form>
  );
}
