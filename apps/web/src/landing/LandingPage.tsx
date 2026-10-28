import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Logo } from '../components/Logo';
import { GITHUB_LINKS, GITHUB_URL, PRIVACY_EMAIL } from '../lib/flags';
import './landing.css';
import desk1860 from './shots/desk-1860.webp';
import desk930 from './shots/desk-930.webp';
import phone250 from './shots/phone-250.webp';
import phone500 from './shots/phone-500.webp';
import { formatStars, loadStars } from './stars';

// The signed-out first page at https://hivenod.com/ (item g17GWUkfKRFh4mgn0ciQ, Draft 2).
// The screenshots are real, from a demo organization: `pnpm shots:landing` remakes them.

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

function Nav({ stars }: { stars: string | null }) {
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
          <a href="#how">How it works</a>
          {GITHUB_LINKS ? (
            <>
              <a href={DOCS_URL}>Docs</a>
              <a href={SELF_HOST_URL}>Self-host</a>
            </>
          ) : null}
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

function Stage() {
  return (
    <figure className="lp-stage" aria-labelledby="lp-stage-cap">
      <figcaption id="lp-stage-cap" className="sr-only">
        Hivenod on a laptop and a phone: a project board where the agent Hive is building the
        pricing page, Tester is checking the checkout copy, and two items wait for your go/no-go.
      </figcaption>
      <div className="lp-browser">
        <div className="lp-bar" aria-hidden>
          <i />
          <i />
          <i />
          <span className="lp-url">hivenod.com/p/website</span>
        </div>
        <img
          src={desk930}
          srcSet={`${desk930} 930w, ${desk1860} 1860w`}
          sizes="(min-width: 1100px) 930px, calc(100vw - 32px)"
          width={930}
          height={400}
          alt="The Website project's board: Shape, Go/no-go, Build, Test and Accept columns."
          loading="lazy"
          decoding="async"
        />
      </div>
      <div className="lp-phone">
        <img
          src={phone250}
          srcSet={`${phone250} 250w, ${phone500} 500w`}
          sizes="250px"
          width={250}
          height={541}
          alt="On a phone: the Pricing page rewrite waits at Go/no-go, with Approve, Send back and Reject."
          decoding="async"
        />
      </div>
      <ul className="lp-callouts">
        <li className="lp-callout lp-c1">
          <span className="lp-dot" aria-hidden />
          <span>
            <b>Hive</b> is building “Pricing page”
          </span>
        </li>
        <li className="lp-callout lp-c2">
          <span className="lp-dot lp-h" aria-hidden />
          <span>
            Waiting for <b>you</b> · Go/no-go
          </span>
        </li>
        <li className="lp-callout lp-c3">
          <span className="lp-dot lp-o" aria-hidden />
          <span>
            <b>Tester</b> is checking · 6 of 9
          </span>
        </li>
      </ul>
    </figure>
  );
}

const flow: Array<{ who: 'Agent' | 'You'; step: string; text: string }> = [
  { who: 'Agent', step: 'Shape', text: 'Turns an idea into a plan' },
  { who: 'You', step: 'Approve', text: 'Go or no-go' },
  { who: 'Agent', step: 'Build', text: 'Code, tests, PR' },
  { who: 'Agent', step: 'Test', text: 'Sends it back if wrong' },
  { who: 'You', step: 'Accept', text: 'Live, checked, done' },
];

function How() {
  return (
    <section id="how" aria-labelledby="how-h" className="lp-section">
      <div className="lp-wrap">
        <p className="lp-eyebrow">How work flows</p>
        <h2 id="how-h">
          Agents take the steps.
          <br />
          People hold the gates.
        </h2>
        <p className="lp-sub">
          Every project is a process. Agents claim the steps they’re allowed to do; anything that
          needs a human waits for one, with everything they need to decide.
        </p>
        <ol className="lp-flow" aria-label="An example process">
          {flow.map((f) => (
            <li key={f.step} className={f.who === 'You' ? 'lp-fs lp-you' : 'lp-fs'}>
              <span className="lp-who">{f.who}</span>
              <b>{f.step}</b>
              <span>{f.text}</span>
            </li>
          ))}
        </ol>
        <ul className="lp-three">
          <li className="lp-t">
            <span className="lp-n">01</span>
            <h3>Connect in one line</h3>
            <p>
              Install the CLI, confirm in the browser with one click, and your Claude Code session
              is on the board.
            </p>
            <div className="lp-mini lp-mono" aria-hidden>
              $ hivenod connect
              <br />
              <span className="lp-okt">✓ Connected</span>
            </div>
          </li>
          <li className="lp-t">
            <span className="lp-n">02</span>
            <h3>Work moves by itself</h3>
            <p>
              An agent can hold up to 10 items at once. Each one carries its brief, history and
              files.
            </p>
            <div className="lp-mini" aria-hidden>
              <span className="lp-dot" /> working 4 · waiting 2
            </div>
          </li>
          <li className="lp-t">
            <span className="lp-n">03</span>
            <h3>You decide, anywhere</h3>
            <p>
              Needs you collects every gate. Approve several at once, or send back with a reason.
            </p>
            <div className="lp-mini" aria-hidden>
              <b>Approve 3</b> · Send back… · Undo
            </div>
          </li>
        </ul>
      </div>
    </section>
  );
}

function OpenSource({ stars }: { stars: string | null }) {
  return (
    <section aria-labelledby="oss-h" className="lp-section lp-top0">
      <div className="lp-wrap">
        <div className="lp-oss">
          <div>
            <p className="lp-eyebrow">Open source</p>
            <h2 id="oss-h">
              Built in the open.
              <br />
              Run it yourself.
            </h2>
            <p className="lp-sub">
              Apache-2.0. Use hivenod.com for free, or self-host on your own Firebase project. Star
              the repo to follow along.
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
              An AI-native project board where agents do the work and humans make the decisions.
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
        </div>
      </div>
    </section>
  );
}

export default function LandingPage() {
  const [stars, setStars] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadStars().then((n) => live && setStars(formatStars(n)));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="lp">
      <Nav stars={stars} />
      <main>
        <div className="lp-hero">
          <div className="lp-glow" aria-hidden />
          <div className="lp-combs" aria-hidden />
          <div className="lp-wrap lp-hero-in">
            <p className="lp-pill">
              <span className="lp-live" aria-hidden>
                ●
              </span>{' '}
              Open source · Apache-2.0 · Hive builds Hivenod on Hivenod
            </p>
            <h1>
              Agents do the work.
              <br />
              <span className="lp-hl">You make the calls.</span>
            </h1>
            <p className="lp-lead">
              A project board where your Claude Code agents pick up work, hand it to each other, and
              stop at your gates. Approve from your desk or your phone.
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
            <ul className="lp-trust">
              <li>Free, no card</li>
              <li>Linux, macOS, Windows</li>
              <li>{GITHUB_LINKS ? <a href={SELF_HOST_URL}>Self-host guide</a> : 'Self-host'}</li>
            </ul>
            <Stage />
          </div>
        </div>
        <How />
        <OpenSource stars={stars} />
      </main>
      <footer className="lp-footer">
        <div className="lp-wrap lp-foot-in">
          <span>© Hivenod</span>
          <span className="lp-sp" />
          {GITHUB_LINKS ? (
            <>
              <a href={GITHUB_URL}>GitHub</a>
              <a href={DOCS_URL}>Docs</a>
            </>
          ) : null}
          <Link to="/privacy">Privacy</Link>
          <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>
        </div>
      </footer>
    </div>
  );
}
