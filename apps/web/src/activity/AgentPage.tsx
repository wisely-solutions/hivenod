import { isOlder, type Agent } from '@hive/shared';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { Bot, ChevronLeft, Pencil } from 'lucide-react';
import { useState } from 'react';
import { AgentSettings, PausedBanner } from '../agents/AgentSettings';
import { RemoveAgentDialog } from '../agents/RemoveAgentDialog';
import { RenameAgentDialog } from '../agents/RenameAgentDialog';
import { agentStatus, colorIndex, statusText } from '../agents/logic';
import { useLatestCli } from '../agents/latestCli';
import { useReady } from '../auth/context';
import type { Row } from '../lib/live';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { AgentAvatar } from '../ui/avatar';
import { Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { EmptyState, Skeleton } from '../ui/feedback';
import { Icon } from '../ui/icon';
import { useNow } from './data';
import { ThreadFeed } from './ThreadFeed';
import type { ThreadFeedFilters } from './threadLogic';

const route = getRouteApi('/agents/$id');

/**
 * One agent: presence, CLI version, settings, and what it did on your threads. (Its runs, tokens
 * and cost per run belonged to project items, removed in item OE8FmrTaIxFVGcaeGG3N, slice 11.)
 */
export function AgentPage() {
  const { id } = route.useParams();
  const { agents, agentsKnown } = useShellData();
  // An agent missing from a cached list may still exist: "not found" only on the server's word.
  const loading = !agentsKnown;
  const agent = agents.find((a) => a.id === id);
  if (!agent) {
    return (
      <>
        <BackLink />
        <PageHeader title={loading ? 'Agent' : 'Agent not found'} />
        {loading ? (
          <Skeleton className="h-24" />
        ) : (
          <EmptyState
            icon={Bot}
            title="No such agent"
            description="It may have been removed, or it belongs to another organization."
          />
        )}
      </>
    );
  }
  return <Profile id={id} agent={agent} />;
}

function BackLink() {
  return (
    <Link
      to="/agents"
      className="-ml-2 mb-1 inline-flex min-h-11 items-center gap-1 rounded-btn px-2 text-14 text-text-2 hover:text-ink"
    >
      <Icon icon={ChevronLeft} />
      Agents
    </Link>
  );
}

function Profile({ id, agent }: { id: string; agent: Row<Agent> }) {
  const { session } = useReady();
  const isAdmin = session.isAdmin;
  const now = useNow(15_000);
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const status = agentStatus(agent.data, now);
  const latestCli = useLatestCli();

  return (
    <>
      <BackLink />
      <header className="mb-6 flex items-start gap-4">
        <AgentAvatar
          name={agent.data.name}
          color={colorIndex(agent.data.color, id)}
          live={status.kind === 'online'}
          size="lg"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-28 font-semibold" data-testid="agent-name">
              {agent.data.name}
            </h1>
            {isAdmin && status.kind !== 'revoked' ? (
              <Button
                variant="ghost"
                className="shrink-0"
                aria-label={`Rename ${agent.data.name}`}
                leading={<Icon icon={Pencil} />}
                onClick={() => setRenaming(true)}
              >
                Rename
              </Button>
            ) : null}
          </div>
          <p
            aria-live="polite"
            className={cn(
              'flex flex-wrap items-center gap-x-2 text-14',
              status.kind === 'paused'
                ? 'text-gate-text'
                : status.kind === 'online'
                  ? 'text-approve-text'
                  : 'text-text-2',
            )}
          >
            {status.kind === 'paused' ? 'Paused' : statusText(status, now)}
          </p>
          {agent.data.scope === 'inbox' ? <p className="text-13 text-text-2">Inbox only</p> : null}
          {agent.data.cliVersion && status.kind !== 'revoked' ? (
            <p className="text-13 text-text-2" data-testid="cli-version">
              Hivenod CLI {agent.data.cliVersion}
              {isOlder(agent.data.cliVersion, latestCli) ? (
                <>
                  {' · '}
                  <span className="font-medium text-gate-text" data-update-available="">
                    Update available: {agent.data.cliVersion} → {latestCli}
                  </span>{' '}
                  (run <code>hivenod update</code>, then restart the session)
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        {isAdmin && status.kind === 'revoked' ? (
          <Button variant="sendback" className="ml-auto shrink-0" onClick={() => setRemoving(true)}>
            Remove…
          </Button>
        ) : null}
      </header>
      <RenameAgentDialog agent={renaming ? agent : null} onClose={() => setRenaming(false)} />
      <RemoveAgentDialog
        agent={removing ? agent : null}
        onClose={() => setRemoving(false)}
        onRemoved={() => void navigate({ to: '/agents' })}
      />

      <PausedBanner agentId={id} agent={agent.data} isAdmin={isAdmin} />
      <AgentSettings agentId={id} agent={agent.data} />

      <section aria-labelledby="agent-activity-h" className="mt-8">
        <h2 id="agent-activity-h" className="mb-3">
          <Eyebrow>Activity on your threads</Eyebrow>
        </h2>
        <ThreadFeed
          filters={agentFeedFilters(id)}
          emptyText={`What ${agent.data.name} does on your threads shows up here, newest first.`}
        />
      </section>
    </>
  );
}

const feedFilters = new Map<string, ThreadFeedFilters>();
/** One stable filter object per agent (the feed memoises on it). */
function agentFeedFilters(id: string): ThreadFeedFilters {
  let f = feedFilters.get(id);
  if (!f) feedFilters.set(id, (f = { group: '', actor: id }));
  return f;
}
