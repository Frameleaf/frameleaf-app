import { AssetOrder } from '@immich/sdk';
import {
  ALBUM_VIEW_SORT_KEY,
  albumOrderSort,
  effectiveAlbumSort,
  readAlbumViewSort,
  writeAlbumViewSort,
} from '$lib/frameleaf/album-view-sort';

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

describe('album view sort (FL-31)', () => {
  it('starts from the album’s shared display order', () => {
    expect(albumOrderSort(AssetOrder.Asc)).toBe('captured-asc');
    expect(albumOrderSort(AssetOrder.Desc)).toBe('captured-desc');
    expect(albumOrderSort()).toBe('captured-desc');
    expect(effectiveAlbumSort(null, AssetOrder.Asc)).toBe('captured-asc');
  });

  it('keeps the viewer’s own sort per album on this device, without touching the shared order', () => {
    const storage = memory();
    expect(writeAlbumViewSort(storage, 'album-1', 'filename', AssetOrder.Asc)).toBe('filename');
    expect(readAlbumViewSort(storage, 'album-1')).toBe('filename');
    expect(readAlbumViewSort(storage, 'album-2')).toBeNull();
    // the shared order changes: the viewer's own choice still wins for them
    expect(effectiveAlbumSort(readAlbumViewSort(storage, 'album-1'), AssetOrder.Desc)).toBe('filename');
  });

  it('follows the shared order again once the viewer picks it', () => {
    const storage = memory();
    writeAlbumViewSort(storage, 'album-1', 'captured-desc', AssetOrder.Asc);
    expect(writeAlbumViewSort(storage, 'album-1', 'captured-asc', AssetOrder.Asc)).toBeNull();
    expect(readAlbumViewSort(storage, 'album-1')).toBeNull();
  });

  it('reads anything unreadable as no choice', () => {
    const storage = memory();
    storage.setItem(ALBUM_VIEW_SORT_KEY, '{"album-1":"sideways","album-2":"rating"}');
    expect(readAlbumViewSort(storage, 'album-1')).toBeNull();
    expect(readAlbumViewSort(storage, 'album-2')).toBe('rating');
    storage.setItem(ALBUM_VIEW_SORT_KEY, 'not json');
    expect(readAlbumViewSort(storage, 'album-2')).toBeNull();
    expect(readAlbumViewSort(undefined, 'album-2')).toBeNull();
  });
});
