import { INBOX_SOURCES } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { MESSAGE_SOURCES } from './sources';

describe('landing source chips', () => {
  it('name exactly the inbox sources Hivenod knows, nothing that cannot be connected', () => {
    expect(MESSAGE_SOURCES.map((s) => s.id).sort()).toEqual([...INBOX_SOURCES].sort());
  });
});
