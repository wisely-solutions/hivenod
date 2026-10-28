import { formatPairingCode, pairingPath, pairingTtlMs } from '@hive/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { deleteDoc, doc } from 'firebase/firestore';
import { Check, TerminalSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useShellData } from '../shell/data';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input } from '../ui/form';
import { Icon } from '../ui/icon';
import {
  confirmConnectFlow,
  findConnect,
  initialChoice,
  maxConnectProjects,
  stepsLeftOut,
  type ConnectLookup,
} from './confirm';
import { ConnectClaudeCode } from './ConnectClaudeCode';
import { suggestedName } from './connect';
import { colorValue } from './logic';

type Found = Extract<ConnectLookup, { ok: true }>;

const card = 'rounded-card border border-line bg-surface p-4 shadow-e1 sm:p-5';

/**
 * The one-click confirm page for `hivenod connect` (item EJ2Cxq4k), like a device login: the
 * terminal opens /connect?code=…; a signed-in member sees which machine is asking and confirms it
 * for projects they are in. The token goes to the terminal sealed for its key; it is never shown.
 */
export function ConfirmConnectPage() {
  const { session, actionContext, run } = useReady();
  const { projects, loading } = useShellData();
  const navigate = useNavigate();
  const { code: linked } = useSearch({ strict: false }) as { code?: string };

  const [typed, setTyped] = useState('');
  const [lookup, setLookup] = useState<{
    code: string;
    result: ConnectLookup;
    at: number;
  } | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [done, setDone] = useState<{ name: string; projectIds: string[] } | null>(null);
  const [declined, setDeclined] = useState(false);

  const who = { uid: session.me.uid, isAdmin: session.isAdmin };
  const mine = projects.filter(
    (p) => !p.data.archivedAt && (session.isAdmin || p.data.memberUids.includes(session.me.uid)),
  );
  const max = maxConnectProjects(session.isAdmin);
  const chosen =
    picked ??
    initialChoice(
      mine.map((p) => p.id),
      session.isAdmin,
    );

  useEffect(() => {
    if (!linked) return;
    let live = true;
    void findConnect(linked).then((result) => {
      if (!live) return;
      // A `hivenod pair` code belongs on the admins' Connect page.
      if (!result.ok && result.pair)
        void navigate({
          to: '/agents/connect',
          search: { code: formatPairingCode(result.pair) },
          replace: true,
        });
      else setLookup({ code: linked, result, at: Date.now() });
    });
    return () => {
      live = false;
    };
  }, [linked, navigate]);

  const current = lookup && lookup.code === linked ? lookup.result : null;
  const found: Found | null = current?.ok ? current : null;

  async function confirm() {
    if (!found) return;
    if (chosen.length === 0) {
      setFormError('Pick at least one project.');
      return;
    }
    if (chosen.length > max) {
      setFormError(`Pick at most ${max} projects.`);
      return;
    }
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    setFormError(undefined);
    const name = suggestedName(found.pairing);
    try {
      await confirmConnectFlow(
        ctx,
        run,
        who,
        { name, color: colorValue(1), projectIds: chosen },
        found,
        mine,
      );
      setDone({ name, projectIds: chosen });
    } catch {
      // Expired or used in the meantime: look again so the page says which.
      const again = await findConnect(found.code);
      setFormError(
        !again.ok && again.error
          ? again.error
          : 'Could not connect this machine. Try again, or run hivenod connect again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    if (!found) return;
    setBusy(true);
    await deleteDoc(doc(db, pairingPath(found.code))).catch(() => undefined);
    setBusy(false);
    setDeclined(true);
  }

  let body;
  if (done) {
    const first = mine.find((p) => p.id === done.projectIds[0]);
    body = (
      <section aria-labelledby="connect-title" className={card}>
        <p role="status" className="flex items-center gap-1.5 text-14 font-medium text-ink">
          <Icon icon={Check} size={16} /> Connected
        </p>
        <h1 id="connect-title" className="mt-2 text-20 font-semibold text-ink">
          {done.name} is connected
        </h1>
        <p className="mt-2 text-14 text-text-2">
          Your terminal has its token now; you can close this page and go back to it. The agent
          picks up items at the agent steps of{' '}
          {done.projectIds.length === 1 && first ? first.data.name : 'the projects you chose'}.
        </p>
        {first ? (
          <Link
            to="/p/$pid"
            params={{ pid: first.id }}
            className="mt-4 inline-flex min-h-11 items-center rounded-btn bg-ink px-4 text-14 font-medium text-surface foc:outline-2 foc:outline-offset-2 foc:outline-focus"
          >
            Add your first item
          </Link>
        ) : null}
      </section>
    );
  } else if (declined) {
    body = (
      <section aria-labelledby="connect-title" className={card}>
        <h1 id="connect-title" className="text-20 font-semibold text-ink">
          Request declined
        </h1>
        <p className="mt-2 text-14 text-text-2">
          Nothing was connected. The terminal that asked stops waiting.
        </p>
      </section>
    );
  } else if (!linked || (current && !current.ok)) {
    const codeForm = (
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim())
            void navigate({ to: '/connect', search: { code: typed.trim().toUpperCase() } });
        }}
      >
        <Input
          label="Code from the terminal"
          placeholder="K7QX-29PD"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          className="font-mono uppercase"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <div>
          <Button type="submit" variant={linked ? 'primary' : 'secondary'}>
            Continue
          </Button>
        </div>
      </form>
    );
    body = !linked ? (
      <ConnectClaudeCode codeForm={codeForm} />
    ) : (
      <section aria-labelledby="connect-title" className={card}>
        <h1 id="connect-title" className="text-20 font-semibold text-ink">
          Connect Claude Code
        </h1>
        <p className="mt-2 text-14 text-text-2">
          Enter the code <span className="font-mono">hivenod connect</span> shows in your terminal.
        </p>
        {current && !current.ok ? (
          <p role="alert" className="mt-3 text-14 text-sendback">
            {current.error}
          </p>
        ) : null}
        {codeForm}
      </section>
    );
  } else if (!found || loading) {
    body = (
      <section aria-labelledby="connect-title" aria-busy="true" className={card}>
        <h1 id="connect-title" className="text-20 font-semibold text-ink">
          Connect Claude Code
        </h1>
        <p className="mt-2 text-14 text-text-2">Looking up the request…</p>
      </section>
    );
  } else {
    const p = found.pairing;
    const minutesLeft = Math.max(
      1,
      Math.ceil((p.createdAt.toMillis() + pairingTtlMs(p) - (lookup?.at ?? 0)) / 60_000),
    );
    const only = mine.length === 1 ? mine[0] : null;
    const left = stepsLeftOut(
      who,
      mine.filter((x) => chosen.includes(x.id)),
    );
    const title = only
      ? `Connect this Claude Code to ${only.data.name}?`
      : 'Connect this Claude Code to your projects?';
    body = (
      <section aria-labelledby="connect-title" className={card}>
        <h1 id="connect-title" className="text-20 font-semibold text-ink">
          {title}
        </h1>
        <div
          role="group"
          aria-label="Machine asking"
          className="mt-4 flex items-start gap-3 rounded-card border border-line bg-agent-soft p-3.5 text-14"
        >
          <Icon icon={TerminalSquare} size={20} />
          <div className="min-w-0">
            <p className="break-words font-medium text-ink">{suggestedName(p)}</p>
            <p className="break-words text-13 text-text-2">
              {p.host ? `Machine ${p.host}` : 'A machine with no name'}
              {p.folder ? ` · folder ${p.folder}` : ''}
            </p>
            <p className="text-13 text-text-2">
              Code <span className="font-mono text-ink">{formatPairingCode(found.code)}</span>:
              check that your terminal shows the same. Expires in {minutesLeft} min.
            </p>
          </div>
        </div>
        {mine.length === 0 ? (
          <p className="mt-4 text-14 text-text-2">
            You are not in any project of {session.workspace.name} yet. Ask an admin to add you to
            one, or{' '}
            <Link to="/projects" search={{ new: 1 }} className="font-medium text-ink underline">
              create a project
            </Link>
            .
          </p>
        ) : only ? (
          <p className="mt-4 text-14 text-text-2">
            It will work on the agent steps of{' '}
            <span className="font-medium text-ink">
              {only.data.emoji} {only.data.name}
            </span>
            .
          </p>
        ) : (
          <fieldset className="mt-4 flex flex-col rounded-card border border-line">
            <legend className="mb-1.5 text-13 font-medium text-ink">
              Projects it will work on{mine.length > max ? ` (up to ${max})` : ''}
            </legend>
            {mine.map((x, i) => (
              <label
                key={x.id}
                className={cn(
                  'flex min-h-11 cursor-pointer items-center gap-3 px-3.5 text-14 text-ink',
                  i > 0 && 'border-t border-line',
                )}
              >
                <input
                  type="checkbox"
                  className="size-5 accent-[var(--ink)]"
                  checked={chosen.includes(x.id)}
                  onChange={(e) =>
                    setPicked(
                      e.target.checked ? [...chosen, x.id] : chosen.filter((c) => c !== x.id),
                    )
                  }
                />
                <span aria-hidden>{x.data.emoji}</span>
                <span className="truncate">{x.data.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        <p className="mt-3 text-13 text-text-2">
          Confirm only a request you started yourself. The token goes straight to that terminal;
          nobody sees it.
          {left > 0
            ? ` ${left} agent ${left === 1 ? 'step is' : 'steps are'} limited to other agents; an admin can add this one in the process editor.`
            : ''}
        </p>
        {formError ? (
          <p role="alert" className="mt-3 text-13 text-sendback">
            {formError}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button loading={busy} disabled={mine.length === 0} onClick={() => void confirm()}>
            Connect
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void decline()}>
            Decline
          </Button>
        </div>
      </section>
    );
  }

  return <div className="mx-auto max-w-lg py-2">{body}</div>;
}
