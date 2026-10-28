import { Check } from 'lucide-react';
import { useMemo } from 'react';
import { useReady } from '../auth/context';
import { PersonAvatar } from '../components/PersonAvatar';
import { displayName, useProfiles } from '../members/data';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';

/**
 * Everyone in the organization as a checklist: who may see a project. Admins always see every
 * project, so they are ticked and locked.
 */
export function PeoplePicker({
  value,
  onChange,
  label = 'People on this project',
}: {
  value: readonly string[];
  onChange: (uids: string[]) => void;
  label?: string;
}) {
  const { session } = useReady();
  const { workspace, workspaceId, me } = session;
  const uids = useMemo(() => Object.keys(workspace.memberRoles), [workspace.memberRoles]);
  const profiles = useProfiles(workspaceId, uids);
  const rows = uids
    .map((uid) => ({
      uid,
      admin: workspace.memberRoles[uid] === 'admin',
      name: displayName(profiles[uid], uid),
      profile: profiles[uid],
    }))
    .sort((a, b) => Number(b.admin) - Number(a.admin) || a.name.localeCompare(b.name));
  return (
    <ul aria-label={label} className="overflow-hidden rounded-card border border-line bg-surface">
      {rows.map(({ uid, admin, name, profile }, i) => {
        const on = admin || value.includes(uid);
        return (
          <li key={uid} className={cn(i > 0 && 'border-t border-line')}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={name}
              disabled={admin}
              onClick={() => onChange(on ? value.filter((u) => u !== uid) : [...value, uid])}
              className="flex min-h-12 w-full items-center gap-3 px-3 text-left hov:bg-canvas foc:outline-2 foc:-outline-offset-2 foc:outline-focus disabled:cursor-default disabled:hov:bg-transparent"
            >
              <PersonAvatar
                name={name}
                photoURL={profile?.photoURL}
                color={profile?.color ?? 'c8'}
                size="md"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-14 font-medium text-ink">
                  {name}
                  {uid === me.uid ? <span className="font-normal text-text-2"> (you)</span> : null}
                </span>
                {admin ? (
                  <span className="block text-13 text-text-2">Sees every project</span>
                ) : null}
              </span>
              {admin ? <Badge tone="gate">Admin</Badge> : null}
              <span
                aria-hidden
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-[6px] border',
                  on ? 'border-ink bg-ink text-surface' : 'border-line-strong bg-surface',
                  admin && 'opacity-50',
                )}
              >
                {on ? <Icon icon={Check} size={16} /> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
