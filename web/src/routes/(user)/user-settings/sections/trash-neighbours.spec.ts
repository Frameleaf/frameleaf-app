import { resolveTrashNeighbours } from './trash-neighbours';

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
