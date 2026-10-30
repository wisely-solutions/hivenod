import { useState } from 'react';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { Segmented, Select } from '../ui/form';
import { useReady } from '../auth/context';
import { ThreadFeed } from './ThreadFeed';
import {
  NO_THREAD_FILTERS,
  THREAD_GROUPS,
  type ThreadFeedFilters,
  type ThreadGroupId,
} from './threadLogic';

/**
 * Activity (item OE8FmrTaIxFVGcaeGG3N, slice 9, design 6.7): what happened on your threads, live:
 * threads, plans and steps, decisions, summaries, by you and by the organization's agents. Each
 * person sees only their own threads (no admin view of other members' threads).
 */
export function ActivityPage() {
  const { session } = useReady();
  const { agents } = useShellData();
  const [filters, setFilters] = useState<ThreadFeedFilters>(NO_THREAD_FILTERS);
  const actorOptions = [
    { value: 'all', label: 'Everyone' },
    { value: session.me.uid, label: 'Me' },
    { value: 'agents', label: 'All agents' },
    ...agents.map((a) => ({ value: a.id, label: `Agent · ${a.data.name}` })),
  ];
  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="What happened on your threads, as it happens: you and your agents."
      />
      <div
        role="group"
        aria-label="Filters"
        className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between"
      >
        <Segmented
          label="Type"
          value={filters.group}
          onValueChange={(v) => setFilters((f) => ({ ...f, group: v as '' | ThreadGroupId }))}
          options={[
            { value: '', label: 'All' },
            ...THREAD_GROUPS.map((g) => ({ value: g.id, label: g.label })),
          ]}
        />
        <div className="lg:w-64">
          <Select
            label="Who"
            value={filters.actor}
            onValueChange={(v) => setFilters((f) => ({ ...f, actor: v }))}
            options={actorOptions}
          />
        </div>
      </div>
      <ThreadFeed filters={filters} />
    </>
  );
}
