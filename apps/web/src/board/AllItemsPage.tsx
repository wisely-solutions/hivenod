import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { ListView } from './ListView';
import { listRows, type ListRow } from './logic';

/** Every open item of every project in one list (card O2Ehb9CG), reached from All projects. */
export function AllItemsPage() {
  const { session } = useReady();
  const { projects, agents, items, loading } = useShellData();
  const navigate = useNavigate();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const rows = useMemo(
    () =>
      projects
        .filter((p) => !p.data.archivedAt)
        .flatMap((p) => listRows(p.data, items[p.id] ?? [], agents, p.id, session.me.uid)),
    [projects, items, agents, session.me.uid],
  );
  const open = (r: ListRow) =>
    void navigate({ to: '/p/$pid', params: { pid: r.pid }, search: { item: r.row.id } });
  return (
    <>
      <PageHeader
        title="All items"
        subtitle={loading ? undefined : `${rows.length} open across your projects`}
        reserveSubtitle={loading}
      />
      <ListView rows={rows} agents={agents} onOpen={open} now={now} everyProject />
    </>
  );
}
