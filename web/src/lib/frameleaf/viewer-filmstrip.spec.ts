import { AssetTypeEnum, AssetVisibility } from '@frameleaf/sdk';
import { trashFilmstripAsset } from '$lib/frameleaf/trash';
import { filmstripPlaceholder, filmstripWindow, type FilmstripMonth } from '$lib/frameleaf/viewer-filmstrip';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';

describe('filmstrip placeholders (V-17)', () => {
  it('draws an id-only item as a still that is not Locked or trashed', () => {
    const asset = filmstripPlaceholder({ id: 'a', ownerId: 'me' });
    expect(asset).toMatchObject({ id: 'a', ownerId: 'me', isImage: true, isVideo: false, isTrashed: false });
    expect(asset.visibility).toBe(AssetVisibility.Timeline);
  });

  it('keeps a trash row trashed, its kind and its Locked state', () => {
    const asset = trashFilmstripAsset(
      {
        id: 'b',
        type: AssetTypeEnum.Video,
        isLocked: true,
        isOffline: false,
        originalFileName: 'clip.mov',
        fileSizeInByte: 12,
        trashedAt: '2026-09-01T10:00:00.000Z',
      },
      'me',
    );
    expect(asset).toMatchObject({ id: 'b', isVideo: true, isTrashed: true, originalFileName: 'clip.mov' });
    expect(asset.visibility).toBe(AssetVisibility.Locked);
    expect(asset.localDateTime.year).toBe(2026);
  });
});

const month = (ids: string[], isLoaded = true): FilmstripMonth & { ids: string[] } => ({
  ids,
  isLoaded,
  getAssets: () => ids.map((id) => ({ id }) as TimelineAsset),
});
const ids = (assets: TimelineAsset[]) => assets.map(({ id }) => id);

describe('filmstripWindow (VIEWER-P4)', () => {
  it('reads only the requested neighbours after finding an item in a large month', () => {
    let reads = 0;
    const items = new Proxy(
      Array.from({ length: 1000 }, (_, index) => ({ id: String(index) }) as TimelineAsset),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            reads++;
          }
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const { assets } = filmstripWindow([{ isLoaded: true, getAssets: () => items }], 0, '500', 40);
    expect(ids(assets)).toEqual(Array.from({ length: 81 }, (_, index) => String(index + 460)));
    expect(reads).toBeLessThanOrEqual(582);
  });

  it('reads only the needed edge of each neighbouring month', () => {
    let reads = 0;
    const large = (prefix: string): FilmstripMonth => ({
      isLoaded: true,
      getAssets: () =>
        new Proxy(
          Array.from({ length: 1000 }, (_, index) => ({ id: `${prefix}${index}` }) as TimelineAsset),
          {
            get(target, key, receiver) {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                reads++;
              }
              return Reflect.get(target, key, receiver);
            },
          },
        ),
    });
    const { assets } = filmstripWindow([large('before'), month(['current']), large('after')], 1, 'current', 2);
    expect(ids(assets)).toEqual(['before998', 'before999', 'current', 'after0', 'after1']);
    expect(reads).toBeLessThanOrEqual(4);
  });

  it('runs across month edges, so a month of one item still has neighbours', () => {
    const months = [month(['a', 'b']), month(['c']), month(['d', 'e'])];
    const { assets, toLoad } = filmstripWindow(months, 1, 'c');
    expect(ids(assets)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(toLoad).toEqual([]);
  });

  it('stops at a month that is not loaded yet and asks for it, one on each side', () => {
    const before = month(['x'], false);
    const after = month(['y'], false);
    const months = [month(['z']), before, month(['c']), month(['d']), after, month(['w'])];
    const { assets, toLoad } = filmstripWindow(months, 2, 'c');
    expect(ids(assets)).toEqual(['c', 'd']);
    expect(toLoad).toEqual([before, after]);
  });

  it('keeps only the reach on each side and asks for nothing more once it is full', () => {
    const months = [month(['a', 'b', 'c']), month(['d', 'e', 'f']), month(['g', 'h']), month(['i'], false)];
    const { assets, toLoad } = filmstripWindow(months, 1, 'e', 2);
    expect(ids(assets)).toEqual(['c', 'd', 'e', 'f', 'g']);
    expect(toLoad).toEqual([]);
  });

  it('reads no further than the month reach, so empty months never load the whole library', () => {
    const far = month(['far'], false);
    const months = [month(['c']), month([]), month([]), far];
    const { assets, toLoad } = filmstripWindow(months, 0, 'c', 40, 2);
    expect(ids(assets)).toEqual(['c']);
    expect(toLoad).toEqual([]);
  });

  it('is empty when the open item is not in that month', () => {
    expect(filmstripWindow([month(['a'])], 0, 'missing')).toEqual({ assets: [], toLoad: [] });
    expect(filmstripWindow([month(['a'], false)], 0, 'a')).toEqual({ assets: [], toLoad: [] });
  });
});
