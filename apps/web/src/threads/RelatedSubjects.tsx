/**
 * Related subjects on a subject's page (docs/INBOX.md, "Related subjects"): the subjects linked
 * to it, the links agents propose (OK or No), and the member's own Link a subject (with an
 * optional note). Links are symmetric: one document per pair.
 */
import {
  agentSchema,
  rejectRelation,
  relateSubjects,
  relationId,
  unrelateSubjects,
  type ActionPlan,
  type InboxRelation,
} from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { useLiveCollection } from '../lib/live';
import { Button } from '../ui/button';
import { Input, Select } from '../ui/form';
import { Dialog, useToast } from '../ui/overlay';
import { useMyRelations, useMySubjects } from './data';
import { errorText, Section } from './parts';

export function RelatedSubjects({ wid, sid, uid }: { wid: string; sid: string; uid: string }) {
  const { actionContext, run } = useReady();
  const toast = useToast();
  const wids = useMemo(() => [wid], [wid]);
  const relations = useMyRelations(uid, wids);
  const subjects = useMySubjects(wid, uid);
  const agents = useLiveCollection(`workspaces/${wid}/agents`, agentSchema);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const names = new Map(
    (subjects.state === 'ready' ? subjects.data : []).map((s) => [s.id, s.data.name]),
  );
  const agentName = (id: string) =>
    (agents.state === 'ready' && agents.data.find((a) => a.id === id)?.data.name) || 'An agent';
  // Links of this subject whose other side still exists (a merge may have removed it).
  const mine = relations.rows
    .filter((r) => r.data.a === sid || r.data.b === sid)
    .map((r) => ({ ...r, other: r.data.a === sid ? r.data.b : r.data.a }))
    .filter((r) => names.has(r.other));
  const related = mine.filter((r) => r.data.state === 'related');
  const proposed = mine.filter((r) => r.data.state === 'proposed');
  const byId = new Map(relations.rows.map((r) => [r.id, r.data]));

  async function act(make: () => Pick<ActionPlan, 'ops'>, done: string) {
    setError(null);
    let plan;
    try {
      const ctx = actionContext(wid);
      if (!ctx) throw new Error('Not signed in.');
      plan = make();
    } catch (e) {
      setError(errorText(e));
      return false;
    }
    setBusy(true);
    try {
      await run(plan);
      toast.push({ message: done });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const ctx = () => actionContext(wid)!;
  const subjectOf = { memberUid: uid };
  const relate = (other: string, note: string | null, existing: InboxRelation | null) =>
    relateSubjects(ctx(), {
      a: sid,
      b: other,
      subjectA: subjectOf,
      subjectB: subjectOf,
      existing,
      note,
    });

  const candidates = [...names.entries()]
    .filter(([id]) => id !== sid && byId.get(relationId(sid, id))?.state !== 'related')
    .sort((x, y) => x[1].localeCompare(y[1]));

  return (
    <Section
      title="Related subjects"
      action={
        candidates.length > 0 ? (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Link a subject…
          </Button>
        ) : undefined
      }
    >
      {proposed.length > 0 ? (
        <ul className="mb-3 flex flex-col gap-2" aria-label="Suggested links">
          {proposed.map((r) => (
            <li
              key={r.id}
              data-relation={r.id}
              data-relation-state="proposed"
              className="rounded-card border border-gate/60 bg-surface p-3"
            >
              <p className="text-14 text-ink">
                {r.data.proposedBy.type === 'agent' ? agentName(r.data.proposedBy.id) : 'You'}{' '}
                suggests it is related to{' '}
                <Link
                  to="/inbox/$wid/s/$sid"
                  params={{ wid, sid: r.other }}
                  className="font-semibold hover:underline"
                >
                  {names.get(r.other)}
                </Link>
              </p>
              {r.data.note ? <p className="mt-1 text-14 text-text-2">{r.data.note}</p> : null}
              <div className="mt-2 flex gap-2">
                <Button
                  variant="approve"
                  disabled={busy}
                  onClick={() => void act(() => relate(r.other, null, r.data), 'Linked.')}
                >
                  OK
                </Button>
                <Button
                  variant="sendback"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => rejectRelation(ctx(), { relationId: r.id, relation: r.data }),
                      'Turned down.',
                    )
                  }
                >
                  No
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {related.length === 0 ? (
        <p className="text-14 text-text-2">No related subjects.</p>
      ) : (
        <ul
          className="overflow-hidden rounded-card border border-line bg-surface"
          aria-label="Related"
        >
          {related.map((r) => (
            <li
              key={r.id}
              data-relation={r.id}
              data-relation-state="related"
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2 last:border-b-0"
            >
              <Link
                to="/inbox/$wid/s/$sid"
                params={{ wid, sid: r.other }}
                className="min-h-11 content-center text-14 font-medium text-ink hover:underline"
              >
                {names.get(r.other)}
              </Link>
              {r.data.note ? (
                <span className="min-w-0 flex-1 text-13 text-text-2">{r.data.note}</span>
              ) : (
                <span className="flex-1" />
              )}
              <Button
                variant="ghost"
                disabled={busy}
                aria-label={`Unlink ${names.get(r.other)}`}
                onClick={() =>
                  void act(
                    () => unrelateSubjects(ctx(), { relationId: r.id, relation: r.data }),
                    'Unlinked.',
                  )
                }
              >
                Unlink
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-14 text-sendback">
          {error}
        </p>
      ) : null}
      <LinkDialog
        open={open}
        onOpenChange={setOpen}
        options={candidates.map(([id, name]) => ({ value: id, label: name }))}
        busy={busy}
        onLink={(other, note) =>
          void act(
            () => relate(other, note, byId.get(relationId(sid, other)) ?? null),
            'Linked.',
          ).then((ok) => ok && setOpen(false))
        }
      />
    </Section>
  );
}

function LinkDialog({
  open,
  onOpenChange,
  options,
  busy,
  onLink,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  options: { value: string; label: string }[];
  busy: boolean;
  onLink: (other: string, note: string) => void;
}) {
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const target = options.find((o) => o.value === to) ?? options[0];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Link a related subject"
      description="Related subjects show on each other's page. The link goes both ways."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!target}
            onClick={() => target && onLink(target.value, note)}
          >
            Link
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Select
          label="Related subject"
          value={target?.value ?? ''}
          onValueChange={setTo}
          options={options}
        />
        <Input
          label="Note (optional)"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
    </Dialog>
  );
}
