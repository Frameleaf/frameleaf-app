import { positionInList, positionInTimeline } from '$lib/frameleaf/viewer-position';

const month = (count: number, ids: string[] = []) => ({
  assetsCount: count,
  getAssets: () => ids.map((id) => ({ id })),
});

describe('viewer position (V-12)', () => {
  it('counts the items of earlier months without loading them', () => {
    const months = [month(10), month(3, ['a', 'b', 'c']), month(7)];
    expect(positionInTimeline(months, 'b')).toEqual({ index: 11, total: 20 });
  });

  it('has no position for an item it cannot place', () => {
    expect(positionInTimeline([month(4)], 'x')).toBeNull();
    expect(positionInList(['a'], 'x')).toBeNull();
  });

  it('reads a caller-held list directly', () => {
    expect(positionInList(['a', 'b', 'c'], 'c')).toEqual({ index: 2, total: 3 });
  });
});
