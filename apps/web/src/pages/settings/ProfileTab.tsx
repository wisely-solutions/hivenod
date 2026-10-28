import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { useReady } from '../../auth/context';
import { colorVar, PersonAvatar } from '../../components/PersonAvatar';
import { applyPreference, type ThemePreference } from '../../theme';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { cn } from '../../ui/cn';
import { Segmented, Input } from '../../ui/form';
import { Icon } from '../../ui/icon';
import { useToast } from '../../ui/overlay';
import { PageHeader } from '../Chrome';

const COLOR_NAMES = ['Blue', 'Violet', 'Magenta', 'Rust', 'Amber', 'Green', 'Teal', 'Slate'];

/** Settings > Profile: your name, colour, theme and sign-out. */
export function ProfileTab() {
  const { session, updateProfile, signOut } = useReady();
  const toast = useToast();
  const { profile } = session;
  // A draft only exists while someone is typing; otherwise the live value shows.
  const [nameDraft, setName] = useState<string | null>(null);
  const name = nameDraft ?? profile.name;
  const [busy, setBusy] = useState(false);
  const pref: ThemePreference = profile.theme ?? 'system';

  async function saveName() {
    setBusy(true);
    try {
      await updateProfile({ name: name.trim() });
      setName(null);
      toast.push({ message: 'Name saved' });
    } catch {
      toast.push({ message: 'Could not save your name.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader section title="Profile" />
      <section aria-label="Your profile" className="mb-8">
        <Card className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <PersonAvatar
              name={profile.name}
              photoURL={profile.photoURL}
              color={profile.color}
              size="lg"
            />
            <div className="min-w-0">
              <p className="truncate text-14 font-medium">{profile.name}</p>
              <p className="truncate text-13 text-text-2">{profile.email}</p>
            </div>
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== profile.name) saveName();
            }}
          >
            <div className="min-w-0 flex-1">
              <Input
                label="Name"
                value={name}
                maxLength={200}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              variant="secondary"
              loading={busy}
              disabled={!name.trim() || name.trim() === profile.name}
            >
              Save
            </Button>
          </form>
          <fieldset>
            <legend className="mb-2 text-13 font-medium text-ink">Colour</legend>
            <div className="flex flex-wrap gap-1">
              {COLOR_NAMES.map((label, i) => {
                const token = `c${i + 1}`;
                const on = profile.color === token;
                return (
                  <button
                    key={token}
                    type="button"
                    aria-label={label}
                    aria-pressed={on}
                    onClick={() => updateProfile({ color: token })}
                    className="grid size-11 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <span
                      className={cn(
                        'size-8 rounded-full ring-offset-2 ring-offset-surface transition-shadow',
                        on ? 'ring-2 ring-ink' : 'ring-0',
                      )}
                      style={{ backgroundColor: colorVar(token) }}
                    />
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div>
            <p className="mb-1 text-13 font-medium text-ink" id="theme-label">
              Theme
            </p>
            <Segmented
              label="Theme"
              value={pref}
              onValueChange={(v) => {
                const next = v as ThemePreference;
                applyPreference(next);
                updateProfile({ theme: next === 'system' ? null : next });
              }}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </div>
        </Card>
      </section>

      <Button variant="secondary" leading={<Icon icon={LogOut} />} onClick={signOut}>
        Sign out
      </Button>
    </>
  );
}
