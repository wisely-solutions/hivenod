import { ThreadInsightsView } from './ThreadInsights';

/**
 * Screen 5: Decision insights, on threads (slice 9): how your decisions at person steps go. (The
 * project decision log went with Projects, slice 11; /p/:pid/insights redirects here.)
 */
export function InsightsPage() {
  return <ThreadInsightsView />;
}
