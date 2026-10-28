import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ResponsiveModal } from '../components/ResponsiveModal';

export interface Shortcut {
  id: string;
  /** One key, or a short sequence such as ['g', 'n'] (press g, then n). */
  keys: string[];
  label: string;
  group: string;
  run: () => void;
}

const SEQUENCE_MS = 1000;

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

/** Controls that use Enter or Space themselves; a global shortcut must not steal those keys. */
export function isActivationTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.closest(
      'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"]',
    ) !== null
  );
}

/** Pure matcher: feed it key presses, it says which shortcut (if any) just completed. */
export function createMatcher(getShortcuts: () => Shortcut[], now: () => number = Date.now) {
  let pending: { key: string; at: number } | null = null;
  return function press(key: string): Shortcut | null {
    const k = key.length === 1 ? key.toLowerCase() : key;
    const list = getShortcuts();
    if (pending && now() - pending.at <= SEQUENCE_MS) {
      const first = pending.key;
      pending = null;
      const hit = list.find((s) => s.keys.length === 2 && s.keys[0] === first && s.keys[1] === k);
      if (hit) return hit;
    }
    pending = null;
    const single = list.find((s) => s.keys.length === 1 && s.keys[0] === k);
    if (single) return single;
    if (list.some((s) => s.keys.length === 2 && s.keys[0] === k)) pending = { key: k, at: now() };
    return null;
  };
}

interface Api {
  register: (s: Shortcut) => () => void;
  openSheet: () => void;
}
const Ctx = createContext<Api | null>(null);

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [all, setAll] = useState<Shortcut[]>([]);
  const [sheet, setSheet] = useState(false);

  const api = useMemo<Api>(
    () => ({
      register(s) {
        setAll((cur) => [...cur.filter((x) => x.id !== s.id), s]);
        return () => setAll((cur) => cur.filter((x) => x !== s));
      },
      openSheet: () => setSheet(true),
    }),
    [],
  );

  useEffect(() => {
    const matcher = createMatcher(() => all);
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      // Focus can still sit in a field of a dialog that is animating out; that is not typing.
      const inClosing = e.target instanceof Element && e.target.closest('[data-state="closed"]');
      if (!inClosing && isTypingTarget(e.target)) return;
      if ((e.key === 'Enter' || e.key === ' ') && isActivationTarget(e.target)) return;
      if (e.key === '?') {
        e.preventDefault();
        setSheet((s) => !s);
        return;
      }
      // Dialogs and sheets own the keyboard while open (Radix marks the page aria-hidden).
      // A dialog that is animating out (data-state=closed) no longer owns the keyboard.
      if (document.querySelector('[role="dialog"]:not([data-state="closed"])')) return;
      const hit = matcher(e.key);
      if (hit) {
        e.preventDefault();
        hit.run();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [all]);

  const groups = useMemo(
    () =>
      [...new Set(all.map((s) => s.group))].map((g) => ({
        group: g,
        items: all.filter((s) => s.group === g),
      })),
    [all],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <ResponsiveModal open={sheet} onOpenChange={setSheet} title="Keyboard shortcuts">
        <div className="flex flex-col gap-5 pb-2">
          <ShortcutGroup
            group="Anywhere"
            items={[
              { id: 'palette', keys: ['⌘/Ctrl + K'], label: 'Search and run commands' },
              { id: 'sheet', keys: ['?'], label: 'Show this sheet' },
              { id: 'esc', keys: ['Esc'], label: 'Close what is open' },
            ]}
          />
          <ShortcutGroup
            group="In a list"
            items={[
              { id: 'list-x', keys: ['x'], label: 'Select the highlighted row' },
              { id: 'list-sx', keys: ['Shift + X'], label: 'Select a range up to that row' },
              { id: 'list-j', keys: ['j'], label: 'Highlight the next row' },
              { id: 'list-k', keys: ['k'], label: 'Highlight the previous row' },
              { id: 'list-esc', keys: ['Esc'], label: 'Clear the selection' },
            ]}
          />
          {groups.map((g) => (
            <ShortcutGroup key={g.group} group={g.group} items={g.items} />
          ))}
        </div>
      </ResponsiveModal>
    </Ctx.Provider>
  );
}

function ShortcutGroup({
  group,
  items,
}: {
  group: string;
  items: { id: string; keys: string[]; label: string }[];
}) {
  return (
    <section aria-label={group}>
      <h3 className="mb-1 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
        {group}
      </h3>
      <ul className="divide-y divide-line">
        {items.map((s) => (
          <li key={s.id} className="flex min-h-11 items-center justify-between gap-3 text-14">
            <span>{s.label}</span>
            <span className="flex items-center gap-1">
              {s.keys.map((k, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 ? <span className="text-13 text-text-3">then</span> : null}
                  <kbd className="min-w-6 rounded-btn border border-line bg-canvas px-1.5 py-0.5 text-center font-mono text-13">
                    {k.length === 1 ? k.toUpperCase() : k === 'Escape' ? 'Esc' : k}
                  </kbd>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Registers a shortcut while the calling component is mounted (screens add their own). */
export function useShortcut(def: Omit<Shortcut, 'run'> & { run: () => void }) {
  const api = useContext(Ctx);
  if (!api) throw new Error('useShortcut needs <ShortcutsProvider>');
  const runRef = useRef(def.run);
  useEffect(() => {
    runRef.current = def.run;
  });
  const keysKey = def.keys.join('+');
  const { id, label, group } = def;
  useEffect(
    () => api.register({ id, label, group, keys: keysKey.split('+'), run: () => runRef.current() }),
    [api, id, label, group, keysKey],
  );
}

export function useShortcutSheet() {
  const api = useContext(Ctx);
  if (!api) throw new Error('useShortcutSheet needs <ShortcutsProvider>');
  return api.openSheet;
}
