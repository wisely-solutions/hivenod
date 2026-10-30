import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  check,
  describeQuery,
  type QueryShape,
} from '../../../../scripts/firestore-index-rules.mjs';
import {
  feedChunks,
  IN_LIMIT,
  MAX_CHUNKS,
  THREAD_GROUPS,
  threadFeedConstraints,
  type ThreadGroupId,
} from './threadLogic';

// Tests run from apps/web (the jsdom environment has no file: URL for this module).
const config: unknown = JSON.parse(
  readFileSync(resolve(process.cwd(), '../../firestore.indexes.json'), 'utf8'),
);

/** Activity on threads (slice 9): one index (memberUid, type, at) serves every group. */
describe('the thread feed and Decision insights queries', () => {
  it.each(['', ...THREAD_GROUPS.map((g) => g.id)] as Array<'' | ThreadGroupId>)(
    'has an index for group %s',
    (group) => {
      const shape: QueryShape = {
        group: 'inboxEvents',
        scope: 'COLLECTION',
        filters: threadFeedConstraints('u1', group).map(([field, op]) => ({ field, op })),
        orders: [{ field: 'at', dir: 'desc' }],
      };
      const r = check(shape, config);
      expect(r.ok, `${describeQuery(shape)}: ${r.ok ? '' : r.missing}`).toBe(true);
    },
  );
  it('the all view asks in chunks of at most 30 types, each with an index', () => {
    const n = feedChunks('');
    expect(n).toBeLessThanOrEqual(MAX_CHUNKS);
    for (let c = 0; c < n; c++) {
      const cons = threadFeedConstraints('u1', '', c);
      expect((cons[1]![2] as string[]).length).toBeLessThanOrEqual(IN_LIMIT);
      expect(cons[1]![2] as string[]).not.toHaveLength(0);
    }
  });
  it('every group fits one query', () => {
    for (const g of THREAD_GROUPS) expect(feedChunks(g.id)).toBe(1);
  });
});
