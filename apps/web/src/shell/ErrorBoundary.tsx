import { TriangleAlert } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/feedback';

export function ErrorFallback({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="py-10">
      <EmptyState
        icon={TriangleAlert}
        title="Something went wrong"
        description="This screen hit a problem. Your work is safe. Try again, and if it keeps happening, reload the app."
        action={<Button onClick={onRetry}>Try again</Button>}
      />
    </div>
  );
}

/** Catches render errors below it and offers a retry. Remount it (key) to reset on navigation. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('Screen error', error);
  }
  render() {
    if (this.state.failed)
      return <ErrorFallback onRetry={() => this.setState({ failed: false })} />;
    return this.props.children;
  }
}
