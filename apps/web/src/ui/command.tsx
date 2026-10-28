import { Command } from 'cmdk';
import { keepOpenOnToast } from './overlay';
import { Search } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog as RadixDialog } from 'radix-ui';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { matchReason, searchCommands } from './commandSearch';
import { Icon } from './icon';
import { Eyebrow } from './badge';
import { tween, useReducedMotion } from './motion';
import { useReturnFocus } from './overlay';

export interface CommandItem {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  hint?: string;
  /** Longer text the query also matches (an item's description). */
  body?: string;
  /** Words that narrow results: project name, type, "waiting on me". */
  tags?: readonly string[];
  /** An item's type (ranks first when the query is that word). */
  type?: string;
  onSelect: () => void;
}

/** Cmd/Ctrl+K palette shell. Items are passed in; screens register their own later. */
export function CommandPalette({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
}) {
  const reduced = useReducedMotion();
  const returnFocus = useReturnFocus(open);
  const [query, setQuery] = useState('');
  const change = useCallback(
    (o: boolean) => {
      if (!o) setQuery('');
      onOpenChange(o);
    },
    [onOpenChange],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        change(!open);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, change]);

  const shown = useMemo(() => searchCommands(items, query), [items, query]);
  // Groups appear in the order of their best match.
  const groups = [...new Set(shown.map((i) => i.group))];

  return (
    <RadixDialog.Root open={open} onOpenChange={change}>
      <AnimatePresence>
        {open ? (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-40 bg-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tween.fast}
              />
            </RadixDialog.Overlay>
            <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
              <RadixDialog.Content
                asChild
                forceMount
                aria-describedby={undefined}
                onInteractOutside={keepOpenOnToast}
                onCloseAutoFocus={returnFocus}
              >
                <motion.div
                  className="pointer-events-auto w-full max-w-xl overflow-hidden rounded-panel border border-line bg-surface shadow-e3 outline-hidden"
                  initial={{ opacity: 0, y: reduced ? 0 : -8, scale: reduced ? 1 : 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={tween.fast}
                >
                  <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
                  <Command label="Command palette" loop shouldFilter={false}>
                    <div className="flex items-center gap-2 border-b border-line px-4">
                      <Icon icon={Search} className="text-text-3" />
                      <Command.Input
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Jump to a project, item or agent"
                        className="min-h-14 flex-1 bg-transparent text-16 text-ink outline-hidden placeholder:text-text-3"
                      />
                    </div>
                    <Command.List className="max-h-80 overflow-y-auto p-2">
                      <Command.Empty className="px-3 py-6 text-center text-14 text-text-2">
                        Nothing matches. Try another word.
                      </Command.Empty>
                      {groups.map((g) => (
                        <Command.Group
                          key={g}
                          heading={g}
                          className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-12 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-text-3"
                        >
                          {shown
                            .filter((i) => i.group === g)
                            .map((i) => (
                              <Command.Item
                                key={i.id}
                                value={`${i.label} ${i.group} ${i.id}`}
                                onSelect={() => {
                                  change(false);
                                  i.onSelect();
                                }}
                                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-btn px-3 text-14 text-ink data-[selected=true]:bg-canvas"
                              >
                                <span className="text-text-2">{i.icon}</span>
                                <span className="flex-1">{i.label}</span>
                                {matchReason(i, query) ? (
                                  <span className="text-12 text-text-2">
                                    {matchReason(i, query)}
                                  </span>
                                ) : null}
                                {i.hint ? <Eyebrow>{i.hint}</Eyebrow> : null}
                              </Command.Item>
                            ))}
                        </Command.Group>
                      ))}
                    </Command.List>
                  </Command>
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}
