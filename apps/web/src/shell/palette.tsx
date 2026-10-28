import { useNavigate } from '@tanstack/react-router';
import {
  Bot,
  FolderKanban,
  FolderPlus,
  ListPlus,
  Moon,
  Plus,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { useReady } from '../auth/context';
import { useCapture } from '../capture/CaptureProvider';
import { currentTheme, applyTheme } from '../theme';
import { CommandPalette, type CommandItem } from '../ui/command';
import { Icon } from '../ui/icon';
import { useShellData } from './data';
import { NAV } from './nav';
import { needsMyDecision } from './logic';
import { WAITING_ON_ME } from '../ui/commandSearch';

const ic = (g: LucideIcon): ReactNode => <Icon icon={g} />;

/** Builds everything the palette can jump to or run, from the data the shell already holds. */
export function usePaletteItems(): CommandItem[] {
  const navigate = useNavigate();
  const capture = useCapture();
  const { updateProfile } = useReady();
  const { projects, agents, items } = useShellData();
  const { session } = useReady();
  const uid = session.me.uid;

  return useMemo(() => {
    const out: CommandItem[] = [];
    out.push(
      {
        id: 'act:new-item',
        label: 'New item',
        group: 'Actions',
        icon: ic(ListPlus),
        hint: 'C',
        // The palette is still closing; the box opens once it has left (see `soon`).
        onSelect: () => void setTimeout(() => capture.open(), 250),
      },
      {
        id: 'act:new-project',
        label: 'New project',
        group: 'Actions',
        icon: ic(FolderPlus),
        onSelect: () => void navigate({ to: '/projects', search: { new: 1 } }),
      },
      {
        id: 'act:all-items',
        label: 'List all items',
        group: 'Actions',
        icon: ic(ListPlus),
        onSelect: () => void navigate({ to: '/items' }),
      },
      {
        // Done and archived items are not in the palette's index; point at where they are.
        id: 'act:closed-items',
        label: 'Done, stopped and archived items: open a project, then List > Done or Archived',
        group: 'Actions',
        icon: ic(ListPlus),
        tags: ['done', 'stopped', 'archived', 'closed', 'finished', 'rejected'],
        onSelect: () => void navigate({ to: '/projects' }),
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

    for (const p of projects) {
      if (p.data.archivedAt) continue;
      out.push({
        id: `project:${p.id}`,
        label: `${p.data.emoji} ${p.data.name}`.trim(),
        group: 'Projects',
        icon: ic(FolderKanban),
        onSelect: () => void navigate({ to: '/p/$pid', params: { pid: p.id } }),
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

    const byId = new Map(projects.map((p) => [p.id, p.data]));
    for (const [pid, rows] of Object.entries(items)) {
      const project = byId.get(pid);
      for (const it of rows) {
        out.push({
          id: `item:${pid}:${it.id}`,
          label: it.data.title,
          group: 'Items',
          icon: ic(ListPlus),
          hint: project?.name,
          body: it.data.summary.slice(0, 600),
          type: it.data.type,
          tags: [
            project?.name ?? '',
            it.data.type,
            it.data.status,
            ...(project && needsMyDecision(project, it.data, uid) ? [WAITING_ON_ME] : []),
          ],
          onSelect: () =>
            void navigate({ to: '/p/$pid', params: { pid }, search: { item: it.id } }),
        });
      }
    }
    return out;
  }, [projects, agents, items, navigate, capture, updateProfile, uid]);
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
