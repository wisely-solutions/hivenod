import type { Project } from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useCapture } from '../capture/CaptureProvider';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Input } from '../ui/form';
import { Eyebrow } from '../ui/badge';
import type { FirstRunState } from './firstRun';
import { WelcomeProject } from './WelcomeProject';

const linkBtn =
  'inline-flex min-h-11 items-center justify-center rounded-btn border border-line-strong bg-surface px-4 text-14 font-medium text-ink hover:bg-canvas';

function Step({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3 py-3" data-done={done}>
      <span
        aria-hidden
        className={cn(
          'mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-12 font-medium',
          done
            ? 'border-transparent bg-approve-solid text-on-solid'
            : 'border-line-strong text-text-2',
        )}
      >
        {done ? <Check size={14} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('text-14 font-medium', done ? 'text-text-2 line-through' : 'text-ink')}>
          {title}
          <span className="sr-only">{done ? ' (done)' : ''}</span>
        </p>
        {done ? null : <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}

/** Three steps from an empty workspace to a first idea and a connected agent (card tIG1wr4Z). */
export function FirstRun({
  state,
  project,
  onDismiss,
}: {
  state: FirstRunState;
  /** Where a typed idea lands: the first live project. */
  project: { id: string; data: Project } | null;
  onDismiss: () => void;
}) {
  const { add } = useCapture();
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  function submit() {
    const t = title.trim();
    if (!t) return setError('Give it a title.');
    if (!project) return;
    add({ pid: project.id, project: project.data, title: t, type: 'idea' });
    setTitle('');
    setError('');
  }
  return (
    <section
      aria-label="Get started"
      className="rounded-card border border-line bg-surface p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <Eyebrow>Get started</Eyebrow>
          <h2 className="mt-1 text-18 font-semibold">Three steps to your first run</h2>
        </div>
        <Button variant="ghost" onClick={onDismiss} aria-label="Dismiss the checklist">
          Dismiss
        </Button>
      </div>
      <ol className="mt-2 divide-y divide-line">
        <Step n={1} done={state.project} title="What will your agents work on?">
          <p className="mb-3 text-14 text-text-2">
            Pick a template: the project comes with its process, agent steps and decision points.
          </p>
          <WelcomeProject />
        </Step>
        <Step n={2} done={state.idea} title="Add your first idea">
          {project ? (
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-start"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <div className="min-w-0 flex-1">
                <Input
                  label={`Idea for ${project.data.name}`}
                  placeholder="Write the landing page copy"
                  autoComplete="off"
                  maxLength={200}
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setError('');
                  }}
                  error={error}
                />
              </div>
              <Button type="submit" className="sm:mt-6">
                Add idea
              </Button>
            </form>
          ) : (
            <p className="text-14 text-text-2">Create a project first.</p>
          )}
        </Step>
        <Step n={3} done={state.agent} title="Connect Claude Code">
          <p className="mb-2 text-14 text-text-2">
            Nothing moves until an agent picks your idea up. One line in a terminal, one click here.
          </p>
          <Link to="/connect" className={linkBtn}>
            Connect Claude Code
          </Link>
        </Step>
      </ol>
    </section>
  );
}
