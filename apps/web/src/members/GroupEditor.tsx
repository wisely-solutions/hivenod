import type { Group } from '@hive/shared';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { PersonAvatar } from '../components/PersonAvatar';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input } from '../ui/form';
import { Icon } from '../ui/icon';
import type { Row } from '../lib/live';
import { displayName } from './data';
import type { MemberProfile } from '@hive/shared';

export interface Person {
  uid: string;
  profile: MemberProfile | null | undefined;
}

/** Create or edit a group. The member picker is a grid of avatars you tap on and off. */
function EditorBody({
  open,
  group,
  people,
  busy,
  onClose,
  onSave,
  onDelete,
}: {
  open: boolean;
  /** Undefined = a new group. */
  group?: Row<Group>;
  people: Person[];
  busy: boolean;
  onClose: () => void;
  onSave: (v: { name: string; memberUids: string[] }) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(group?.data.name ?? '');
  const [picked, setPicked] = useState<string[]>(group?.data.memberUids ?? []);
  const [touched, setTouched] = useState(false);

  const toggle = (uid: string) =>
    setPicked((p) => (p.includes(uid) ? p.filter((u) => u !== uid) : [...p, uid]));
  const nameError = touched && !name.trim() ? 'Give the group a name.' : undefined;

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={group ? 'Edit group' : 'New group'}
      description="Groups are used when you choose who decides at a gate."
      footer={
        <>
          {group && onDelete ? (
            <Button variant="sendback" className="sm:mr-auto" onClick={onDelete}>
              Delete group
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            onClick={() => {
              setTouched(true);
              if (name.trim()) onSave({ name: name.trim(), memberUids: picked });
            }}
          >
            {group ? 'Save group' : 'Create group'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Input
          label="Name"
          value={name}
          maxLength={80}
          placeholder="Product"
          onChange={(e) => setName(e.target.value)}
          error={nameError}
        />
        <fieldset>
          <legend className="mb-2 text-13 font-medium text-ink">
            Members <span className="font-normal text-text-2">({picked.length} selected)</span>
          </legend>
          <ul className="grid grid-cols-2 gap-2">
            {people.map(({ uid, profile }) => {
              const on = picked.includes(uid);
              const n = displayName(profile, uid);
              return (
                <li key={uid}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(uid)}
                    className={cn(
                      'flex min-h-14 w-full items-center gap-2.5 rounded-card border p-2 text-left',
                      'transition-[border-color,background-color] duration-120 ease-standard',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                      on
                        ? 'border-ink bg-canvas'
                        : 'border-line bg-surface hover:border-line-strong',
                    )}
                  >
                    <span className="relative">
                      <PersonAvatar
                        name={n}
                        photoURL={profile?.photoURL}
                        color={profile?.color ?? 'c8'}
                      />
                      {on ? (
                        <span
                          aria-hidden
                          className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-approve-solid text-on-solid ring-2 ring-surface"
                        >
                          <Icon icon={Check} size={10} />
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0 truncate text-14 text-ink">{n}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </fieldset>
      </div>
    </ResponsiveModal>
  );
}

type EditorProps = Parameters<typeof EditorBody>[0];

/** Each opening starts from the saved group, so a cancelled edit never leaks into the next one. */
export function GroupEditor(props: EditorProps) {
  const [wasOpen, setWasOpen] = useState(props.open);
  const [opening, setOpening] = useState(0);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setOpening((n) => n + 1);
  }
  return <EditorBody key={`${opening}-${props.group?.id ?? 'new'}`} {...props} />;
}
