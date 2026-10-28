import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  check,
  describeQuery,
  type QueryShape,
} from '../../../../scripts/firestore-index-rules.mjs';
import { feedConstraints, TYPE_GROUPS, type FeedFilters } from './logic';

// Tests run from apps/web (the jsdom environment has no file: URL for this module).
const config: unknown = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../firestore.indexes.json'), 'utf8'),
);

/**
 * The activity feed builds its query from feedConstraints() at run time, so the static index
 * guard (scripts/check-firestore-indexes.mjs) allowlists it; this test checks every filter
 * combination instead, with the same rules.
 */
describe('the activity feed queries', () => {
  const combos: FeedFilters[] = [];
  for (const projectId of ['', 'p1'])
    for (const actor of ['all', 'people', 'agents', 'uid-1'])
      for (const group of ['', ...TYPE_GROUPS.map((g) => g.id)] as FeedFilters['group'][])
        combos.push({ projectId, actor, group });

  it.each(combos)('has an index for %o', (filters) => {
    const shape: QueryShape = {
      group: 'events',
      scope: 'COLLECTION',
      filters: feedConstraints(filters).map(([field, op]) => ({ field, op })),
      orders: [{ field: 'at', dir: 'desc' }],
    };
    const r = check(shape, config);
    expect(r.ok, `${describeQuery(shape)}: ${r.ok ? '' : r.missing}`).toBe(true);
  });
});
