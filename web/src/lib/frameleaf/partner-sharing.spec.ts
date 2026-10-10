import { backfillProgress, originOwnerName, PARTNER_SHARED_ITEMS } from '$lib/frameleaf/partner-sharing';

describe('partner sharing (prototype SharingAccess.jsx partner card)', () => {
  it('lists what a partner receives in prototype order', () => {
    expect(PARTNER_SHARED_ITEMS.map(({ id }) => id)).toEqual([
      'assets',
      'albums',
      'tags',
      'people',
      'details',
      'locked',
    ]);
  });

  it('reports copy progress, clamped and with unknown states as queued', () => {
    expect(backfillProgress({ state: 'running', total: 3200, done: 1240 })).toEqual({
      state: 'running',
      percent: 38,
      total: 3200,
      done: 1240,
    });
    expect(backfillProgress({ state: 'done', total: 10, done: 7 })).toEqual({
      state: 'done',
      percent: 100,
      total: 10,
      done: 10,
    });
    expect(backfillProgress({ state: 'running', total: 5, done: 9 })?.percent).toBe(100);
    expect(backfillProgress({ state: 'running', total: 0, done: 0 })?.percent).toBe(0);
    expect(backfillProgress({ state: 'weird', total: 4, done: 1 })?.state).toBe('queued');
    // the server's first state is `pending`
    expect(backfillProgress({ state: 'pending', total: 0, done: 0 })?.state).toBe('queued');
    expect(backfillProgress(undefined)).toBeUndefined();
    expect(backfillProgress(null)).toBeUndefined();
  });

  it('names the original owner of a copied item, or nothing for own items', () => {
    expect(originOwnerName({ rootOwnerId: 'u1', rootOwnerName: ' Jamie ' })).toBe('Jamie');
    expect(originOwnerName({ rootOwnerId: 'u1', rootOwnerName: '' })).toBeUndefined();
    expect(originOwnerName(null)).toBeUndefined();
    expect(originOwnerName(undefined)).toBeUndefined();
  });
});
