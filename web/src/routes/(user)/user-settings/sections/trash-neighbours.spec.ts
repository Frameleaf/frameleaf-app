import { resolveTrashNeighbours, survivingTrashNeighbours } from './trash-neighbours';

const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('resolveTrashNeighbours', () => {
  it('keeps the neighbours the viewer already looked up', async () => {
    const loadAsset = vi.fn((id?: string) => Promise.resolve(id));
    await expect(
      resolveTrashNeighbours(items, 'b', { nextAsset: 'next', previousAsset: 'previous' }, loadAsset),
    ).resolves.toEqual({ nextAsset: 'next', previousAsset: 'previous' });
    expect(loadAsset).not.toHaveBeenCalled();
  });

  it('looks the neighbours up from the trash order when a second delete beats the lookup', async () => {
    const loadAsset = vi.fn((id?: string) => Promise.resolve(id ? `asset-${id}` : undefined));
    await expect(resolveTrashNeighbours(items, 'b', {}, loadAsset)).resolves.toEqual({
      nextAsset: 'asset-c',
      previousAsset: 'asset-a',
    });
  });

  it('has no previous item for the first entry and no next item for the last', async () => {
    const loadAsset = vi.fn((id?: string) => Promise.resolve(id ? `asset-${id}` : undefined));
    await expect(resolveTrashNeighbours(items, 'a', {}, loadAsset)).resolves.toEqual({
      nextAsset: 'asset-b',
      previousAsset: undefined,
    });
    await expect(resolveTrashNeighbours(items, 'c', {}, loadAsset)).resolves.toEqual({
      nextAsset: undefined,
      previousAsset: 'asset-b',
    });
  });

  it('looks nothing up for an item that is no longer listed', async () => {
    const loadAsset = vi.fn((id?: string) => Promise.resolve(id));
    await expect(resolveTrashNeighbours(items, 'z', {}, loadAsset)).resolves.toEqual({
      nextAsset: undefined,
      previousAsset: undefined,
    });
    expect(loadAsset).not.toHaveBeenCalled();
  });
});

describe('survivingTrashNeighbours', () => {
  const trash = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];

  it('prefers the neighbours the viewer already looked up', () => {
    expect(survivingTrashNeighbours(trash, 'c', { nextAsset: { id: 'd' }, previousAsset: { id: 'b' } }, ['c'])).toEqual(
      ['d', 'b'],
    );
  });

  it('skips neighbours that left the trash in the same change', () => {
    expect(
      survivingTrashNeighbours(trash, 'c', { nextAsset: { id: 'd' }, previousAsset: { id: 'b' } }, ['c', 'd', 'b']),
    ).toEqual(['e', 'a']);
  });

  it('uses the trash order when the neighbour lookup has not finished', () => {
    expect(survivingTrashNeighbours(trash, 'e', {}, ['e'])).toEqual(['d']);
    expect(survivingTrashNeighbours(trash, 'a', {}, ['a', 'b'])).toEqual(['c']);
  });

  it('has nothing to show when everything left, or the item is no longer listed and nothing is known', () => {
    expect(survivingTrashNeighbours([{ id: 'a' }], 'a', {}, ['a'])).toEqual([]);
    expect(survivingTrashNeighbours(trash, 'z', {}, ['z'])).toEqual([]);
  });
});
