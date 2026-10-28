import { Link } from '@tanstack/react-router';
import { ArrowRight, Hand, ShieldCheck, Smartphone, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Logo } from '../components/Logo';
import { GITHUB_LINKS, GITHUB_URL } from '../lib/flags';
import { Badge, Eyebrow, Pill } from '../ui/badge';
import { Card } from '../ui/card';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { Reveal } from '../ui/motion';

const btn =
  'inline-flex whitespace-nowrap min-h-11 items-center justify-center gap-2 rounded-btn px-4 text-14 font-medium ' +
  'transition-colors duration-120 ease-standard foc:outline-2 foc:outline-offset-2 foc:outline-focus';
const primary = cn(btn, 'bg-ink text-surface hov:opacity-90');
const secondary = cn(btn, 'border border-line-strong bg-surface text-ink hov:bg-canvas');
const navLink = 'min-h-11 items-center px-2 text-14 text-text-2 hov:text-ink';

function Nav() {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/90 pt-[env(safe-area-inset-top)] backdrop-blur-sm">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-5xl items-center gap-1 px-4 py-2 sm:gap-2"
      >
        <Link to="/" className="mr-auto flex min-h-11 items-center gap-2.5" aria-label="Hivenod">
          <Logo size={28} />
          <span className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-gate-text">
            Hivenod
          </span>
        </Link>
        <a href="#how" className={cn(navLink, 'hidden sm:inline-flex')}>
          How it works
        </a>
        {GITHUB_LINKS ? (
          <a href={GITHUB_URL} className={cn(navLink, 'hidden sm:inline-flex')}>
            GitHub
          </a>
        ) : null}
        <Link to="/signin" className={cn(secondary, 'px-3')}>
          Sign in
        </Link>
        <Link to="/signin" search={{ mode: 'create' }} className={cn(primary, 'px-3')}>
          Get started
        </Link>
      </nav>
    </header>
  );
}

/** One column of the illustration: a title, who works it, and a card or two. */
function Column({
  title,
  who,
  tone,
  children,
}: {
  title: string;
  who: string;
  tone?: 'gate';
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-card border p-3',
        tone === 'gate' ? 'border-gate/60 bg-gate-bg' : 'border-line bg-surface',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Eyebrow className={tone === 'gate' ? 'text-gate-text' : undefined}>{title}</Eyebrow>
        <span className="text-12 text-text-2">{who}</span>
      </div>
      {children}
    </li>
  );
}

function Mini({
  title,
  type,
  note,
  accent,
}: {
  title: string;
  type: string;
  note?: ReactNode;
  accent?: 'agent' | 'gate';
}) {
  return (
    <div
      className={cn(
        'rounded-btn border border-line bg-canvas p-2.5',
        accent === 'agent' && 'border-l-[3px] border-l-agent',
        accent === 'gate' && 'border-l-[3px] border-l-gate bg-surface',
      )}
    >
      <Badge>{type}</Badge>
      <p className="mt-1.5 text-13 font-semibold leading-snug text-ink">{title}</p>
      {note ? <p className="mt-1 text-12 text-text-2">{note}</p> : null}
    </div>
  );
}

function BoardIllustration() {
  return (
    <div
      role="img"
      aria-label="A board with four columns: Ideas, Build by an agent, Test by an agent, and Approve by you. An agent is building one item, another has sent one back once, and a launch post waits for your approval."
    >
      <ul aria-hidden className="grid list-none grid-cols-2 gap-3 p-0 lg:grid-cols-4">
        <Column title="Ideas" who="3">
          <Mini type="idea" title="Pricing page copy" />
          <Mini type="bug" title="Fix invoice bug" />
        </Column>
        <Column title="Build" who="by an agent">
          <Mini
            type="task"
            title="Write the launch post"
            accent="agent"
            note="Your agent is working…"
          />
        </Column>
        <Column title="Test" who="by an agent">
          <Mini
            type="task"
            title="Invoice export"
            accent="agent"
            note="personal: sent back, 1 of 3"
          />
        </Column>
        <Column title="Approve" who="by you" tone="gate">
          <Mini
            type="post"
            title="Launch post"
            accent="gate"
            note={<Pill tone="gate">Waiting for you</Pill>}
          />
        </Column>
      </ul>
    </div>
  );
}

const steps: { icon: typeof Terminal; title: string; text: string }[] = [
  {
    icon: Terminal,
    title: 'Pair an agent',
    text: 'Connect your own Claude Code session to your organization with one command.',
  },
  {
    icon: Hand,
    title: 'Work flows',
    text: 'Items move step to step, agent to agent. An agent tests the last one’s work and can send it back.',
  },
  {
    icon: Smartphone,
    title: 'You decide',
    text: 'At your gates, approve or send back from your phone. Nothing ships without you.',
  },
];

/** The signed-out first page at https://hivenod.com/. */
export default function LandingPage() {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <Nav />
      <main>
        <section className="mx-auto max-w-5xl px-4 pb-10 pt-12 sm:pt-16">
          <Reveal>
            <Pill tone="approve" className="mb-5">
              <ShieldCheck size={14} aria-hidden /> Free and open source
            </Pill>
            <h1 className="max-w-3xl text-balance text-34 font-semibold sm:text-[44px] sm:leading-[1.08]">
              Agents do the work.
              <br />
              You make the decisions.
            </h1>
            <p className="mt-4 max-w-2xl text-16 text-text-2 sm:text-20">
              A project board where your Claude Code agents pick up work, hand it to each other, and
              stop at your gates for a decision.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link to="/signin" search={{ mode: 'create' }} className={primary}>
                Get started, free <Icon icon={ArrowRight} size={16} />
              </Link>
              <Link to="/signin" className={secondary}>
                Sign in
              </Link>
              {GITHUB_LINKS ? (
                <a href={GITHUB_URL} className={secondary}>
                  View on GitHub
                </a>
              ) : null}
            </div>
          </Reveal>
        </section>

        <section aria-label="The board" className="mx-auto max-w-5xl px-4 pb-14">
          <Reveal delay={0.08}>
            <BoardIllustration />
          </Reveal>
        </section>

        <section
          id="how"
          aria-labelledby="how-h"
          className="mx-auto max-w-5xl scroll-mt-20 px-4 pb-14"
        >
          <h2 id="how-h" className="text-28 font-semibold">
            How it works
          </h2>
          <ol className="mt-5 grid list-none gap-3 p-0 md:grid-cols-3">
            {steps.map((s, i) => (
              <li key={s.title}>
                <Card className="h-full">
                  <Eyebrow>Step {i + 1}</Eyebrow>
                  <h3 className="mt-2 flex items-center gap-2 text-16 font-semibold">
                    <Icon icon={s.icon} size={18} /> {s.title}
                  </h3>
                  <p className="mt-1.5 text-14 text-text-2">{s.text}</p>
                </Card>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="oss-h" className="mx-auto max-w-5xl px-4 pb-16">
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="min-w-0">
              <h2 id="oss-h" className="text-20 font-semibold">
                Open source
              </h2>
              <p className="mt-1 text-14 text-text-2">
                Apache-2.0. Run it yourself, or use it hosted at hivenod.com.
              </p>
            </div>
            {GITHUB_LINKS ? (
              <a href={GITHUB_URL} className={secondary}>
                GitHub
              </a>
            ) : null}
          </Card>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-4 pb-[max(16px,env(safe-area-inset-bottom))] text-13 text-text-2">
          <span>hivenod.com</span>
          {GITHUB_LINKS ? (
            <>
              <a
                href={GITHUB_URL}
                className="inline-flex min-h-11 items-center underline-offset-4 hov:underline"
              >
                GitHub
              </a>
              <a
                href={`${GITHUB_URL}#readme`}
                className="inline-flex min-h-11 items-center underline-offset-4 hov:underline"
              >
                Docs
              </a>
            </>
          ) : null}
          <Link
            to="/privacy"
            className="inline-flex min-h-11 items-center underline-offset-4 hov:underline"
          >
            Privacy
          </Link>
        </div>
      </footer>
    </div>
  );
}
