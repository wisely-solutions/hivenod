import { useNavigate } from '@tanstack/react-router';
import { Bot, MessageSquarePlus, Moon, Plus, Sun, type LucideIcon } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useReady } from '../auth/context';
import { useCapture } from '../capture/CaptureProvider';
import { currentTheme, applyTheme } from '../theme';
import { CommandPalette, type CommandItem } from '../ui/command';
import { Icon } from '../ui/icon';
import { useShellData } from './data';
import { NAV } from './nav';

const ic = (g: LucideIcon): ReactNode => <Icon icon={g} />;

/** Builds everything the palette can jump to or run, from the data the shell already holds. */
export function usePaletteItems(): CommandItem[] {
  const navigate = useNavigate();
  const capture = useCapture();
  const { updateProfile } = useReady();
  const { agents } = useShellData();

  return useMemo(() => {
    const out: CommandItem[] = [];
    out.push(
      {
        id: 'act:new-thread',
        label: 'New thread',
        group: 'Actions',
        icon: ic(MessageSquarePlus),
        hint: 'C',
        // The palette is still closing; the dialog opens once it has left (see `soon`).
        onSelect: () => void setTimeout(() => capture.open(), 250),
      },
      {
        id: 'act:new-agent',
        label: 'Connect an agent',
        group: 'Actions',
        icon: ic(Plus),
        onSelect: () => void navigate({ to: '/agents/connect' }),
      },
      {
        id: 'act:theme',
        label: 'Toggle theme',
        group: 'Actions',
        icon: ic(currentTheme() === 'dark' ? Sun : Moon),
        onSelect: () => {
          const next = currentTheme() === 'dark' ? 'light' : 'dark';
          applyTheme(next);
          void updateProfile({ theme: next }).catch(() => undefined);
        },
      },
    );

    for (const n of NAV) {
      out.push({
        id: `go:${n.to}`,
        label: n.label,
        group: 'Go to',
        icon: ic(n.icon),
        hint: `G ${n.key.toUpperCase()}`,
        onSelect: () => void navigate({ to: n.to }),
      });
    }

    for (const a of agents) {
      if (a.data.revokedAt) continue;
      out.push({
        id: `agent:${a.id}`,
        label: a.data.name,
        group: 'Agents',
        icon: ic(Bot),
        onSelect: () => void navigate({ to: '/agents', search: { agent: a.id } }),
      });
    }

    return out;
  }, [agents, navigate, capture, updateProfile]);
}

export function ShellPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const items = usePaletteItems();
  return <CommandPalette open={open} onOpenChange={onOpenChange} items={items} />;
}
