import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNow } from '../activity/data';
import { useReady } from '../auth/context';
import { CopyButton } from '../members/InviteModal';
import { useShellData } from '../shell/data';
import { Segmented } from '../ui/form';
import { Icon } from '../ui/icon';
import { cliCommands } from './cli';
import { newlyConnected } from './confirm';
import { isOnline } from './logic';

const card = 'rounded-card border border-line bg-surface p-4 shadow-e1 sm:p-5';

/**
 * "Connect Claude Code" (item EJ2Cxq4k): one line, the same for everyone and safe to share. It
 * installs hivenod and runs `hivenod connect`, which opens the confirm page, sets up Claude Code
 * and starts it. This page watches for the agent this person connects and flips live to
 * "Connected", then shows when its Claude Code session is online.
 */
export function ConnectClaudeCode({ codeForm }: { codeForm: ReactNode }) {
  const { session } = useReady();
  const { agents, runs, projects } = useShellData();
  const [opened] = useState(() => Date.now());
  const now = useNow(15_000);
  const [os, setOs] = useState<'unix' | 'windows'>(() =>
    typeof navigator !== 'undefined' && /Win/.test(navigator.platform) ? 'windows' : 'unix',
  );
  const cmds = cliCommands(window.location.origin);
  const line = os === 'windows' ? cmds.installWindows : cmds.install;

  const agent = newlyConnected(agents, session.me.uid, opened);
  const online = agent ? isOnline(agent.data, runs, agent.id, now) : false;
  const ids = agent && Array.isArray(agent.data.projectIds) ? agent.data.projectIds : [];
  const first =
    projects.find((p) => ids.includes(p.id) && !p.data.archivedAt) ??
    projects.find((p) => !p.data.archivedAt);

  return (
    <section aria-labelledby="connect-title" className={card}>
      <h1 id="connect-title" className="text-20 font-semibold text-ink">
        Connect Claude Code
      </h1>
      <p className="mt-2 text-14 text-text-2">
        Run this line in a terminal on the machine where Claude Code runs. It installs hivenod, asks
        you to confirm here in the browser, sets up Claude Code and starts it with Hivenod.
      </p>
      <Segmented
        label="Operating system"
        className="mt-4"
        value={os}
        onValueChange={(v) => setOs(v as 'unix' | 'windows')}
        options={[
          { value: 'unix', label: 'macOS / Linux' },
          { value: 'windows', label: 'Windows' },
        ]}
      />
      <div className="mt-3 flex items-start gap-2">
        <code
          aria-label="Connect command"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-btn border border-line bg-canvas px-3 py-2.5 font-mono text-13 text-ink"
        >
          {line}
        </code>
        <CopyButton text={line} label="Copy" name="Copy: Connect command" />
      </div>
      <p className="mt-2 text-13 text-text-2">
        {os === 'windows' ? 'In PowerShell. ' : ''}The line holds no secret: the click in the
        browser is the approval.
      </p>

      <div
        role="status"
        className="mt-4 rounded-card border border-line bg-canvas px-3.5 py-3 text-14"
      >
        {agent ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="flex items-center gap-1.5 font-medium text-ink">
              <Icon icon={Check} size={16} /> Connected
            </span>
            <span className="text-text-2">
              {agent.data.name}
              {online ? ' · Claude Code is online' : ' · starting Claude Code…'}
            </span>
            {first ? (
              <Link
                to="/p/$pid"
                params={{ pid: first.id }}
                className="inline-flex min-h-11 items-center rounded-btn bg-ink px-4 text-14 font-medium text-surface foc:outline-2 foc:outline-offset-2 foc:outline-focus"
              >
                Add your first item
              </Link>
            ) : null}
          </div>
        ) : (
          <span className="text-text-2">Waiting for your terminal…</span>
        )}
      </div>

      <details className="mt-4 text-14">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-ink">
          The browser did not open? Enter the code
        </summary>
        {codeForm}
      </details>
    </section>
  );
}
