/* eslint-disable @typescript-eslint/no-explicit-any */
import { DELETE_FIELD, SERVER_TIME } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { toRestWrites } from './leaveBeacon';

describe('toRestWrites', () => {
  it('turns a set with server time into fields plus a transform', () => {
    const [w] = toRestWrites('db/documents', [
      { kind: 'set', path: 'w/e1', data: { n: 'x', at: SERVER_TIME, c: 2, arr: ['a'] } },
    ]) as Record<string, any>[] as [any];
    expect(w.update.name).toBe('db/documents/w/e1');
    expect(w.update.fields.n).toEqual({ stringValue: 'x' });
    expect(w.update.fields.c).toEqual({ integerValue: '2' });
    expect(w.update.fields.at).toBeUndefined();
    expect(w.updateTransforms).toEqual([{ fieldPath: 'at', setToServerValue: 'REQUEST_TIME' }]);
  });

  it('nests dotted update keys and masks deletes', () => {
    const [w] = toRestWrites('db/documents', [
      {
        kind: 'update',
        path: 'w/i',
        data: { 'gate.approvals.u1': true, claim: DELETE_FIELD, 'claim2.at': SERVER_TIME },
      },
    ]) as Record<string, any>[] as [any];
    expect(w.update.fields.gate.mapValue.fields.approvals.mapValue.fields.u1).toEqual({
      booleanValue: true,
    });
    expect(w.updateMask.fieldPaths).toEqual(['gate.approvals.u1', 'claim']);
    expect(w.updateTransforms[0].fieldPath).toBe('claim2.at');
    expect(w.currentDocument).toEqual({ exists: true });
  });
});
