/**
 * Not now (item OE8FmrTaIxFVGcaeGG3N, slice 3; design 3.2): the decision leaves Today until 09:00
 * the next day in the member's time zone; nothing else changes. The same action the notifier's
 * Not now button applies (notNowThread, keyed by what waits now: threadAsk).
 */
import { notNowThread, notNowUntil, type InboxThread, type ThreadAsk } from '@hive/shared';
import { Moon } from 'lucide-react';
import { useState } from 'react';
import { useReady } from '../auth/context';
import type { Row } from '../lib/live';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { useToast } from '../ui/overlay';
import { hhmm } from '../today/logic';
import { errorText } from './parts';

/** The member's time zone (the browser's). */
export const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function useNotNow(wid: string, thread: Row<InboxThread>, ask: ThreadAsk | null) {
  const { actionContext, run } = useReady();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function notNow(onDone?: () => void) {
    const ctx = actionContext(wid);
    if (!ctx || !ask || busy) return;
    setError(null);
    setBusy(true);
    try {
      const now = Date.now();
      const until = new Date(notNowUntil(now, localZone()));
      await run(
        notNowThread(ctx, {
          threadId: thread.id,
          thread: { ...thread.data },
          key: ask.key,
          until,
          nowMs: now,
        }),
      );
      toast.push({ message: `Not now: back on Today tomorrow at ${hhmm(until)}` });
      onDone?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return { notNow, busy, error, can: !!ask };
}

/** The Not now button (N on the decision page). */
export function NotNowButton({
  nn,
  onDone,
  className,
  keyHint,
}: {
  nn: ReturnType<typeof useNotNow>;
  onDone?: () => void;
  className?: string;
  keyHint?: React.ReactNode;
}) {
  if (!nn.can) return null;
  return (
    <Button
      variant="secondary"
      data-not-now=""
      className={cn(className)}
      loading={nn.busy}
      onClick={() => void nn.notNow(onDone)}
      leading={<Icon icon={Moon} size={15} />}
    >
      Not now
      {keyHint}
    </Button>
  );
}
