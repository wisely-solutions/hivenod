import {
  attachmentSchema,
  itemSchema,
  type Attachment,
  type Item,
  type Project,
} from '@hive/shared';
import { Link, getRouteApi } from '@tanstack/react-router';
import {
  ChevronLeft,
  ExternalLink,
  FileX,
  PanelRightClose,
  PanelRightOpen,
  Scale,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useReady } from '../auth/context';
import { useIsPhone } from '../components/ResponsiveModal';
import { useLiveCollection, useLiveDoc, type Row } from '../lib/live';
import { useSwipe } from '../lib/mobile';
import { useShellData } from '../shell/data';
import { isStandalone } from '../shell/pwa';
import { Badge } from '../ui/badge';
import { IconButton } from '../ui/button';
import { Skeleton, EmptyState } from '../ui/feedback';
import { Select } from '../ui/form';
import { Icon } from '../ui/icon';
import { Sheet } from '../ui/overlay';
import { dataUrlToBlobUrl, findingsOf, stepOf, textPage } from './logic';
import { openHtmlInNewTab } from './SandboxedHtml';
import { ReviewPanel } from './ReviewPanel';
import { AttachmentViewer } from './Viewers';

const route = getRouteApi('/p/$pid/i/$iid/view/$aid');

/** Opens an attachment in a new tab: HTML stays sandboxed, other kinds use a blob or their link. */
function openInNewTab(a: Attachment) {
  if (a.kind === 'html') return openHtmlInNewTab(a.content ?? '', a.name);
  if (a.kind === 'link' && a.url && /^https?:\/\//.test(a.url))
    return void window.open(a.url, '_blank', 'noopener,noreferrer');
  if (a.content && (a.kind === 'image' || a.kind === 'pdf')) {
    const url = dataUrlToBlobUrl(a.content);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (a.content && a.kind === 'markdown') return openHtmlInNewTab(textPage(a.content), a.name);
  if (a.content) {
    const url = URL.createObjectURL(new Blob([a.content], { type: 'text/plain;charset=utf-8' }));
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function ViewerPage() {
  const { pid, iid, aid } = route.useParams();
  const { projects, projectsConfirmed, suggestions } = useShellData();
  const row = projects.find((p) => p.id === pid) as Row<Project> | undefined;
  const { session } = useReady();
  const base = `workspaces/${session.workspaceId}/projects/${pid}/items/${iid}`;
  const item = useLiveDoc(row ? base : null, itemSchema, { synced: true });
  const attachments = useLiveCollection(`${base}/attachments`, attachmentSchema, { synced: true });

  const missing =
    (!row && projectsConfirmed) ||
    (item.state === 'ready' && !item.data && !item.fromCache) ||
    item.state === 'error' ||
    (attachments.state === 'ready' &&
      !attachments.fromCache &&
      !attachments.data.some((a) => a.id === aid));
  if (missing) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <EmptyState
          icon={FileX}
          title="This file is gone or not yours to see"
          description="Go back to the item and pick another file."
          action={
            <Link
              to="/p/$pid"
              params={{ pid }}
              search={{ item: iid }}
              className="text-14 font-medium underline underline-offset-4"
            >
              Back to the item
            </Link>
          }
        />
      </div>
    );
  }
  if (!row || item.state !== 'ready' || !item.data || attachments.state !== 'ready') {
    return <Skeleton className="m-4 h-[70dvh]" />;
  }
  const files = [...attachments.data].sort((a, b) => a.data.at.toMillis() - b.data.at.toMillis());
  const current = files.find((f) => f.id === aid)!;
  return (
    <Viewer
      pid={pid}
      iid={iid}
      project={row.data}
      item={item.data}
      files={files}
      current={current}
      items={suggestions[pid] ?? []}
    />
  );
}

function Viewer({
  pid,
  iid,
  project,
  item,
  files,
  current,
  items,
}: {
  pid: string;
  iid: string;
  project: Project;
  item: Item;
  files: Array<{ id: string; data: Attachment }>;
  current: { id: string; data: Attachment };
  items: Array<{ id: string; data: Item }>;
}) {
  const phone = useIsPhone();
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheet, setSheet] = useState(false);
  const navigateTo = route.useNavigate();
  const step = stepOf(project, item);
  const findings = findingsOf(items, iid).length;
  const header = useRef<HTMLElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  const standalone = isStandalone();
  const close = () => void navigateTo({ to: '/p/$pid', params: { pid }, search: { item: iid } });
  // Pull the header down to leave the full-page view; in an installed app the left edge goes back too.
  useSwipe(header, { onDown: phone ? close : undefined });
  useSwipe(edge, { onEdgeBack: phone && standalone ? close : undefined });

  useEffect(() => {
    document.title = `${current.data.name} · ${item.title} · Hivenod`;
  }, [current.data.name, item.title]);

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <header
        ref={header}
        className="flex items-center gap-2 border-b border-line bg-surface pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] sm:px-3"
      >
        <Link
          to="/p/$pid"
          params={{ pid }}
          search={{ item: iid }}
          aria-label="Back to the item"
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-btn px-2 text-14 text-text-2 hov:text-ink foc:outline-2 foc:outline-focus"
        >
          <Icon icon={ChevronLeft} />
          <span className="hidden sm:inline">Back</span>
        </Link>
        <div className="min-w-0 flex-1">
          <h1
            title={item.title}
            className="line-clamp-2 break-words text-14 font-semibold text-ink sm:text-16"
          >
            {item.title}
          </h1>
          <p title={current.data.name} className="line-clamp-2 break-all text-12 text-text-2">
            {current.data.name}
          </p>
        </div>
        {step ? (
          <span
            className={
              'inline-flex max-w-24 shrink-0 items-center truncate rounded-full border px-2 py-0.5 text-12 font-medium sm:max-w-none sm:px-2.5 ' +
              (step.kind === 'human'
                ? 'border-gate/60 bg-gate-bg text-gate-text'
                : 'border-line text-text-2')
            }
          >
            {step.name}
          </span>
        ) : null}
        {files.length > 1 ? (
          <Select
            hideLabel
            inline
            swipeThrough
            label="Attachment"
            className="max-w-[38vw] shrink-0 sm:max-w-56"
            value={current.id}
            onValueChange={(aid) =>
              void navigateTo({
                to: '/p/$pid/i/$iid/view/$aid',
                params: { pid, iid, aid },
                replace: true,
              })
            }
            options={files.map((f) => ({ value: f.id, label: f.data.name }))}
          />
        ) : null}
        <IconButton
          label="Open in new tab"
          variant="ghost"
          onClick={() => openInNewTab(current.data)}
        >
          <Icon icon={ExternalLink} />
        </IconButton>
        {!phone ? (
          <IconButton
            label={panelOpen ? 'Hide the decision panel' : 'Show the decision panel'}
            variant="ghost"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            <Icon icon={panelOpen ? PanelRightClose : PanelRightOpen} />
          </IconButton>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1">
        <main id="content" className="min-w-0 flex-1" aria-label={current.data.name}>
          <AttachmentViewer key={current.id} attachment={current.data} />
        </main>
        {!phone && panelOpen ? (
          <aside
            aria-label="Review"
            className="w-[380px] shrink-0 overflow-y-auto border-l border-line bg-canvas p-4"
          >
            <ReviewPanel pid={pid} itemId={iid} project={project} item={item} items={items} />
          </aside>
        ) : null}
      </div>

      {phone && standalone ? (
        <div ref={edge} aria-hidden className="fixed inset-y-0 left-0 z-20 w-3" />
      ) : null}
      {phone ? (
        <>
          <button
            type="button"
            onClick={() => setSheet(true)}
            className="fixed bottom-[calc(16px+env(safe-area-inset-bottom)+var(--kb,0px))] right-[max(16px,env(safe-area-inset-right))] z-30 inline-flex min-h-12 items-center gap-2 rounded-full bg-ink px-5 text-14 font-semibold text-surface shadow-e3 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
          >
            <Icon icon={Scale} size={18} />
            Decide
            {findings ? <Badge tone="gate" count={findings} /> : null}
          </button>
          <Sheet open={sheet} onOpenChange={setSheet} title="Decide" description={item.title}>
            <ReviewPanel pid={pid} itemId={iid} project={project} item={item} items={items} />
          </Sheet>
        </>
      ) : null}
    </div>
  );
}
