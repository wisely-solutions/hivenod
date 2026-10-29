/**
 * Settings > Inbox labels (item YaOErIjeIFG8Y3EvZuIp): the short list of labels (Sales, Support,
 * ...) the agent picks from when it files a new subject. Admins edit it; members see it. A
 * rename or removal leaves existing subjects alone: they keep the old text as a plain chip.
 */
import {
  cleanLabelList,
  DEFAULT_INBOX_LABELS,
  INBOX_LIMITS,
  inboxSubjectSchema,
  setInboxLabels,
} from '@hive/shared';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useReady } from '../../auth/context';
import { useLiveQuery } from '../../lib/live';
import { Button, IconButton } from '../../ui/button';
import { Card } from '../../ui/card';
import { Input } from '../../ui/form';
import { Icon } from '../../ui/icon';
import { mySubjectsQuery } from '../../threads/data';
import { errorText } from '../../threads/parts';
import { useLabelList } from '../../threads/labels';

export function LabelsTab() {
  const { session } = useReady();
  const wid = session.workspaceId;
  const { labels, custom } = useLabelList(wid);
  // Re-keyed when the saved list changes, so a fresh draft starts from it.
  return (
    <LabelsEditor
      key={labels.join('\u0000')}
      wid={wid}
      saved={labels}
      custom={custom}
      isAdmin={session.isAdmin}
    />
  );
}

function LabelsEditor({
  wid,
  saved,
  custom,
  isAdmin,
}: {
  wid: string;
  saved: readonly string[];
  custom: boolean;
  isAdmin: boolean;
}) {
  const { session, actionContext, run } = useReady();
  const [draft, setDraft] = useState<string[]>(() => [...saved]);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = useLiveQuery(
    `label-usage:${wid}:${session.me.uid}`,
    () => mySubjectsQuery(wid, session.me.uid),
    inboxSubjectSchema,
  );
  const usage = useMemo(() => {
    const by = new Map<string, number>();
    if (mine.state === 'ready')
      for (const s of mine.data) {
        const k = s.data.label?.toLowerCase();
        if (k) by.set(k, (by.get(k) ?? 0) + 1);
      }
    return by;
  }, [mine]);
  const dirty = draft.join('\u0000') !== saved.join('\u0000');

  async function save(next: string[]) {
    setError(null);
    const ctx = actionContext(wid);
    if (!ctx) return;
    setBusy(true);
    try {
      await run(setInboxLabels(ctx, { labels: cleanLabelList(next) }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const move = (i: number, d: -1 | 1) =>
    setDraft((cur) => {
      const next = [...cur];
      const j = i + d;
      if (j < 0 || j >= next.length) return cur;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <section className="mx-auto w-full max-w-2xl" aria-label="Inbox labels">
      <Card>
        <h2 className="text-16 font-semibold text-ink">Inbox labels</h2>
        <p className="mb-3 mt-1 text-14 text-text-2">
          The agent suggests one of these on every new subject; you confirm or change it. Up to{' '}
          {INBOX_LIMITS.labels} labels. Renaming or removing one does not change subjects that
          already have it.
          {custom ? '' : ' These are the defaults.'}
        </p>
        <ul className="flex flex-col gap-2" aria-label="Labels">
          {draft.map((l, i) => (
            <li key={i} data-label-row className="flex flex-wrap items-end gap-x-2 gap-y-1">
              <div className="min-w-0 flex-1 basis-48">
                <Input
                  label={`Label ${i + 1}`}
                  value={l}
                  maxLength={INBOX_LIMITS.label}
                  readOnly={!isAdmin}
                  onChange={(e) =>
                    setDraft((cur) => cur.map((x, k) => (k === i ? e.target.value : x)))
                  }
                />
              </div>
              <span className="pb-3 text-13 text-text-2" aria-label="Your subjects with it">
                {usage.get(l.trim().toLowerCase()) ?? 0}
              </span>
              {isAdmin ? (
                <span className="flex">
                  <IconButton
                    label={`Move ${l || 'label'} up`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <Icon icon={ArrowUp} />
                  </IconButton>
                  <IconButton
                    label={`Move ${l || 'label'} down`}
                    disabled={i === draft.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <Icon icon={ArrowDown} />
                  </IconButton>
                  <IconButton
                    label={`Remove ${l || 'label'}`}
                    disabled={draft.length <= 1}
                    onClick={() => setDraft((cur) => cur.filter((_, k) => k !== i))}
                  >
                    <Icon icon={Trash2} />
                  </IconButton>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {isAdmin ? (
          <>
            <form
              className="mt-3 flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const n = adding.trim();
                if (!n || draft.length >= INBOX_LIMITS.labels) return;
                setDraft((cur) => [...cur, n]);
                setAdding('');
              }}
            >
              <div className="min-w-0 flex-1">
                <Input
                  label="New label"
                  value={adding}
                  maxLength={INBOX_LIMITS.label}
                  onChange={(e) => setAdding(e.target.value)}
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                leading={<Plus size={16} aria-hidden />}
                disabled={draft.length >= INBOX_LIMITS.labels}
              >
                Add
              </Button>
            </form>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                variant="primary"
                loading={busy}
                disabled={!dirty}
                onClick={() => void save(draft)}
              >
                Save labels
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setDraft([...DEFAULT_INBOX_LABELS])}
              >
                Reset to defaults
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-3 text-14 text-text-2">
            Only an admin of the organization edits this list.
          </p>
        )}
        {error ? (
          <p role="alert" className="mt-3 text-14 text-sendback">
            {error}
          </p>
        ) : null}
      </Card>
    </section>
  );
}
