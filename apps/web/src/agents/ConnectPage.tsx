import { cliLabel, formatPairingCode, normalizePairingCode } from '@hive/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Check, TerminalSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useReady } from '../auth/context';
import { PageHeader } from '../pages/Chrome';
import { Button } from '../ui/button';
import { Input } from '../ui/form';
import { Icon } from '../ui/icon';
import { useToast } from '../ui/overlay';
import { ConnectGuide, type ConnectStep } from './CliSetup';
import { connectTerminalFlow, findPairing, suggestedName, type Lookup } from './connect';
import {
  AgentFields,
  agentScopeInput,
  validateAgentFields,
  type AgentFieldErrors,
  type AgentFieldsValue,
} from './NewAgentModal';
import { colorValue } from './logic';

type Found = Extract<Lookup, { ok: true }>;

const LAST: ConnectStep = 3;

/**
 * Connect an agent (item 85RBnmoc): a four-step page, Install, Pair, Plugin, Start, with Back and
 * Next and a live status. The Pair step takes the code `hivenod pair` prints (the link it prints
 * opens this page with the code filled in), shows which terminal is waiting, asks for the agent's
 * name and projects, and pairs. The token is handed to the terminal directly; it is never shown.
 */
export function ConnectPage() {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const navigate = useNavigate();
  const { code: linked } = useSearch({ strict: false }) as { code?: string };

  const [step, setStep] = useState<ConnectStep>(linked ? 1 : 0);
  const [code, setCode] = useState(linked ?? '');
  const [error, setError] = useState<string | undefined>();
  const [seen, setSeen] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<AgentFieldsValue>({
    name: '',
    color: 1,
    // A terminal gets only the projects the admin ticks, unless they choose all.
    scope: 'some',
    chosen: [],
  });
  const [errors, setErrors] = useState<AgentFieldErrors>({});
  const [paired, setPaired] = useState<{ name: string; agentUid: string } | null>(null);

  // A new code from the link replaces what was typed.
  const [seeded, setSeeded] = useState(linked);
  if (linked !== seeded) {
    setSeeded(linked);
    setCode(linked ?? '');
    setError(undefined);
    if (linked) setStep(1);
  }

  // Waits for the code: once complete, looks the terminal up and shows its name.
  const normalized = normalizePairingCode(code);
  const found = seen && seen.code === normalized ? seen : null;
  useEffect(() => {
    if (step !== 1 || !normalized || paired) return;
    let live = true;
    void findPairing(normalized).then((r) => {
      if (!live) return;
      if (r.ok) {
        setSeen(r);
        setError(undefined);
        // A terminal suggests its own name ("Claude Code (laptop)"), once per code.
        setFields((f) => (f.name ? f : { ...f, name: suggestedName(r.pairing) }));
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [step, normalized, paired]);

  if (!session.isAdmin) {
    return (
      <>
        <PageHeader title="Connect an agent" />
        <p className="text-14 text-text-2">
          An admin pairs terminals with a code here. You can{' '}
          <Link to="/connect" className="font-medium text-ink underline underline-offset-4">
            connect Claude Code in one line
          </Link>{' '}
          yourself, for your projects.
        </p>
      </>
    );
  }

  async function pair() {
    if (!found) {
      setBusy(true);
      setError(undefined);
      const r = await findPairing(code);
      setBusy(false);
      if (r.ok) {
        setSeen(r);
        setFields((f) => (f.name ? f : { ...f, name: suggestedName(r.pairing) }));
      } else setError(r.error);
      return;
    }
    const next = validateAgentFields(fields);
    setErrors(next);
    if (next.name || next.projects) return;
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    try {
      const name = fields.name.trim();
      const { agentUid } = await connectTerminalFlow(
        ctx,
        run,
        {
          name,
          color: colorValue(fields.color),
          ...agentScopeInput(fields),
        },
        found,
      );
      setPaired({ name, agentUid });
      setStep(2);
    } catch {
      setErrors({
        form: 'Could not connect the terminal. The code may have expired: run the command again for a new one.',
      });
    } finally {
      setBusy(false);
    }
  }

  function done() {
    if (!paired) return;
    toast.push({ message: `${paired.name} is connected. Set its guardrails here.` });
    void navigate({ to: '/agents/$id', params: { id: paired.agentUid } });
  }

  const pairSlot = paired ? (
    <p className="mt-3 flex items-center gap-1.5 text-14 text-ink">
      <Icon icon={Check} size={14} /> This terminal is paired as{' '}
      <span className="font-medium">{paired.name}</span>.
    </p>
  ) : (
    <form
      className="mt-3 flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void pair();
      }}
    >
      <div>
        <Input
          label="Code from the terminal"
          placeholder="K7QX-29PD"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={12}
          className="font-mono uppercase"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={error}
        />
        <p aria-live="polite" className="mt-1.5 flex items-center gap-1.5 text-13 text-text-2">
          {found ? (
            <>
              <Icon icon={Check} size={14} />
              <span>
                Found <span className="font-medium text-ink">{suggestedName(found.pairing)}</span>
              </span>
            </>
          ) : error ? null : (
            'Waiting for the code…'
          )}
        </p>
      </div>
      {found ? (
        <>
          <div
            aria-label="Terminal waiting"
            role="group"
            className="flex items-start gap-3 rounded-card border border-line bg-agent-soft p-3.5 text-14"
          >
            <Icon icon={TerminalSquare} size={20} />
            <div className="min-w-0">
              <p className="font-medium text-ink">
                Code <span className="font-mono">{formatPairingCode(found.code)}</span>
              </p>
              <p className="break-words text-13 text-text-2">
                {cliLabel(found.pairing.cli)}
                {found.pairing.host ? ` on ${found.pairing.host}` : ''}
                {found.pairing.folder ? ` · folder ${found.pairing.folder}` : ''}
              </p>
              <p className="text-13 text-text-2">
                Check that this code is the one in your terminal. Pairing hands it the token
                directly; you never see it.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-5">
            <AgentFields value={fields} onChange={setFields} errors={errors} />
          </div>
          {errors.form ? (
            <p role="alert" className="text-13 text-sendback">
              {errors.form}
            </p>
          ) : null}
        </>
      ) : null}
    </form>
  );

  return (
    <div className="max-w-2xl">
      <Link
        to="/agents"
        className="mb-3 inline-flex min-h-11 items-center gap-1.5 text-13 font-medium text-text-2 underline-offset-4 hov:text-ink hov:underline"
      >
        <Icon icon={ArrowLeft} size={14} /> Agents
      </Link>
      <PageHeader
        title="Connect an agent"
        subtitle="Install, pair, then start a Claude Code session with the Hivenod plugin."
      />
      <p className="mb-4 text-14 text-text-2">
        Quickest:{' '}
        <Link
          to="/connect"
          className="inline-flex min-h-11 items-center font-medium text-ink underline underline-offset-4 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
        >
          Connect Claude Code in one line
        </Link>{' '}
        (any member, one click to confirm).
      </p>
      <p
        role="status"
        className="mb-4 flex items-center gap-1.5 rounded-card border border-line bg-surface px-3.5 py-2.5 text-14 text-ink"
      >
        {paired ? (
          <>
            <Icon icon={Check} size={14} /> Paired as{' '}
            <span className="font-medium">{paired.name}</span>
          </>
        ) : (
          <span className="text-text-2">Not paired yet</span>
        )}
      </p>
      <div className="rounded-card border border-line bg-surface p-4 shadow-e1 sm:p-5">
        <ConnectGuide step={step} onStep={setStep} pair={pairSlot} />
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            disabled={step === 0 || busy}
            onClick={() => setStep((step - 1) as ConnectStep)}
          >
            Back
          </Button>
          {step === 1 && !paired ? (
            <Button loading={busy} onClick={() => void pair()}>
              {found ? 'Pair this terminal' : 'Find terminal'}
            </Button>
          ) : step === LAST ? (
            <Button onClick={done} disabled={!paired}>
              Done
            </Button>
          ) : (
            <Button onClick={() => setStep((step + 1) as ConnectStep)}>
              Next: {['Pair', 'Plugin', 'Start'][step]}
            </Button>
          )}
        </div>
      </div>
      <p className="mt-4 text-13 text-text-2">
        Not using Claude Code?{' '}
        <Link
          to="/agents"
          search={{ token: 1 }}
          className="inline-flex min-h-11 items-center font-medium text-ink underline underline-offset-4 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
        >
          Advanced: plain MCP with a token
        </Link>
      </p>
    </div>
  );
}
