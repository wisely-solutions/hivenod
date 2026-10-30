/**
 * Scheduled tasks, slice 6: Edit a schedule (design 9.1): what, the frequency and its fields, the
 * time and zone, the run title. The plan of each run stays as approved (ask the agent to change
 * it). A changed rule starts from now (editSchedule sets activeFrom): a run already made this
 * period never runs again.
 */
import {
  checkRule,
  DEFAULT_SCHEDULE_TZ,
  editSchedule,
  ruleSentence,
  SCHEDULE_FREQS,
  type Schedule,
  type ScheduleFreq,
  type ScheduleRule,
} from '@hive/shared';
import { useState, type FormEvent } from 'react';
import { useReady } from '../auth/context';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { errorText } from '../threads/parts';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input, Select, Textarea } from '../ui/form';
import { useToast } from '../ui/overlay';

const FREQ_LABEL: Record<ScheduleFreq, string> = {
  once: 'Once',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

interface Draft {
  title: string;
  what: string;
  runTitle: string;
  freq: ScheduleFreq;
  at: string;
  tz: string;
  date: string;
  weekdays: number[];
  monthDay: number;
  month: number;
  weekend: 'keep' | 'before' | 'after';
}

function draftOf(s: Schedule): Draft {
  const r = s.rule;
  return {
    title: s.title,
    what: s.what,
    runTitle: s.runTitle,
    freq: r.freq,
    at: r.at,
    tz: r.tz ?? DEFAULT_SCHEDULE_TZ,
    date: r.date ?? '',
    weekdays: r.weekdays ?? (r.freq === 'weekly' ? [1] : []),
    monthDay: r.monthDay ?? 1,
    month: r.month ?? 1,
    weekend: r.weekend ?? 'keep',
  };
}

/** The rule the form describes, with only the keys its frequency uses. */
export function ruleOf(d: Draft, keep: ScheduleRule): ScheduleRule {
  const r: ScheduleRule = { freq: d.freq, at: d.at, tz: d.tz.trim() || DEFAULT_SCHEDULE_TZ };
  if (d.freq === 'once') r.date = d.date;
  else if (keep.date && keep.freq !== 'once') r.date = keep.date;
  if (d.freq === 'daily' && d.weekdays.length && d.weekdays.length < 7) r.weekdays = d.weekdays;
  if (d.freq === 'weekly') r.weekdays = d.weekdays;
  if (d.freq === 'monthly' || d.freq === 'quarterly' || d.freq === 'yearly') {
    r.monthDay = d.monthDay;
    if (d.weekend !== 'keep') r.weekend = d.weekend;
  }
  if (d.freq === 'yearly' || d.freq === 'quarterly') r.month = d.month;
  if (keep.until && d.freq !== 'once') r.until = keep.until;
  return r;
}

export function ScheduleEditDialog({
  open,
  onOpenChange,
  wid,
  scheduleId,
  schedule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wid: string;
  scheduleId: string;
  schedule: Schedule;
}) {
  const { actionContext, run } = useReady();
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => draftOf(schedule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const rule = ruleOf(d, schedule.rule);
  const problems = checkRule(rule);
  let sentence = '';
  try {
    sentence = problems.length ? '' : ruleSentence(rule, { viewerTz: rule.tz });
  } catch {
    sentence = '';
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const ctx = actionContext(wid);
    if (!ctx || busy) return;
    setError(null);
    setBusy(true);
    try {
      const plan = editSchedule(ctx, {
        scheduleId,
        schedule: { ...schedule, rule: schedule.rule },
        changes: { title: d.title, what: d.what, runTitle: d.runTitle, rule },
      });
      await run(plan);
      toast.push({ message: `Saved: ${d.title.trim()}`, duration: 3000 });
      onOpenChange(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const dayOptions = [
    ...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` })),
    { value: '-1', label: 'Last day' },
  ];
  return (
    <ResponsiveModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit “${schedule.title}”`}
      description="Changes apply from the next run; a run already made this period never runs again."
    >
      <form onSubmit={save} className="flex flex-col gap-4" data-schedule-form="">
        <Input
          label="Title"
          value={d.title}
          maxLength={80}
          onChange={(e) => set('title', e.target.value)}
        />
        <Textarea
          label="What to do each time"
          value={d.what}
          rows={3}
          maxLength={4000}
          onChange={(e) => set('what', e.target.value)}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="How often"
            value={d.freq}
            onValueChange={(v) => set('freq', v as ScheduleFreq)}
            options={SCHEDULE_FREQS.map((f) => ({ value: f, label: FREQ_LABEL[f] }))}
          />
          <Input
            label="Time"
            type="time"
            value={d.at}
            onChange={(e) => set('at', e.target.value)}
          />
        </div>
        {d.freq === 'once' ? (
          <Input
            label="Day"
            type="date"
            value={d.date}
            onChange={(e) => set('date', e.target.value)}
          />
        ) : null}
        {d.freq === 'daily' || d.freq === 'weekly' ? (
          <fieldset>
            <legend className="text-13 font-medium text-ink">
              {d.freq === 'daily' ? 'On these days (none: every day)' : 'On'}
            </legend>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {DAYS.map((name, i) => {
                const n = i + 1;
                const on = d.weekdays.includes(n);
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set(
                        'weekdays',
                        on
                          ? d.weekdays.filter((x) => x !== n)
                          : [...d.weekdays, n].sort((a, b) => a - b),
                      )
                    }
                    className={cn(
                      'min-h-11 min-w-11 rounded-btn border px-2 text-14 font-medium foc:outline-2 foc:outline-focus',
                      on
                        ? 'border-ink bg-ink text-surface'
                        : 'border-line-strong bg-surface text-ink hov:bg-canvas',
                    )}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}
        {d.freq === 'monthly' || d.freq === 'quarterly' || d.freq === 'yearly' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {d.freq !== 'monthly' ? (
              <Select
                label={d.freq === 'yearly' ? 'Month' : 'First quarter month'}
                value={String(d.month)}
                onValueChange={(v) => set('month', Number(v))}
                options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))}
              />
            ) : null}
            <Select
              label="Day of the month"
              value={String(d.monthDay)}
              onValueChange={(v) => set('monthDay', Number(v))}
              options={dayOptions}
            />
            <Select
              label="On a weekend"
              value={d.weekend}
              onValueChange={(v) => set('weekend', v as Draft['weekend'])}
              options={[
                { value: 'keep', label: 'Keep the day' },
                { value: 'before', label: 'Move to Friday' },
                { value: 'after', label: 'Move to Monday' },
              ]}
            />
          </div>
        ) : null}
        <Input
          label="Time zone"
          value={d.tz}
          maxLength={64}
          hint="An IANA zone, e.g. Europe/Lisbon"
          onChange={(e) => set('tz', e.target.value)}
        />
        <Input
          label="Each run’s thread title"
          value={d.runTitle}
          maxLength={100}
          hint="{period}, {month}, {year}, {quarter} and {date} are filled in for each run"
          onChange={(e) => set('runTitle', e.target.value)}
        />
        <p className="text-14 text-text-2" data-form-sentence="" aria-live="polite">
          {problems.length ? `Check: ${problems.join('; ')}.` : sentence}
        </p>
        {error ? (
          <p role="alert" className="text-14 text-sendback">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={problems.length > 0}>
            Save changes
          </Button>
        </div>
      </form>
    </ResponsiveModal>
  );
}
