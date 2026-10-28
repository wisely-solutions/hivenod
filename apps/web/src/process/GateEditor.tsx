import {
  plainWords,
  resolveDeciders,
  splitDeciders,
  type Gate,
  type GateRule,
  type GroupRef,
  type MemberProfile,
} from '@hive/shared';
import { Check, Minus, Plus, UserPlus, Users, X } from 'lucide-react';
import { useState } from 'react';
import { PersonAvatar } from '../components/PersonAvatar';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { Eyebrow, NumberRoll } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { cn } from '../ui/cn';
import { Input, RadioCards, Toggle } from '../ui/form';
import { Icon } from '../ui/icon';
import { AnimatePresence, motion, tween } from '../ui/motion';

export interface Person {
  uid: string;
  name: string;
  profile: MemberProfile | null;
}

const RULES: Array<{ value: GateRule; title: string }> = [
  { value: 'any', title: 'Any one' },
  { value: 'atLeast', title: 'At least N' },
  { value: 'all', title: 'Everyone' },
  { value: 'specific', title: 'Specific people' },
];

/** "Who decides" for one gate (screen 7): deciders, rule, must-includes, reject policy, reminder. */
export function GateEditor({
  gate,
  onChange,
  people,
  groups,
  stepName,
  locked = false,
}: {
  gate: Gate;
  onChange: (g: Gate) => void;
  people: Person[];
  groups: GroupRef[];
  stepName: string;
  /** The viewer may not change who decides here (the rules would refuse it). */
  locked?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const names = Object.fromEntries(people.map((p) => [p.uid, p.name]));
  const sel = splitDeciders(gate, groups);
  const total = gate.deciderUids.length;
  const person = (uid: string) => people.find((p) => p.uid === uid);

  /** Applies a new selection: recomputes the resolved list and keeps the other settings valid. */
  function setSelection(next: { people: string[]; groupIds: string[] }) {
    const deciderUids = resolveDeciders(next, groups);
    onChange({
      ...gate,
      groupIds: next.groupIds,
      deciderUids,
      mustInclude: gate.mustInclude.filter((u) => deciderUids.includes(u)),
      n: deciderUids.length ? Math.min(Math.max(gate.n, 1), deciderUids.length) : gate.n,
    });
  }

  const ruleOptions = RULES.map((r) => ({
    value: r.value,
    title: r.title === 'At least N' ? `At least ${gate.n} of ${total}` : r.title,
    description: {
      any: 'The first person to approve passes it.',
      atLeast: 'Pick how many approvals it needs.',
      all: 'Every person and group member chosen must approve.',
      specific: 'Each person you chose must approve.',
    }[r.value],
  }));
  const mustApplies = gate.rule === 'any' || gate.rule === 'atLeast';

  return (
    <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
      {locked ? (
        <p role="note" className="text-13 text-text-2">
          Only an admin, the project creator or a current decider of this step can change who
          decides.
        </p>
      ) : null}
      <section aria-label="Who can decide" className="flex flex-col gap-3">
        <Eyebrow>Who can decide</Eyebrow>
        <p className="text-13 text-text-2">
          Anyone who decides here is added to the project's people when you save.
        </p>
        <ul className="flex flex-wrap gap-2" aria-label="Deciders">
          {sel.groupIds.map((gid) => {
            const g = groups.find((x) => x.id === gid)!;
            return (
              <Chip
                key={gid}
                label={g.name}
                detail={memberSummary(g, names)}
                icon={<Icon icon={Users} size={16} />}
                onRemove={() =>
                  setSelection({
                    people: [...sel.people],
                    groupIds: sel.groupIds.filter((x) => x !== gid),
                  })
                }
              />
            );
          })}
          {sel.people.map((uid) => (
            <Chip
              key={uid}
              label={names[uid] ?? 'Someone'}
              icon={
                <PersonAvatar
                  name={names[uid] ?? '?'}
                  photoURL={person(uid)?.profile?.photoURL}
                  color={person(uid)?.profile?.color ?? 'c8'}
                  size="sm"
                />
              }
              onRemove={() =>
                setSelection({
                  people: sel.people.filter((x) => x !== uid),
                  groupIds: [...sel.groupIds],
                })
              }
            />
          ))}
          <li>
            <Button
              variant="secondary"
              leading={<Icon icon={UserPlus} />}
              onClick={() => setPicking(true)}
            >
              Add person or group
            </Button>
          </li>
        </ul>
        {total === 0 ? (
          <p role="alert" className="text-13 text-sendback">
            {stepName} needs at least one person or group before it can be saved.
          </p>
        ) : null}
      </section>

      <section aria-label="Approval rule" className="flex flex-col gap-3">
        <Eyebrow>Approval rule</Eyebrow>
        <RadioCards
          label="Approval rule"
          value={gate.rule}
          onValueChange={(v) => onChange({ ...gate, rule: v as GateRule })}
          options={ruleOptions}
        />
        {gate.rule === 'atLeast' ? (
          <div className="flex items-center justify-between gap-3 rounded-card border border-line bg-surface p-3">
            <span id={`n-${stepName}`} className="text-14 font-medium text-ink">
              Approvals needed
            </span>
            <div role="group" aria-label="Approvals needed" className="flex items-center gap-2">
              <IconButton
                label="Fewer approvals"
                variant="secondary"
                disabled={gate.n <= 1}
                onClick={() => onChange({ ...gate, n: gate.n - 1 })}
              >
                <Icon icon={Minus} size={18} />
              </IconButton>
              <span aria-live="polite" className="min-w-14 text-center text-16 font-semibold">
                <NumberRoll value={gate.n} />{' '}
                <span className="font-normal text-text-2">of {total}</span>
              </span>
              <IconButton
                label="More approvals"
                variant="secondary"
                disabled={gate.n >= total}
                onClick={() => onChange({ ...gate, n: gate.n + 1 })}
              >
                <Icon icon={Plus} size={18} />
              </IconButton>
            </div>
          </div>
        ) : null}
      </section>

      {total > 1 ? (
        <section aria-label="Must be one of them" className="flex flex-col">
          <Eyebrow>Must be one of them</Eyebrow>
          {mustApplies ? (
            gate.deciderUids.map((uid) => (
              <Toggle
                key={uid}
                label={`${names[uid] ?? 'Someone'} must be one of them`}
                checked={gate.mustInclude.includes(uid)}
                onCheckedChange={(on) =>
                  onChange({
                    ...gate,
                    mustInclude: on
                      ? [...gate.mustInclude, uid]
                      : gate.mustInclude.filter((u) => u !== uid),
                  })
                }
              />
            ))
          ) : (
            <p className="mt-1 text-13 text-text-2">
              Everyone chosen has to approve, so nobody needs to be singled out.
            </p>
          )}
        </section>
      ) : null}

      <section aria-label="If someone rejects" className="flex flex-col gap-3">
        <Eyebrow>If someone rejects</Eyebrow>
        <RadioCards
          label="If someone rejects"
          value={gate.rejectPolicy}
          onValueChange={(v) => onChange({ ...gate, rejectPolicy: v as Gate['rejectPolicy'] })}
          options={[
            {
              value: 'one',
              title: 'One rejection',
              description: 'Any single decider can send it back.',
            },
            {
              value: 'majority',
              title: 'Only if most reject',
              description: 'More than half of the deciders must reject.',
            },
          ]}
        />
      </section>

      <section aria-label="If nobody decides" className="flex flex-col gap-2">
        <Eyebrow>If nobody decides</Eyebrow>
        <div className="max-w-xs">
          <Input
            label="Remind after (hours)"
            type="number"
            inputMode="numeric"
            min={0}
            max={720}
            value={String(gate.remindAfterHours)}
            hint="A reminder badge shows in Hivenod. 0 turns it off."
            onChange={(e) => {
              const v = Math.min(720, Math.max(0, Math.round(Number(e.target.value) || 0)));
              onChange({ ...gate, remindAfterHours: v });
            }}
          />
        </div>
      </section>

      <PlainWords text={plainWords(gate, names, groups)} />

      <ResponsiveModal
        open={picking}
        onOpenChange={setPicking}
        title="Who can decide"
        description="Pick groups and people. Changes apply at once."
        footer={<Button onClick={() => setPicking(false)}>Done</Button>}
      >
        <DeciderPicker sel={sel} people={people} groups={groups} onChange={setSelection} />
      </ResponsiveModal>
    </fieldset>
  );
}

/** The live "In plain words" sentence: the old one slides out, the new one in. */
export function PlainWords({ text }: { text: string }) {
  return (
    <section
      aria-label="In plain words"
      className="rounded-card border border-gate/50 bg-gate-bg p-4"
    >
      <Eyebrow className="text-gate-text">In plain words</Eyebrow>
      <div className="relative mt-1.5 min-h-12">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={text}
            data-testid="plain-words"
            aria-live="polite"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={tween.base}
            className="text-16 font-medium leading-snug text-gate-text"
          >
            {text}
          </motion.p>
        </AnimatePresence>
      </div>
    </section>
  );
}

/** "João, Ana" / "João, Ana +2": who a group chip stands for, so a covered person never just vanishes. */
function memberSummary(g: GroupRef, names: Readonly<Record<string, string>>): string {
  const shown = g.memberUids.slice(0, 3).map((u) => names[u] ?? 'Someone');
  const more = g.memberUids.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` +${more}` : ''}`;
}

function Chip({
  label,
  detail,
  icon,
  onRemove,
}: {
  label: string;
  detail?: string;
  icon: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <li className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line-strong bg-surface pl-2.5 text-14 font-medium text-ink">
      {icon}
      <span>{label}</span>
      {detail ? <span className="text-13 font-normal text-text-2">{detail}</span> : null}
      <button
        type="button"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
        className="grid size-11 place-items-center rounded-full text-text-2 hov:text-ink foc:outline-2 foc:-outline-offset-2 foc:outline-focus"
      >
        <Icon icon={X} size={16} />
      </button>
    </li>
  );
}

function DeciderPicker({
  sel,
  people,
  groups,
  onChange,
}: {
  sel: { people: readonly string[]; groupIds: readonly string[] };
  people: Person[];
  groups: GroupRef[];
  onChange: (next: { people: string[]; groupIds: string[] }) => void;
}) {
  const inGroup = new Set(
    groups.filter((g) => sel.groupIds.includes(g.id)).flatMap((g) => g.memberUids),
  );
  const row = (
    key: string,
    label: string,
    sub: string | null,
    on: boolean,
    toggle: () => void,
    lead: React.ReactNode,
    locked = false,
  ) => (
    <li key={key} className="border-t border-line first:border-t-0">
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        aria-label={label}
        disabled={locked}
        onClick={toggle}
        className="flex min-h-12 w-full items-center gap-3 px-3 text-left hov:bg-canvas foc:outline-2 foc:-outline-offset-2 foc:outline-focus disabled:cursor-default disabled:hov:bg-transparent"
      >
        {lead}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-14 font-medium text-ink">{label}</span>
          {sub ? <span className="block text-13 text-text-2">{sub}</span> : null}
        </span>
        <span
          aria-hidden
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-[6px] border',
            on ? 'border-ink bg-ink text-surface' : 'border-line-strong bg-surface',
            locked && 'opacity-50',
          )}
        >
          {on ? <Icon icon={Check} size={16} /> : null}
        </span>
      </button>
    </li>
  );
  return (
    <div className="flex flex-col gap-4">
      {groups.length ? (
        <div>
          <Eyebrow>Groups</Eyebrow>
          <ul
            aria-label="Groups"
            className="mt-2 overflow-hidden rounded-card border border-line bg-surface"
          >
            {groups.map((g) =>
              row(
                g.id,
                g.name,
                `${g.memberUids.length} ${g.memberUids.length === 1 ? 'person' : 'people'}`,
                sel.groupIds.includes(g.id),
                () =>
                  onChange({
                    people: [...sel.people],
                    groupIds: sel.groupIds.includes(g.id)
                      ? sel.groupIds.filter((x) => x !== g.id)
                      : [...sel.groupIds, g.id],
                  }),
                <span className="grid size-8 place-items-center rounded-full bg-canvas text-text-2">
                  <Icon icon={Users} size={16} />
                </span>,
              ),
            )}
          </ul>
        </div>
      ) : null}
      <div>
        <Eyebrow>People</Eyebrow>
        <ul
          aria-label="People"
          className="mt-2 overflow-hidden rounded-card border border-line bg-surface"
        >
          {people.map((p) => {
            const viaGroup = inGroup.has(p.uid);
            return row(
              p.uid,
              p.name,
              viaGroup ? 'In a chosen group' : null,
              viaGroup || sel.people.includes(p.uid),
              () =>
                onChange({
                  groupIds: [...sel.groupIds],
                  people: sel.people.includes(p.uid)
                    ? sel.people.filter((x) => x !== p.uid)
                    : [...sel.people, p.uid],
                }),
              <PersonAvatar
                name={p.name}
                photoURL={p.profile?.photoURL}
                color={p.profile?.color ?? 'c8'}
                size="md"
              />,
              viaGroup,
            );
          })}
        </ul>
      </div>
    </div>
  );
}
