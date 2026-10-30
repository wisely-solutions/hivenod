import { Link } from '@tanstack/react-router';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Logo } from '../components/Logo';
import { GITHUB_LINKS, GITHUB_URL, PRIVACY_EMAIL } from '../lib/flags';
import './landing.css';
import decision1860 from './shots/decision-1860.webp';
import decision930 from './shots/decision-930.webp';
import decisionPhone250 from './shots/decision-phone-250.webp';
import decisionPhone500 from './shots/decision-phone-500.webp';
import thread1280 from './shots/thread-1280.webp';
import thread640 from './shots/thread-640.webp';
import today1860 from './shots/today-1860.webp';
import today930 from './shots/today-930.webp';
import todayPhone250 from './shots/today-phone-250.webp';
import todayPhone500 from './shots/today-phone-500.webp';
import { MESSAGE_SOURCES } from './sources';
import { formatStars, loadStars } from './stars';

// The signed-out first page at https://hivenod.com/: the two usages, Inbox (threads with decision
// pages) and Plans (steps with your approvals, incl. the Development plan); Projects and Calendar
// were removed (Inbox rules, slice 12). The screenshots are real, from demo data on the emulators:
// `pnpm shots:landing` remakes them. Without JavaScript, index.html's <noscript> shows the same
// two usages as plain text.

const INSTALL = 'curl -fsSL https://hivenod.com/install.sh | sh';
const DOCS_URL = `${GITHUB_URL}#readme`;
const SELF_HOST_URL = `${GITHUB_URL}/blob/main/docs/SELF-HOST.md`;

function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.23.48-2.7-1.07-2.7-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** "★ 1.2k" next to a GitHub link; nothing while the count is unknown or under 50. */
function StarCount({ shown }: { shown: string | null }) {
  if (!shown) return null;
  return (
    <span className="lp-cnt">
      <span aria-hidden>★ </span>
      {shown}
      <span className="sr-only"> stars</span>
    </span>
  );
}

type UsageId = 'inbox' | 'plans';
const USAGE_IDS: UsageId[] = ['inbox', 'plans'];
const usageFromHash = (): UsageId => (window.location.hash === '#plans' ? 'plans' : 'inbox');

function Nav({ stars, onUsage }: { stars: string | null; onUsage: (u: UsageId) => void }) {
  const go = (u: UsageId) => (e: MouseEvent) => {
    e.preventDefault();
    onUsage(u);
  };
  return (
    <header className="lp-nav">
      <nav aria-label="Main" className="lp-wrap lp-nav-in">
        <Link to="/" className="lp-logo" aria-label="Hivenod">
          <Logo size={28} />
          <span className="lp-word" aria-hidden>
            Hivenod
          </span>
        </Link>
        <div className="lp-links">
          <a href="#inbox" onClick={go('inbox')}>
            Inbox
          </a>
          <a href="#plans" onClick={go('plans')}>
            Plans
          </a>
          <a href="#how">How it works</a>
          {GITHUB_LINKS ? <a href={DOCS_URL}>Docs</a> : null}
        </div>
        <span className="lp-sp" />
        {GITHUB_LINKS ? (
          <a href={GITHUB_URL} className="lp-gh" data-testid="nav-github">
            <GitHubMark />
            <span className="lp-gh-label">Star on GitHub</span>
            <StarCount shown={stars} />
          </a>
        ) : null}
        <Link to="/signin" className="lp-btn lp-ghost lp-sm">
          Sign in
        </Link>
        <Link to="/signin" search={{ mode: 'create' }} className="lp-btn lp-primary lp-sm">
          Get started
        </Link>
      </nav>
    </header>
  );
}

/** Copies text to the clipboard; falls back to a selected textarea where the API is missing. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok: boolean;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function InstallLine() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(INSTALL);
    setState(ok ? 'copied' : 'failed');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2000);
  };
  return (
    <div className="lp-install">
      <code>
        <span className="lp-dollar" aria-hidden>
          ${' '}
        </span>
        {/* "| sh" stays with the URL when a phone wraps the line (plain spaces, so a manual
            selection still pastes into a shell) */}
        curl -fsSL <span className="lp-nowrap">https://hivenod.com/install.sh | sh</span>
      </code>
      <button type="button" className="lp-copy" onClick={() => void copy()}>
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      <span className="sr-only" role="status">
        {state === 'copied'
          ? 'Install command copied'
          : state === 'failed'
            ? 'Could not copy; select the command instead'
            : ''}
      </span>
    </div>
  );
}

function Browser({
  url,
  src,
  srcSet,
  sizes,
  width,
  height,
  alt,
}: {
  url: string;
  src: string;
  srcSet: string;
  sizes: string;
  width: number;
  height: number;
  alt: string;
}) {
  return (
    <div className="lp-browser">
      <div className="lp-bar" aria-hidden>
        <i />
        <i />
        <i />
        <span className="lp-url">{url}</span>
      </div>
      <img
        src={src}
        srcSet={srcSet}
        sizes={sizes}
        width={width}
        height={height}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

function Phone({ src, srcSet, alt }: { src: string; srcSet: string; alt: string }) {
  return (
    <div className="lp-phone">
      <img
        src={src}
        srcSet={srcSet}
        sizes="(max-width: 640px) 110px, 180px"
        width={250}
        height={541}
        alt={alt}
        loading="lazy"
        decoding="async"
      />
    </div>
  );
}

const STAGE_SIZES =
  '(min-width: 1180px) 760px, (min-width: 900px) calc(100vw - 420px), calc(100vw - 32px)';

const decisionAlt =
  'A decision page: Ship release 175? with the recommendation Approve, a short summary, before and after screenshots, a chart of check times, and the plan steps from Shape to Accept on live.';
const gateAlt =
  'On a phone: the decision page asks Ship release 175? with Approve, Ask for changes and Not now.';
const todayAlt =
  'Today: the morning brief, 4 decisions ranked with the urgent Q4 price list first, and the agents at work.';

function PlansTag() {
  return (
    <span className="lp-tag lp-t-plans">
      <span className="lp-ico" aria-hidden>
        ▦
      </span>
      Plans
    </span>
  );
}
function InboxTag() {
  return (
    <span className="lp-tag lp-t-inbox">
      <span className="lp-ico" aria-hidden>
        ✉
      </span>
      Inbox
    </span>
  );
}

function Sources() {
  return (
    <div className="lp-sources">
      <p className="lp-src-h">Your agents bring requests in from</p>
      <ul aria-label="Sources your agents can bring in">
        {MESSAGE_SOURCES.map((s) => (
          <li key={s.id} className="lp-src">
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

const USAGES: Record<
  UsageId,
  {
    tab: string;
    tag: ReactNode;
    title: string;
    text: string;
    points: ReactNode[];
    cta: string;
    view: ReactNode;
    extra?: ReactNode;
  }
> = {
  inbox: {
    tab: 'Inbox',
    tag: <InboxTag />,
    title: 'Agents answer it. You OK it.',
    text: 'Your agents bring in every request, rank it, and propose what to do: the reply, a hand-over, a tidy-up. Every thread has a decision page you can read in seconds. Nothing is sent without your OK.',
    points: [
      <>
        <b>A morning brief</b>: what came in, what needs you
      </>,
      <>
        <b>One decision at a time</b>, the proposal up front, with how sure the agent is
      </>,
      <>
        <b>Decision pages</b>: a short summary, the recommendation, charts and before and after
        screenshots
      </>,
    ],
    cta: 'Connect your inbox',
    extra: <Sources />,
    view: (
      <>
        <Browser
          url="hivenod.com/today"
          src={today930}
          srcSet={`${today930} 930w, ${today1860} 1860w`}
          sizes={STAGE_SIZES}
          width={930}
          height={581}
          alt={todayAlt}
        />
        <Phone
          src={todayPhone250}
          srcSet={`${todayPhone250} 250w, ${todayPhone500} 500w`}
          alt="On a phone: Today, the brief and the first decision, Create item for the Q4 price list."
        />
        <ul className="lp-callouts" aria-hidden>
          <li className="lp-callout lp-c1">
            <span className="lp-dot lp-o" />
            <span>3 tidy-ups, one tap</span>
          </li>
          <li className="lp-callout lp-c2">
            <span className="lp-dot lp-h" />
            <span>
              <b>4 need you</b> · 1 urgent
            </span>
          </li>
        </ul>
      </>
    ),
  },
  plans: {
    tab: 'Plans',
    tag: <PlansTag />,
    title: 'Agents build it. You approve it.',
    text: 'A thread can become a plan: steps for agents, and approvals for you. The Development plan runs Shape, Approve idea, Build, Keep green, Ship it?, Release with a live check, and Accept on live. Each step that needs a person waits for you.',
    points: [
      <>
        <b>Many agents per step</b>, across machines
      </>,
      <>
        <b>Checks kept green</b> before Ship it? asks you
      </>,
      <>
        <b>Ask for changes with a reason</b>; the agent reworks it
      </>,
    ],
    cta: 'Start a plan',
    view: (
      <>
        <Browser
          url="hivenod.com/inbox"
          src={decision930}
          srcSet={`${decision930} 930w, ${decision1860} 1860w`}
          sizes={STAGE_SIZES}
          width={930}
          height={581}
          alt={decisionAlt}
        />
        <Phone
          src={decisionPhone250}
          srcSet={`${decisionPhone250} 250w, ${decisionPhone500} 500w`}
          alt={gateAlt}
        />
        <ul className="lp-callouts" aria-hidden>
          <li className="lp-callout lp-c1">
            <span className="lp-dot" />
            <span>
              <b>Your agent</b> keeps the checks green
            </span>
          </li>
          <li className="lp-callout lp-c2">
            <span className="lp-dot lp-h" />
            <span>
              Waiting for <b>you</b> · Ship it?
            </span>
          </li>
        </ul>
      </>
    ),
  },
};

/** Inbox | Plans: ARIA tabs with arrow keys, Home and End. */
function Usages({ tab, setTab }: { tab: UsageId; setTab: (u: UsageId) => void }) {
  const refs = useRef<Record<UsageId, HTMLButtonElement | null>>({ inbox: null, plans: null });
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = USAGE_IDS.indexOf(tab);
    const n = USAGE_IDS.length;
    const next =
      e.key === 'ArrowRight'
        ? USAGE_IDS[(i + 1) % n]
        : e.key === 'ArrowLeft'
          ? USAGE_IDS[(i - 1 + n) % n]
          : e.key === 'Home'
            ? USAGE_IDS[0]
            : e.key === 'End'
              ? USAGE_IDS[n - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    refs.current[next]?.focus();
  };
  return (
    <div className="lp-usages" id="usages">
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus */}
      <div
        className="lp-tabs"
        role="tablist"
        aria-label="Two ways to use Hivenod"
        onKeyDown={onKey}
      >
        {USAGE_IDS.map((id) => (
          <button
            key={id}
            ref={(el) => {
              refs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={id}
            tabIndex={tab === id ? 0 : -1}
            className={`lp-tab lp-tab-${id}`}
            onClick={() => setTab(id)}
          >
            <span className="lp-ico" aria-hidden>
              {id === 'plans' ? '▦' : '✉'}
            </span>
            {USAGES[id].tab}
          </button>
        ))}
      </div>
      {USAGE_IDS.map((id) => {
        const u = USAGES[id];
        return (
          <div
            key={id}
            id={id}
            role="tabpanel"
            aria-labelledby={`tab-${id}`}
            hidden={tab !== id}
            className="lp-stage"
            data-usage={id}
          >
            <div className="lp-panel">
              {u.tag}
              <h2 className="lp-panel-h">{u.title}</h2>
              <p>{u.text}</p>
              <ul className={id === 'inbox' ? 'lp-bul lp-ag' : 'lp-bul'}>
                {u.points.map((p, i) => (
                  <li key={i}>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
              {u.extra}
              <Link to="/signin" search={{ mode: 'create' }} className="lp-btn lp-primary">
                {u.cta} <span aria-hidden>→</span>
              </Link>
            </div>
            <div className="lp-view">{u.view}</div>
          </div>
        );
      })}
    </div>
  );
}

const needs: Array<{
  who: string;
  color: string;
  title: string;
  sub: string;
  chip: string;
  kind: 'u' | 'g' | 'd';
}> = [
  {
    who: 'AB',
    color: '#a8432c',
    title: 'Sign off the Q4 price list',
    sub: 'Inbox · Make it work: create an item to review it',
    chip: 'Urgent · due Wed',
    kind: 'u',
  },
  {
    who: 'H',
    color: '#8a5d00',
    title: 'Pricing page rewrite',
    sub: 'Development plan · Hive shaped it · plan attached',
    chip: 'Approve idea',
    kind: 'g',
  },
  {
    who: 'SO',
    color: '#2f5fd0',
    title: 'Send the payments review numbers',
    sub: 'Inbox · Reply with the Q3 numbers',
    chip: 'Send',
    kind: 'd',
  },
  {
    who: 'T',
    color: '#17704a',
    title: 'Status page',
    sub: 'Development plan · checks 9 of 9 · live',
    chip: 'Accept on live',
    kind: 'g',
  },
  {
    who: 'ZP',
    color: '#7247c4',
    title: 'Agenda for the Northwind steering',
    sub: 'Inbox · Reply with a 4-point agenda',
    chip: 'Send',
    kind: 'd',
  },
];

function NeedsYou() {
  return (
    <section aria-labelledby="ny-h" className="lp-section">
      <div className="lp-wrap lp-nyg">
        <div>
          <p className="lp-eyebrow">One place to decide</p>
          <h2 id="ny-h">
            Every decision,
            <br />
            from every workspace.
          </h2>
          <p className="lp-sub">
            <b>Needs you</b> brings it all together: a pricing page waiting for approval, a reply
            ready to send, a release to ship. Approve a few at once, or send one back with a reason.
          </p>
          <ul className="lp-bul lp-mt">
            <li>
              <span>
                <b>Ranked by urgency</b>: deadlines first, tidy-ups last
              </span>
            </li>
            <li>
              <span>
                <b>Across all your organizations</b>, in one list
              </span>
            </li>
            <li>
              <span>
                <b>On your phone</b>, as on your desk
              </span>
            </li>
          </ul>
        </div>
        <figure className="lp-ny" aria-labelledby="ny-cap">
          <figcaption id="ny-cap" className="lp-ny-hd">
            Needs you <span className="lp-badge">5</span>
            <span className="lp-sp" />
            <span className="lp-ws">All workspaces</span>
          </figcaption>
          <ul aria-label="An example Needs you list">
            {needs.map((n) => (
              <li key={n.title} className="lp-ny-row">
                <span className="lp-av" style={{ background: n.color }} aria-hidden>
                  {n.who}
                </span>
                <span className="lp-ny-txt">
                  <span className="lp-ny-t">{n.title}</span>
                  <span className="lp-ny-s">{n.sub}</span>
                </span>
                <span className={`lp-chip lp-chip-${n.kind}`}>{n.chip}</span>
              </li>
            ))}
          </ul>
          <div className="lp-ny-ft" aria-hidden>
            <span className="lp-fake lp-fake-ok">✓ Approve 3</span>
            <span className="lp-fake">Send back…</span>
            <span className="lp-sp" />
            <span className="lp-fake">Undo</span>
          </div>
        </figure>
      </div>
    </section>
  );
}

function Day() {
  return (
    <section id="day" aria-labelledby="day-h" className="lp-section lp-top0">
      <div className="lp-wrap">
        <p className="lp-eyebrow">A day with Hivenod</p>
        <h2 id="day-h">
          Agents do the work all day.
          <br />
          You spend ten minutes deciding.
        </h2>
        <ol className="lp-timeline">
          <li className="lp-mom lp-mom-i">
            <span className="lp-time">08:30</span>
            <div>
              <InboxTag />
              <h3>Your morning brief</h3>
              <p>
                Overnight, 6 messages came in from mail, Teams, Jira and Telegram. Your agents
                drafted 3 proposals and asked 1 question, ranked by what is due first.
              </p>
              <p className="lp-you">
                You: <b>approve the replies</b> in two minutes
              </p>
            </div>
            <div className="lp-shot">
              <Browser
                url="hivenod.com/today"
                src={today930}
                srcSet={`${today930} 930w, ${today1860} 1860w`}
                sizes="(min-width: 900px) 600px, calc(100vw - 62px)"
                width={930}
                height={581}
                alt={todayAlt}
              />
            </div>
          </li>
          <li className="lp-mom">
            <span className="lp-time">10:15</span>
            <div>
              <PlansTag />
              <h3>A plan waits at your gate</h3>
              <p>
                Hive shaped the pricing page rewrite: the plan, the copy draft and the open
                questions. Nothing is built until you say go.
              </p>
              <p className="lp-you">
                You: <b>Approve idea</b>, one tap
              </p>
            </div>
            <div className="lp-shot">
              <Browser
                url="hivenod.com/inbox"
                src={decision930}
                srcSet={`${decision930} 930w, ${decision1860} 1860w`}
                sizes="(min-width: 900px) 600px, calc(100vw - 62px)"
                width={930}
                height={581}
                alt={decisionAlt}
              />
            </div>
          </li>
          <li className="lp-mom lp-mom-i">
            <span className="lp-time">13:00</span>
            <div>
              <InboxTag />
              <h3>A reply, drafted and checked</h3>
              <p>
                Sam asked for the payments review numbers. Your agent found them, checked with Rita
                and drafted the reply. Nothing is sent until you confirm.
              </p>
              <p className="lp-you">
                You: <b>Send</b>, one tap
              </p>
            </div>
            <div className="lp-shot">
              <Browser
                url="hivenod.com/inbox"
                src={thread640}
                srcSet={`${thread640} 640w, ${thread1280} 1280w`}
                sizes="(min-width: 900px) 600px, calc(100vw - 62px)"
                width={640}
                height={483}
                alt="A thread: Sam Okafor asks for the payments review numbers; the agent proposes a reply, with what it checked and what happens when you approve."
              />
            </div>
          </li>
          <li className="lp-mom lp-mom-ok">
            <span className="lp-time">17:40</span>
            <div>
              <PlansTag />
              <h3>Shipped, checked, live</h3>
              <p>
                Hive built the page, kept the checks green and released it, then checked it on
                production. It waits for your final look.
              </p>
              <p className="lp-you">
                You: <b>Accept</b>. Done.
              </p>
            </div>
            <ul className="lp-shipped" aria-label="What happened before it reached you">
              <li>
                <span className="lp-ck" aria-hidden>
                  ✓
                </span>
                Pull request merged · 14 files
              </li>
              <li>
                <span className="lp-ck" aria-hidden>
                  ✓
                </span>
                Status checks · 9 of 9
              </li>
              <li>
                <span className="lp-ck" aria-hidden>
                  ✓
                </span>
                Released to production
              </li>
              <li>
                <span className="lp-ck" aria-hidden>
                  ✓
                </span>
                Live check passed on production
              </li>
              <li>
                <span className="lp-dot lp-h" aria-hidden />
                <span>
                  <b>Waiting for you</b> · Accept on live
                </span>
              </li>
            </ul>
          </li>
        </ol>
      </div>
    </section>
  );
}

function How() {
  return (
    <section id="how" aria-labelledby="how-h" className="lp-section lp-top0">
      <div className="lp-wrap">
        <p className="lp-eyebrow">How it works</p>
        <h2 id="how-h">Connect your agent in one line.</h2>
        <p className="lp-sub">
          Hivenod runs the agents you already use, like Claude Code, through one CLI. Your agents
          work on your machines; Hivenod tells them what to do next and stops them at your gates.
        </p>
        <ol className="lp-three">
          <li className="lp-t">
            <span className="lp-n">01</span>
            <h3>Install and connect</h3>
            <p>
              One line installs the CLI. Confirm in the browser with one click and your agent is on
              Hivenod.
            </p>
            <div className="lp-mini lp-mono" aria-hidden>
              $ hivenod connect
              <br />
              <span className="lp-okt">✓ Connected as “Desk agent”</span>
            </div>
          </li>
          <li className="lp-t">
            <span className="lp-n">02</span>
            <h3>Give it a job</h3>
            <p>
              A thread to answer, or a plan to build. Run several agents per step, on as many
              machines as you like.
            </p>
            <div className="lp-mini lp-mono" aria-hidden>
              working 4 · waiting on you 2
              <br />
              status checks <span className="lp-okt">✓ 9 of 9</span>
            </div>
          </li>
          <li className="lp-t">
            <span className="lp-n">03</span>
            <h3>Decide in one place</h3>
            <p>
              <b>Needs you</b> collects every decision from every workspace: approvals, replies to
              send, releases to ship.
            </p>
            <div className="lp-mini lp-mono" aria-hidden>
              <b>Approve 3</b> · Send back… · Undo
            </div>
          </li>
        </ol>
      </div>
    </section>
  );
}

function Trust({ stars }: { stars: string | null }) {
  return (
    <section aria-labelledby="trust-h" className="lp-section lp-top0">
      <div className="lp-wrap">
        <p className="lp-eyebrow">Trust</p>
        <h2 id="trust-h">Your agents. Your calls. Your data.</h2>
        <ul className="lp-trust3">
          <li className="lp-tc">
            <span className="lp-big" aria-hidden>
              ✋
            </span>
            <h3>Nothing goes out without your OK</h3>
            <p>
              Agents draft the reply, the hand-over, the release. Sending and shipping wait for your
              approval, and every decision is logged.
            </p>
          </li>
          <li className="lp-tc">
            <span className="lp-big" aria-hidden>
              🔑
            </span>
            <h3>Your data stays yours</h3>
            <p>
              Agents run on your machines with their own scoped tokens. Use hivenod.com, or
              self-host on your own Firebase project.
            </p>
          </li>
          <li className="lp-tc">
            <span className="lp-big lp-mono" aria-hidden>
              ⟨/⟩
            </span>
            <h3>Open source, Apache-2.0</h3>
            <p>
              Read every line that touches your work. Hive, our own agent, builds Hivenod on
              Hivenod, in the open.
            </p>
          </li>
        </ul>
        <OpenSource stars={stars} />
      </div>
    </section>
  );
}

function OpenSource({ stars }: { stars: string | null }) {
  return (
    <section aria-labelledby="oss-h" className="lp-oss">
      <div>
        <p className="lp-eyebrow">Open source</p>
        <h2 id="oss-h">
          Built in the open.
          <br />
          Run it yourself.
        </h2>
        <p className="lp-sub">
          Apache-2.0. Use hivenod.com for free, or self-host on your own Firebase project. Star the
          repo to follow along.
        </p>
        {GITHUB_LINKS ? (
          <div className="lp-ctas lp-left">
            <a href={GITHUB_URL} className="lp-btn lp-primary" data-testid="band-github">
              <span aria-hidden>★ </span>Star on GitHub
            </a>
            <a href={SELF_HOST_URL} className="lp-btn lp-ghost">
              Self-host guide
            </a>
          </div>
        ) : null}
      </div>
      <div className="lp-repo">
        <p className="lp-rn">
          <GitHubMark size={22} />
          wisely-solutions / hivenod
        </p>
        <p className="lp-rd">
          Agents do the work, people make the decisions: on your inbox, with plans that stop at your
          approvals.
        </p>
        <p className="lp-meta">
          <span className="lp-lang">TypeScript · Go</span>
          {stars ? (
            <span>
              <span aria-hidden>★ </span>
              {stars}
              <span className="sr-only"> stars</span>
            </span>
          ) : null}
          <span>Apache-2.0</span>
        </p>
      </div>
    </section>
  );
}

export default function LandingPage() {
  const [stars, setStars] = useState<string | null>(null);
  const [tab, setTab] = useState<UsageId>(usageFromHash);
  useEffect(() => {
    let live = true;
    void loadStars().then((n) => live && setStars(formatStars(n)));
    const onHash = () => setTab(usageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      live = false;
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  /** The nav's Inbox and Plans links: pick that tab and bring it into view. */
  const showUsage = (u: UsageId) => {
    setTab(u);
    history.replaceState(null, '', `#${u}`);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document
      .getElementById('usages')
      ?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };
  return (
    <div className="lp">
      <Nav stars={stars} onUsage={showUsage} />
      <main>
        <div className="lp-hero">
          <div className="lp-glow" aria-hidden />
          <div className="lp-combs" aria-hidden />
          <div className="lp-wrap lp-hero-in">
            <p className="lp-pill">
              <span className="lp-new">New</span> Your inbox, run by your agents
            </p>
            <h1>
              Agents do the work.
              <br />
              <span className="lp-hl">You make the calls.</span>
            </h1>
            <p className="lp-lead">
              Put agents like Claude Code to work on your inbox and your plans. They bring messages
              in, propose what to do and stop at your gates. You decide from your desk or your
              phone.
            </p>
            <InstallLine />
            <div className="lp-ctas">
              <Link to="/signin" search={{ mode: 'create' }} className="lp-btn lp-primary">
                Get started, free <span aria-hidden>→</span>
              </Link>
              <a href="#how" className="lp-btn lp-ghost">
                See how it works
              </a>
            </div>
            <Usages tab={tab} setTab={setTab} />
          </div>
        </div>
        <NeedsYou />
        <Day />
        <How />
        <Trust stars={stars} />
      </main>
      <footer className="lp-footer">
        <div className="lp-wrap lp-foot-in">
          <span className="lp-foot-logo">
            <Logo size={22} />
            <span aria-hidden>Hivenod</span>
          </span>
          <span>© Hivenod</span>
          <span className="lp-sp" />
          {GITHUB_LINKS ? (
            <>
              <a href={GITHUB_URL} className="lp-gh lp-gh-foot" data-testid="footer-github">
                <GitHubMark />
                <span>GitHub</span>
                <StarCount shown={stars} />
              </a>
              <a href={DOCS_URL}>Docs</a>
              <a href={SELF_HOST_URL}>Self-host</a>
            </>
          ) : null}
          <Link to="/privacy">Privacy</Link>
          <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>
        </div>
      </footer>
    </div>
  );
}
