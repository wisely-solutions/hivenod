import { Check, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { CopyButton } from '../members/InviteModal';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { CLAUDE_INSTALL_DOCS, cliCommands, SESSION_COMMANDS, TROUBLESHOOTING } from './cli';

export const CONNECT_STEPS = ['Install', 'Pair', 'Plugin', 'Start'] as const;
export type ConnectStep = 0 | 1 | 2 | 3;

function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className="mt-2 flex items-start gap-2">
      <code
        aria-label={label}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-btn border border-line bg-canvas px-3 py-2.5 font-mono text-13 text-ink"
      >
        {text}
      </code>
      <CopyButton text={text} label="Copy" name={`Copy: ${label}`} />
    </div>
  );
}

function ExtLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-medium text-ink underline underline-offset-4"
    >
      {children} <Icon icon={ExternalLink} size={12} />
    </a>
  );
}

/** The step pills; earlier steps can be revisited. */
function Pills({ step, onStep }: { step: ConnectStep; onStep: (s: ConnectStep) => void }) {
  return (
    <ol aria-label="Setup steps" className="m-0 flex list-none flex-wrap gap-2 p-0">
      {CONNECT_STEPS.map((name, i) => (
        <li key={name}>
          <button
            type="button"
            aria-current={i === step ? 'step' : undefined}
            disabled={i > step}
            onClick={() => onStep(i as ConnectStep)}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-13 font-medium',
              'foc:outline-2 foc:outline-offset-2 foc:outline-focus',
              i === step && 'border-ink bg-ink text-surface',
              i < step && 'border-line-strong bg-surface text-text-2',
              i > step && 'border-line bg-canvas text-text-3',
            )}
          >
            {i < step ? <Icon icon={Check} size={12} /> : <span>{i + 1}</span>}
            {name}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Fixes for the usual snags. */
function Troubleshooting() {
  return (
    <details className="rounded-card border border-line px-3.5 py-2.5">
      <summary className="min-h-6 cursor-pointer text-13 font-medium text-ink">
        Troubleshooting
      </summary>
      <ul className="mt-2 flex list-none flex-col gap-2 p-0 text-13 text-text-2">
        {TROUBLESHOOTING.map((t) => (
          <li key={t.problem}>
            <span className="font-medium text-ink">{t.problem}.</span> <span>{t.fix}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Connect an agent (cards ZICf9zFE, Ul32d6Ee): one guide, four steps, one at a time. Install the
 * CLI, Pair the machine (the code field), add the plugin, start the Claude Code session. Each
 * command has a Copy button. `pair` is what the Pair step adds under the command (the code field).
 * Shown in the New agent dialog, in the Agents empty state and after pairing; the owner holds `step`.
 */
export function ConnectGuide({
  step,
  onStep,
  pair,
  origin = window.location.origin,
}: {
  step: ConnectStep;
  onStep: (s: ConnectStep) => void;
  pair?: ReactNode;
  origin?: string;
}) {
  const c = cliCommands(origin);
  const s = SESSION_COMMANDS;
  return (
    <div className="flex min-w-0 flex-col gap-4 text-14 text-ink">
      <Pills step={step} onStep={onStep} />
      {step === 0 ? (
        <section aria-label="Install" className="min-w-0">
          <p className="font-medium">Install the Hivenod CLI</p>
          <p className="text-13 text-text-2">
            Run this once on the machine the agent will use (Linux or macOS). It installs one
            program and checks its checksum. You also need Claude Code installed and logged in (
            <ExtLink href={CLAUDE_INSTALL_DOCS}>install guide</ExtLink>).
          </p>
          <Command text={c.install} label="Install command" />
          <p className="mt-2 text-13 text-text-2">On Windows, in PowerShell:</p>
          <Command text={c.installWindows} label="Windows install command" />
          <p className="mt-2 text-13 text-text-2">
            Check: <code className="font-mono">{c.check}</code>
          </p>
        </section>
      ) : null}
      {step === 1 ? (
        <section aria-label="Pair" className="min-w-0">
          <p className="font-medium">Pair it</p>
          <p className="text-13 text-text-2">Pair the machine with Hivenod:</p>
          <Command text={s.pair} label="Pair command" />
          <p className="mt-2 text-13 text-text-2">
            It shows a code like <span className="font-mono">K7QX-29PD</span>. Enter it here.
          </p>
          {pair}
        </section>
      ) : null}
      {step === 2 ? (
        <section aria-label="Plugin" className="min-w-0">
          <p className="font-medium">Add the Hivenod plugin</p>
          <p className="text-13 text-text-2">
            It lets a Claude Code session receive Hivenod’s work. Needs access to the Hivenod
            repository.
          </p>
          <Command text={s.marketplace} label="Marketplace command" />
          <Command text={s.plugin} label="Plugin command" />
        </section>
      ) : null}
      {step === 3 ? (
        <section aria-label="Start" className="min-w-0">
          <p className="font-medium">Start the session</p>
          <p className="text-13 text-text-2">
            In the folder the agent should work in. Confirm “I am using this for local development”:
            the flag is needed until Hivenod is on Claude Code’s approved channels list.
          </p>
          <Command text={s.start} label="Start command" />
          <p className="mt-2 text-13 text-text-2">
            Hivenod hands the session its work one item at a time, and pushes in people’s notes,
            answers and Stop work. It shows online while the session runs; work waits while it is
            closed. One live session per agent.
          </p>
          <p className="mt-2 text-13 text-text-2">
            Already run other channel sessions? Give this one its own Claude config first:{' '}
            <code className="font-mono break-all">{s.separateConfig}</code>
          </p>
        </section>
      ) : null}
      <Troubleshooting />
    </div>
  );
}
