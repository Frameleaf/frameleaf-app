import { AssetOrder } from '@immich/sdk';
import { describe, expect, it, vi } from 'vitest';
import { SPACE_TIMELINE_PAGE } from '$lib/frameleaf/shared-space';
import { SpacePhotoSet, type SpacePageFetcher } from '$lib/frameleaf/space-photos.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';

const page = (ids: string[], nextPage: string | null) => ({
  items: ids.map((id) => assetFactory.build({ id })),
  nextPage,
});

describe('SpacePhotoSet', () => {
  it('asks for the space, one page at a time, in the space order', async () => {
    const fetch = vi.fn<SpacePageFetcher>().mockResolvedValue(page(['a', 'b'], '2'));
    const photos = new SpacePhotoSet({ spaceId: 'space-1', order: AssetOrder.Asc, fetch });

    await photos.load(1);

    expect(fetch).toHaveBeenCalledWith({
      spaceId: 'space-1',
      page: 1,
      size: SPACE_TIMELINE_PAGE,
      order: AssetOrder.Asc,
    });
    expect(photos.assets.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(photos.page).toBe(1);
    expect(photos.exhausted).toBe(false);
  });

  it('appends later pages without repeating an item and stops at the end', async () => {
    const fetch = vi
      .fn<SpacePageFetcher>()
      .mockResolvedValueOnce(page(['a', 'b'], '2'))
      .mockResolvedValueOnce(page(['b', 'c'], null));
    const photos = new SpacePhotoSet({ spaceId: 'space-1', fetch });

    await photos.load(1);
    await photos.loadMore();

    expect(photos.assets.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    expect(photos.exhausted).toBe(true);
    expect(photos.loadMore()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('records a failure, reports it once, and retries from where it stopped', async () => {
    const onError = vi.fn();
    const fetch = vi
      .fn<SpacePageFetcher>()
      .mockResolvedValueOnce(page(['a'], '2'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page(['b'], null));
    const photos = new SpacePhotoSet({ spaceId: 'space-1', fetch, onError });

    await photos.load(1);
    await photos.loadMore();
    expect(photos.failed).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(photos.loadMore()).toBeUndefined();

    await photos.retry();
    expect(fetch).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(photos.failed).toBe(false);
    expect(photos.assets.map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('drops an answer to a request a reload has replaced', async () => {
    let resolveStale: (value: Awaited<ReturnType<SpacePageFetcher>>) => void = () => {};
    const fetch = vi
      .fn<SpacePageFetcher>()
      .mockResolvedValueOnce(page(['a'], '2'))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveStale = resolve)))
      .mockResolvedValueOnce(page(['z'], null));
    const photos = new SpacePhotoSet({ spaceId: 'space-1', fetch });

    await photos.load(1);
    const stale = photos.loadMore();
    await photos.reload();
    resolveStale(page(['b'], null));
    await stale;

    expect(photos.assets.map(({ id }) => id)).toEqual(['z']);
    expect(photos.loading).toBe(false);
  });

  it('removes and replaces items in place so the grid and the viewer agree', async () => {
    const fetch = vi.fn<SpacePageFetcher>().mockResolvedValue(page(['a', 'b', 'c'], null));
    const photos = new SpacePhotoSet({ spaceId: 'space-1', fetch });
    await photos.load(1);

    photos.remove(['b']);
    photos.replace(assetFactory.build({ id: 'c', isFavorite: true }));

    expect(photos.assets.map(({ id }) => id)).toEqual(['a', 'c']);
    expect(photos.assets[1].isFavorite).toBe(true);
    expect(photos.indexOf('c')).toBe(1);
    expect(photos.indexOf('b')).toBe(-1);
    expect(photos.indexOf(undefined)).toBe(-1);
  });
});
