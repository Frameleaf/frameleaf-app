import * as sdk from '@frameleaf/sdk';
import { get } from 'svelte/store';
import { goto } from '$app/navigation';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { AlbumGroupBy, AlbumSortBy, SortOrder, albumViewSettings, locale } from '$lib/stores/preferences.store';
import {
  createAlbum,
  createAlbumAndRedirect,
  findGroupOptionMetadata,
  getSelectedAlbumGroupOption,
  matchesAlbumSearch,
  sortAlbums,
  sortOptionsMetadata,
  stringToSortOrder,
} from '$lib/utils/album-utils';
import { handleError } from '$lib/utils/handle-error';
import { albumFactory } from '@test-data/factories/album-factory';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  createAlbum: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const initialSettings = structuredClone(get(albumViewSettings));
const initialLocale = get(locale);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sdk.createAlbum).mockReset();
  locale.set('en');
});
afterEach(() => {
  vi.restoreAllMocks();
  albumViewSettings.set(structuredClone(initialSettings));
  locale.set(initialLocale);
});

describe('matchesAlbumSearch', () => {
  it('matches album names across punctuation boundaries', () => {
    const album = albumFactory.build({ albumName: '2004 - Family Vacation - Disneyland', description: '' });

    expect(matchesAlbumSearch(album, '2004 family vacation')).toBe(true);
  });

  it('matches query tokens regardless of order', () => {
    const album = albumFactory.build({ albumName: '2004 - Family Vacation - Disneyland', description: '' });

    expect(matchesAlbumSearch(album, 'vacation 2004 disneyland')).toBe(true);
  });

  it('matches tokens from the album description', () => {
    const album = albumFactory.build({ albumName: 'Disneyland', description: 'Family trip from 2004' });

    expect(matchesAlbumSearch(album, 'family 2004')).toBe(true);
  });

  it('filters out albums missing one or more query tokens', () => {
    const album = albumFactory.build({ albumName: '2004 - Family Vacation - Disneyland', description: '' });

    expect(matchesAlbumSearch(album, '2004 family beach')).toBe(false);
  });

  it('treats a blank query as a match', () => {
    const album = albumFactory.build({ albumName: 'Disneyland', description: '' });

    expect(matchesAlbumSearch(album, ' '.repeat(3))).toBe(true);
  });
});

describe('album sorting', () => {
  const names = ['z', 'ä', 'a', 'Ö', 'Å', 'a2', 'a10', 'A', 'é', 'é', '中文', '日本語', ''];

  it.each(['en', 'sv', 'de', 'fr', 'ja', 'zh'])(
    'preserves localeCompare ordering in %s and both directions',
    (language) => {
      locale.set(language);
      const albums = names.map((albumName, index) =>
        Object.freeze(albumFactory.build({ id: String(index), albumName })),
      );
      const before = [...albums];
      for (const order of [SortOrder.Asc, SortOrder.Desc]) {
        const expected = [...albums].sort(
          (a, b) => a.albumName.localeCompare(b.albumName, language) * (order === SortOrder.Desc ? -1 : 1),
        );
        const sorted = sortAlbums(albums, { sortBy: AlbumSortBy.Title, orderBy: order });
        expect(sorted).toEqual(expected);
        expect(sorted).not.toBe(albums);
        expect(albums).toEqual(before);
      }
    },
  );

  it('uses a fresh locale for each sort and keeps stable equivalent names', () => {
    const albums = ['ä', 'z', 'é', 'é'].map((albumName, index) => albumFactory.build({ id: String(index), albumName }));
    locale.set('en');
    const english = sortAlbums(albums, { sortBy: AlbumSortBy.Title, orderBy: 'asc' });
    locale.set('sv');
    const swedish = sortAlbums(albums, { sortBy: AlbumSortBy.Title, orderBy: 'asc' });
    expect(english.map((a) => a.id)).toEqual(['0', '2', '3', '1']);
    expect(swedish.map((a) => a.id)).toEqual(['2', '3', '1', '0']);
  });

  it('does not require a valid locale when no title comparisons are needed', () => {
    locale.set('bad_locale');
    expect(sortAlbums([], { sortBy: AlbumSortBy.Title, orderBy: 'asc' })).toEqual([]);
    const albums = [albumFactory.build()];
    expect(sortAlbums(albums, { sortBy: AlbumSortBy.Title, orderBy: 'asc' })).toEqual(albums);
    expect(() => sortAlbums([...albums, albumFactory.build()], { sortBy: AlbumSortBy.Title, orderBy: 'asc' })).toThrow(
      RangeError,
    );
  });

  const albums = [
    albumFactory.build({
      id: 'a',
      assetCount: 2,
      createdAt: '2020-01-01',
      updatedAt: '2022-01-01',
      startDate: '2012-01-01',
      endDate: '2022-01-01',
    }),
    albumFactory.build({
      id: 'b',
      assetCount: 4,
      createdAt: '2022-01-01',
      updatedAt: '2020-01-01',
      startDate: '2020-01-01',
      endDate: '2020-01-01',
    }),
    albumFactory.build({
      id: 'c',
      assetCount: 1,
      createdAt: '2021-01-01',
      updatedAt: '2021-01-01',
      startDate: '2018-01-01',
      endDate: '2021-01-01',
    }),
  ];
  it.each([
    [AlbumSortBy.ItemCount, ['c', 'a', 'b']],
    [AlbumSortBy.DateCreated, ['a', 'c', 'b']],
    [AlbumSortBy.DateModified, ['b', 'c', 'a']],
    [AlbumSortBy.MostRecentPhoto, ['b', 'c', 'a']],
    [AlbumSortBy.OldestPhoto, ['a', 'c', 'b']],
  ] as const)('retains %s sorting in both directions without mutating input', (sortBy, expected) => {
    expect(sortAlbums(albums, { sortBy, orderBy: 'asc' }).map((a) => a.id)).toEqual(expected);
    expect(sortAlbums(albums, { sortBy, orderBy: 'desc' }).map((a) => a.id)).toEqual([...expected].reverse());
    expect(albums.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it.each([AlbumSortBy.MostRecentPhoto, AlbumSortBy.OldestPhoto])('keeps unknown photo dates last for %s', (sortBy) => {
    const missing = ['unknown-one', 'unknown-two'].map((id) =>
      albumFactory.build({ id, startDate: undefined, endDate: undefined }),
    );
    for (const orderBy of ['asc', 'desc']) {
      expect(sortAlbums([missing[0], ...albums, missing[1]], { sortBy, orderBy }).slice(-2)).toEqual(missing);
    }
  });

  it('retains the modified-date fallback for an unknown sorting key', () => {
    expect(sortAlbums(albums, { sortBy: 'unknown', orderBy: 'desc' }).map((a) => a.id)).toEqual(['a', 'c', 'b']);
  });

  it.each(['constructor', '__proto__', 'toString', 'valueOf'])('uses the modified-date fallback for %s', (sortBy) => {
    expect(sortAlbums(albums, { sortBy, orderBy: 'desc' }).map((a) => a.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('album metadata', () => {
  it('retains all sort identifiers and default orders', () => {
    expect(sortOptionsMetadata.map(({ id }) => id)).toEqual(Object.values(AlbumSortBy));
    for (const metadata of sortOptionsMetadata) {
      expect(metadata.defaultOrder).toBe(metadata.id === AlbumSortBy.Title ? SortOrder.Asc : SortOrder.Desc);
    }
  });

  it('retains order normalization and fallback values', () => {
    expect(stringToSortOrder('desc')).toBe(SortOrder.Desc);
    expect(stringToSortOrder('DESC')).toBe(SortOrder.Asc);
    expect(stringToSortOrder('')).toBe(SortOrder.Asc);
  });

  it.each(Object.values(AlbumSortBy))('selects the permitted Year grouping for %s', (sortBy) => {
    const settings = { ...initialSettings, sortBy, groupBy: AlbumGroupBy.Year };
    albumViewSettings.set(settings);
    const disabled = sortBy === AlbumSortBy.DateCreated || sortBy === AlbumSortBy.DateModified;
    expect(findGroupOptionMetadata(AlbumGroupBy.Year).isDisabled()).toBe(disabled);
    expect(getSelectedAlbumGroupOption(settings)).toBe(disabled ? AlbumGroupBy.None : AlbumGroupBy.Year);
    expect(findGroupOptionMetadata(AlbumGroupBy.Owner).isDisabled()).toBe(false);
    expect(findGroupOptionMetadata('unknown').id).toBe(AlbumGroupBy.None);
  });
});

describe('album creation', () => {
  it.each([undefined, 'Trip'])('preserves the create payload and announces the returned album: %s', async (name) => {
    const album = albumFactory.build();
    vi.mocked(sdk.createAlbum).mockResolvedValue(album);
    const emit = vi.spyOn(eventManager, 'emit');
    await expect(createAlbum(name, ['asset'])).resolves.toBe(album);
    expect(sdk.createAlbum).toHaveBeenCalledWith({ createAlbumDto: { albumName: name ?? '', assetIds: ['asset'] } });
    expect(emit).toHaveBeenCalledWith('AlbumCreate', album);
  });

  it('reports a creation failure and does not redirect or announce an album', async () => {
    const error = new Error('failed');
    vi.mocked(sdk.createAlbum).mockRejectedValue(error);
    const emit = vi.spyOn(eventManager, 'emit');
    await expect(createAlbumAndRedirect()).resolves.toBeUndefined();
    expect(handleError).toHaveBeenCalledWith(error, expect.any(String));
    expect(emit).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
  });

  it('awaits navigation to the created album and propagates navigation failures', async () => {
    const album = albumFactory.build({ id: 'created' });
    vi.mocked(sdk.createAlbum).mockResolvedValue(album);
    const failure = new Error('navigation failed');
    vi.mocked(goto).mockRejectedValueOnce(failure);
    await expect(createAlbumAndRedirect('Trip')).rejects.toBe(failure);
    expect(goto).toHaveBeenCalledWith('/albums/created');
  });
});
