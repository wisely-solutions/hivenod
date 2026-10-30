import { formatPairingCode, pairingPath, pairingTtlMs } from '@hive/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { deleteDoc, doc } from 'firebase/firestore';
import { Check, TerminalSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useShellData } from '../shell/data';
import { Button } from '../ui/button';
import { Input } from '../ui/form';
import { Icon } from '../ui/icon';
import { confirmConnectFlow, findConnect, type ConnectLookup } from './confirm';
import { ConnectClaudeCode } from './ConnectClaudeCode';
import { suggestedName } from './connect';
import { colorValue } from './logic';

type Found = Extract<ConnectLookup, { ok: true }>;

const card = 'rounded-card border border-line bg-surface p-4 shadow-e1 sm:p-5';

/**
 * The one-click confirm page for `hivenod connect` (item EJ2Cxq4k), like a device login: the
 * terminal opens /connect?code=…; a signed-in member sees which machine is asking and confirms it.
 * The token goes to the terminal sealed for its key; it is never shown. Projects were removed
 * (item OE8FmrTaIxFVGcaeGG3N, slice 10): the agent works on the member's Inbox, with no projects.
 */
export function ConfirmConnectPage() {
  const { session, actionContext, run } = useReady();
  const { loading } = useShellData();
  const navigate = useNavigate();
  const { code: linked } = useSearch({ strict: false }) as { code?: string };

  const [typed, setTyped] = useState('');
  const [lookup, setLookup] = useState<{
    code: string;
    result: ConnectLookup;
    at: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [done, setDone] = useState<{ name: string } | null>(null);
  const [declined, setDeclined] = useState(false);

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
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    setFormError(undefined);
    const name = suggestedName(found.pairing);
    try {
      await confirmConnectFlow(ctx, run, { name, color: colorValue(1), projectIds: [] }, found);
      setDone({ name });
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
          picks up the threads and plans of your Inbox.
        </p>
        <Link
          to="/inbox"
          className="mt-4 inline-flex min-h-11 items-center rounded-btn bg-ink px-4 text-14 font-medium text-surface foc:outline-2 foc:outline-offset-2 foc:outline-focus"
        >
          Open Inbox
        </Link>
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
    const title = 'Connect this Claude Code?';
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
        <p className="mt-4 text-14 text-text-2">
          It will work on the threads and plans of your Inbox in {session.workspace.name}.
        </p>
        <p className="mt-3 text-13 text-text-2">
          Confirm only a request you started yourself. The token goes straight to that terminal;
          nobody sees it.
        </p>
        {formError ? (
          <p role="alert" className="mt-3 text-13 text-sendback">
            {formError}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button loading={busy} onClick={() => void confirm()}>
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
