import { Command as CommandIcon, FolderKanban, Moon, Plus, Sun, Users } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { applyTheme, currentTheme } from '../theme';
import { Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { CommandPalette } from '../ui/command';
import { Icon } from '../ui/icon';
import { motion, MotionProvider, Reveal, tween, spring } from '../ui/motion';
import { ToastProvider, TooltipProvider, useToast } from '../ui/overlay';
import {
  AvatarsSection,
  BadgesSection,
  ButtonsSection,
  CardsSection,
  FeedbackSection,
  FormsSection,
  IconsSection,
  OverlaysSection,
  Section,
  Sub,
} from './Components';
import { SignatureSection } from './Signatures';

const NAV = [
  ['tokens', 'Tokens'],
  ['buttons', 'Buttons'],
  ['badges', 'Badges'],
  ['avatars', 'Avatars'],
  ['cards', 'Cards'],
  ['forms', 'Forms'],
  ['overlays', 'Overlays'],
  ['feedback', 'Feedback'],
  ['signature', 'Interactions'],
] as const;

const COLORS: Array<[string, string, string]> = [
  ['ink', 'Text and primary buttons', '--ink'],
  ['text-2', 'Secondary text', '--text-2'],
  ['text-3', 'Tertiary text', '--text-3'],
  ['surface', 'Cards and sheets', '--surface'],
  ['canvas', 'Page', '--canvas'],
  ['line', 'Dividers', '--line'],
  ['gate', 'Needs you (amber)', '--gate'],
  ['gate-bg', 'Gate background', '--gate-bg'],
  ['gate-text', 'Gate text', '--gate-text'],
  ['agent', 'Agent blue', '--agent'],
  ['agent-soft', 'Agent soft', '--agent-soft'],
  ['approve', 'Approve green', '--approve'],
  ['sendback', 'Send-back red', '--sendback'],
  ['sendback-border', 'Send-back border', '--sendback-border'],
];

function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => mo.disconnect();
}

/** Reads a CSS variable's resolved value, and updates when the theme flips. */
function useComputedToken(name: string): string {
  return useSyncExternalStore(
    subscribeTheme,
    () => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    () => '',
  );
}

function Swatch({ token, note, cssVar }: { token: string; note: string; cssVar: string }) {
  const value = useComputedToken(cssVar);
  return (
    <li className="flex items-center gap-3 rounded-card border border-line bg-surface p-2.5">
      <span
        aria-hidden
        className="size-11 shrink-0 rounded-btn border border-line"
        style={{ background: `var(${cssVar})` }}
      />
      <span className="min-w-0">
        <span className="block truncate text-13 font-medium text-ink">{token}</span>
        <span className="block truncate text-12 text-text-2">{value}</span>
        <span className="block truncate text-13 text-text-2">{note}</span>
      </span>
    </li>
  );
}

function TokensSection() {
  const [run, setRun] = useState(0);
  return (
    <Section
      id="tokens"
      eyebrow="Foundation"
      title="Tokens"
      intro="Colour, type, shape, elevation and motion. Everything below reads from CSS variables, in light and dark."
    >
      <Sub title="Colour">
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {COLORS.map(([t, n, v]) => (
            <Swatch key={t} token={t} note={n} cssVar={v} />
          ))}
        </ul>
      </Sub>
      <Sub title="Agent colours (8)">
        <ul className="flex flex-wrap gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <li
              key={i}
              className="grid size-11 place-items-center rounded-full text-13 font-semibold text-on-solid"
              style={{ background: `var(--agent-${i + 1})` }}
            >
              {i + 1}
            </li>
          ))}
        </ul>
      </Sub>
      <Sub title="Type: Geist and Geist Mono">
        <div className="flex flex-col gap-1.5 rounded-card border border-line bg-surface p-4">
          <p className="text-34 font-semibold tracking-tight">34 Agents do the work</p>
          <p className="text-28 font-semibold tracking-tight">28 You make the decisions</p>
          <p className="text-20 font-semibold">20 Needs you today</p>
          <p className="text-16">16 Body text for inputs and reading</p>
          <p className="text-14">14 Default interface text</p>
          <p className="text-13 text-text-2">13 Secondary text and captions</p>
          <Eyebrow>Mono 12 uppercase, tracking .08em</Eyebrow>
        </div>
      </Sub>
      <Sub title="Radius, spacing and elevation">
        <div className="flex flex-wrap items-end gap-4">
          {[
            ['7 buttons', 'rounded-btn'],
            ['12 cards', 'rounded-card'],
            ['16 panels', 'rounded-panel'],
            ['999 pills', 'rounded-full'],
          ].map(([l, c]) => (
            <div key={l} className="text-center">
              <div className={`mx-auto size-16 border border-line-strong bg-surface ${c}`} />
              <p className="mt-1 text-13 text-text-2">{l}</p>
            </div>
          ))}
          <div className="flex items-end gap-1" aria-label="4 pixel spacing grid">
            {[4, 8, 12, 16, 24, 32].map((n) => (
              <div key={n} className="text-center">
                <div className="bg-agent" style={{ width: n, height: n }} />
                <p className="mt-1 text-12 text-text-2">{n}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-4">
          {['e1', 'e2', 'e3'].map((e, i) => (
            <div
              key={e}
              className="grid h-20 place-items-center rounded-card border border-line bg-surface text-13 text-text-2"
              style={{ boxShadow: `var(--shadow-${i + 1})` }}
            >
              Level {i + 1}
            </div>
          ))}
        </div>
      </Sub>
      <Sub title="Motion tokens">
        <div className="rounded-card border border-line bg-surface p-4">
          <Button variant="secondary" onClick={() => setRun((r) => r + 1)} className="mb-4">
            Play (moves each dot across)
          </Button>
          <div className="flex flex-col gap-3 text-13">
            {[
              ['fast 120 ms', tween.fast],
              ['base 200 ms', tween.base],
              ['slow 320 ms', tween.slow],
              ['spring UI 500 / 40', spring.ui],
              ['spring sheet 260 / 26', spring.sheet],
            ].map(([label, tr]) => (
              <div key={label as string} className="flex items-center gap-3">
                <span className="w-40 shrink-0 text-text-2">{label as string}</span>
                <div
                  className={`flex h-6 flex-1 rounded-full bg-canvas ${run % 2 ? 'justify-end' : 'justify-start'}`}
                >
                  <motion.span
                    layout
                    className="size-6 rounded-full bg-ink"
                    transition={tr as never}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-13 text-text-2">
            Easing cubic-bezier(.2, .8, .2, 1). Only transform and opacity animate. With reduced
            motion, everything cross-fades.
          </p>
        </div>
      </Sub>
      <Sub title="Icons">
        <IconsSection />
      </Sub>
    </Section>
  );
}

function Inner() {
  const [theme, setTheme] = useState(currentTheme);
  const [palette, setPalette] = useState(false);
  const toast = useToast();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <main className="mx-auto w-full max-w-5xl px-4 pb-24 pt-[max(16px,env(safe-area-inset-top))]">
      <header className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div>
          <Eyebrow className="text-gate-text">Hivenod · Style guide</Eyebrow>
          <h1 className="mt-1">Design system</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => setPalette(true)}
            leading={<Icon icon={CommandIcon} />}
          >
            Command palette
          </Button>
          <Button
            variant="secondary"
            leading={<Icon icon={theme === 'dark' ? Sun : Moon} />}
            onClick={() => {
              applyTheme(next);
              setTheme(next);
            }}
          >
            Switch to {next} theme
          </Button>
        </div>
      </header>
      <p className="max-w-prose text-16 text-text-2">
        Every token and component, with all states, and the five signature interactions. Open this
        on your phone and try them.
      </p>
      <nav
        aria-label="Sections"
        className="sticky top-0 z-30 -mx-4 mt-4 flex gap-1 overflow-x-auto border-b border-line bg-canvas/95 px-4 backdrop-blur [scrollbar-width:none]"
      >
        {NAV.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="inline-flex min-h-11 shrink-0 items-center rounded-btn px-3 text-14 font-medium text-text-2 hover:text-ink foc:outline-2 foc:-outline-offset-2 foc:outline-focus"
          >
            {label}
          </a>
        ))}
      </nav>

      <Reveal>
        <TokensSection />
      </Reveal>
      <Section
        id="buttons"
        eyebrow="Components"
        title="Buttons"
        intro="Six variants, every state. Touch targets are 44 px."
      >
        <ButtonsSection />
      </Section>
      <Section id="badges" eyebrow="Components" title="Pills and badges">
        <BadgesSection />
      </Section>
      <Section
        id="avatars"
        eyebrow="Components"
        title="Avatars"
        intro="People have photos. Agents have an initial, a colour and a heartbeat while they work."
      >
        <AvatarsSection />
      </Section>
      <Section id="cards" eyebrow="Components" title="Cards">
        <CardsSection />
      </Section>
      <Section
        id="forms"
        eyebrow="Components"
        title="Forms, chips and tabs"
        intro="Inputs are 16 px so phones never zoom."
      >
        <FormsSection />
      </Section>
      <Section
        id="overlays"
        eyebrow="Components"
        title="Overlays"
        intro="Tooltip, popover, dialog, sheet and toast with undo."
      >
        <OverlaysSection />
        <div className="flex gap-2">
          <Button
            variant="ghost"
            leading={<Icon icon={Plus} />}
            onClick={() => toast.push({ message: 'Saved a note', duration: 3000 })}
          >
            Plain toast
          </Button>
        </div>
      </Section>
      <Section id="feedback" eyebrow="Components" title="Loading, empty and numbers">
        <FeedbackSection />
      </Section>
      <Section
        id="signature"
        eyebrow="Motion"
        title="Signature interactions"
        intro="Each one also works without gestures. With reduced motion on, they cross-fade."
      >
        <SignatureSection />
      </Section>

      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        items={[
          {
            id: 'p1',
            group: 'Projects',
            label: 'Content pipeline',
            icon: <Icon icon={FolderKanban} />,
            onSelect: () => toast.push({ message: 'Opened Content pipeline', duration: 2500 }),
          },
          {
            id: 'p2',
            group: 'Projects',
            label: 'Build a system',
            icon: <Icon icon={FolderKanban} />,
            onSelect: () => toast.push({ message: 'Opened Build a system', duration: 2500 }),
          },
          {
            id: 'a1',
            group: 'Agents',
            label: 'Research agent',
            icon: <Icon icon={Users} />,
            onSelect: () => toast.push({ message: 'Opened Research agent', duration: 2500 }),
          },
          {
            id: 'x1',
            group: 'Actions',
            label: 'New item',
            hint: 'N',
            icon: <Icon icon={Plus} />,
            onSelect: () => toast.push({ message: 'New item', duration: 2500 }),
          },
        ]}
      />
    </main>
  );
}

export default function KitPage() {
  return (
    <MotionProvider>
      <TooltipProvider>
        <ToastProvider>
          <Inner />
        </ToastProvider>
      </TooltipProvider>
    </MotionProvider>
  );
}
