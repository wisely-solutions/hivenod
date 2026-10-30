import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  check,
  describeQuery,
  type QueryShape,
} from '../../../../scripts/firestore-index-rules.mjs';
import {
  FEED_TYPES,
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
  it('the feed asks for at most 30 types (Firestore in-limit)', () => {
    expect(FEED_TYPES.length).toBeLessThanOrEqual(30);
  });
});
