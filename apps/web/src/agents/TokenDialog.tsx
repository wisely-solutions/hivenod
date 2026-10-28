import { mcpConfigSnippet, tokenAsEnv } from '@hive/shared';
import { ChevronDown, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { CopyButton } from '../members/InviteModal';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';

/**
 * Shows an agent token once. It lives only in this component's props while the dialog is open.
 * Closing needs the box ticked, so it cannot be dismissed by accident (Esc, outside tap, drag).
 */
export function TokenDialog({
  name,
  token,
  rotated,
  onDone,
}: {
  name: string;
  token: string | null;
  rotated?: boolean;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [nudge, setNudge] = useState(false);
  const boxId = useId();
  const tokenId = useId();

  const finish = () => {
    setSaved(false);
    setNudge(false);
    onDone();
  };

  return (
    <ResponsiveModal
      open={token !== null}
      onOpenChange={(open) => {
        if (open) return;
        if (saved) finish();
        else setNudge(true);
      }}
      title={rotated ? `New token for ${name}` : `Token for ${name}`}
      description={
        rotated
          ? 'The old token stopped working. Give this one to the agent.'
          : 'Give this to the agent. It signs in with it.'
      }
      footer={
        <Button disabled={!saved} onClick={finish}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div
          role="alert"
          className="flex gap-2.5 rounded-card border border-gate/50 bg-gate-bg p-3 text-14 text-gate-text"
        >
          <Icon icon={TriangleAlert} className="mt-0.5 shrink-0" />
          <p>
            <strong className="font-semibold">You won’t see this again.</strong> Copy it now and
            keep it somewhere safe. Anyone with it can work as {name}.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={tokenId} className="text-13 font-medium text-ink">
            Agent token
          </label>
          <textarea
            id={tokenId}
            readOnly
            rows={4}
            value={token ?? ''}
            spellCheck={false}
            autoComplete="off"
            onFocus={(e) => e.currentTarget.select()}
            className={cn(
              'w-full resize-none break-all rounded-btn border border-line-strong bg-canvas p-3 font-mono text-13 text-ink',
              'foc:outline-2 foc:outline-offset-0 foc:outline-focus',
            )}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <CopyButton text={token ?? ''} label="Copy token" />
          <CopyButton text={token ? tokenAsEnv(token) : ''} label="Copy as env var" />
        </div>

        <details className="group rounded-card border border-line bg-surface">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3.5 text-14 font-medium text-ink foc:outline-2 foc:outline-focus [&::-webkit-details-marker]:hidden">
            Claude Code MCP config
            <Icon
              icon={ChevronDown}
              className="text-text-2 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="flex flex-col gap-3 border-t border-line p-3.5">
            <p className="text-13 text-text-2">
              Add this to your Claude Code MCP settings, and fix the path to the Hivenod agent CLI.
            </p>
            <textarea
              readOnly
              rows={8}
              aria-label="MCP config"
              spellCheck={false}
              value={token ? mcpConfigSnippet(token) : ''}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full resize-none rounded-btn bg-canvas p-3 font-mono text-12 text-ink foc:outline-2 foc:outline-focus"
            />
            <div>
              <CopyButton text={token ? mcpConfigSnippet(token) : ''} label="Copy config" />
            </div>
          </div>
        </details>

        <label
          htmlFor={boxId}
          className={cn(
            'flex min-h-11 cursor-pointer items-start gap-3 rounded-card border p-3 text-14 text-ink',
            nudge && !saved ? 'border-sendback' : 'border-line',
          )}
        >
          <input
            id={boxId}
            type="checkbox"
            checked={saved}
            onChange={(e) => {
              setSaved(e.target.checked);
              setNudge(false);
            }}
            aria-describedby={nudge && !saved ? `${boxId}-msg` : undefined}
            className="mt-0.5 size-5 shrink-0 accent-[var(--ink)]"
          />
          <span>
            I’ve saved this token somewhere safe
            {nudge && !saved ? (
              <span
                id={`${boxId}-msg`}
                role="status"
                className="mt-0.5 block text-13 text-sendback"
              >
                Tick this once you’ve saved it. You can’t get it back.
              </span>
            ) : null}
          </span>
        </label>
      </div>
    </ResponsiveModal>
  );
}
