import type { AlbumResponseDto } from '@frameleaf/sdk';
import { get } from 'svelte/store';
import { AlbumGroupBy, AlbumSortBy, SortOrder, albumViewSettings, locale } from '$lib/stores/preferences.store';
import {
  findGroupOptionMetadata,
  groupAlbumsByYear,
  groupAlbumsByOwner,
  getSelectedAlbumGroupOption,
  createAlbumSearchPredicate,
  sortAlbums,
  sortOptionsMetadata,
  stringToSortOrder,
} from '$lib/utils/album-utils';
import * as stringUtils from '$lib/utils/string-utils';
import { albumFactory } from '@test-data/factories/album-factory';

const initialSettings = structuredClone(get(albumViewSettings));
const initialLocale = get(locale);
beforeEach(() => {
  vi.clearAllMocks();
  locale.set('en');
});
afterEach(() => {
  vi.restoreAllMocks();
  albumViewSettings.set(structuredClone(initialSettings));
  locale.set(initialLocale);
});

describe('createAlbumSearchPredicate', () => {
  it('matches album names across punctuation boundaries', () => {
    const album = albumFactory.build({ albumName: '2004 - Family Vacation - Disneyland', description: '' });

    expect(createAlbumSearchPredicate('2004 family vacation')(album)).toBe(true);
  });

  it('matches query tokens regardless of order', () => {
    const album = albumFactory.build({ albumName: '2004 - Family Vacation - Disneyland', description: '' });

    expect(createAlbumSearchPredicate('vacation 2004 disneyland')(album)).toBe(true);
  });

  it('matches tokens from the album description', () => {
    const album = albumFactory.build({ albumName: 'Disneyland', description: 'Family trip from 2004' });

    expect(createAlbumSearchPredicate('family 2004')(album)).toBe(true);
  });

  it('filters out albums missing one or more query tokens', () => {
    const album = albumFactory.build({ albumName: '2004 - Family Vacation - Disneyland', description: '' });

    expect(createAlbumSearchPredicate('2004 family beach')(album)).toBe(false);
  });

  it('treats a blank query as a match', () => {
    const album = albumFactory.build({ albumName: 'Disneyland', description: '' });

    expect(createAlbumSearchPredicate(' '.repeat(3))(album)).toBe(true);
  });

  it('normalizes a query once for the list and keeps predicates independent', () => {
    const normalize = vi.spyOn(stringUtils, 'normalizeSearchString');
    const albums = [
      albumFactory.build({ albumName: 'Family vacation 2024', description: '' }),
      albumFactory.build({ albumName: 'Winter', description: '' }),
      albumFactory.build({ albumName: 'Vacation - Family', description: '' }),
    ];
    const query = 'vacation family';
    const predicate = createAlbumSearchPredicate(query);
    expect(albums.filter((album) => predicate(album))).toEqual([albums[0], albums[2]]);
    expect(normalize.mock.calls.filter(([text]) => text === query)).toHaveLength(1);
    expect(albums.filter(createAlbumSearchPredicate('winter'))).toEqual([albums[1]]);
    expect(albums.filter((album) => predicate(album))).toEqual([albums[0], albums[2]]);
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

describe('album grouping contracts', () => {
  it.each([SortOrder.Asc, SortOrder.Desc])('keeps unknown years last and membership stable (%s)', (order) => {
    const albums = [
      albumFactory.build({ id: 'unknown', endDate: undefined, startDate: undefined }),
      albumFactory.build({ id: 'recent', endDate: '2024-06-01', startDate: '2010-06-01' }),
      albumFactory.build({ id: 'old', endDate: '2020-06-01', startDate: '2015-06-01' }),
      albumFactory.build({ id: 'same', endDate: '2024-07-01', startDate: '2010-07-01' }),
    ];
    const groups = groupAlbumsByYear(albums, order, false, 'Unknown');
    expect(groups.map(({ id }) => id)).toEqual(
      order === SortOrder.Asc ? ['2020', '2024', 'Unknown'] : ['2024', '2020', 'Unknown'],
    );
    expect(groups.find(({ id }) => id === '2024')?.albums).toEqual([albums[1], albums[3]]);
    expect(groupAlbumsByYear(albums, order, true, 'Unknown').map(({ id }) => id)).toEqual(
      order === SortOrder.Asc ? ['2010', '2015', 'Unknown'] : ['2015', '2010', 'Unknown'],
    );
    expect(albums.map(({ id }) => id)).toEqual(['unknown', 'recent', 'old', 'same']);
    expect(groups[0].albums[0]).toBe(albums[order === SortOrder.Asc ? 2 : 1]);
  });

  it('retains invalid-date group placement and arbitrary translated missing-year keys', () => {
    const albums = [
      albumFactory.build({ id: 'bad', endDate: 'invalid' }),
      albumFactory.build({ id: 'good', endDate: '2024-06-01' }),
      albumFactory.build({ id: 'missing', endDate: undefined }),
    ];
    expect(groupAlbumsByYear(albums, SortOrder.Asc, false, '__proto__').map(({ id }) => id)).toEqual([
      '2024',
      'NaN',
      '__proto__',
    ]);
    expect(groupAlbumsByYear([], SortOrder.Asc, false, 'Unknown')).toEqual([]);
  });

  const ownerAlbum = (id: string, name: string) =>
    albumFactory.build({
      albumUsers: [{ user: { id, name } } as AlbumResponseDto['albumUsers'][number]],
    });

  it.each(['en', 'sv', 'de'])(
    'sorts owner groups with %s collation and current user at the ordered edge',
    (language) => {
      const albums = [
        ownerAlbum('mine', 'Current'),
        ownerAlbum('a', 'ä'),
        ownerAlbum('z', 'z'),
        ownerAlbum('b', 'a'),
        ownerAlbum('a', 'Changed name'),
      ];
      for (const order of [SortOrder.Asc, SortOrder.Desc]) {
        const sign = order === SortOrder.Desc ? -1 : 1;
        const others = [albums[1], albums[2], albums[3]]
          .sort((a, b) => a.albumUsers[0].user.name.localeCompare(b.albumUsers[0].user.name, language) * sign)
          .map((album) => album.albumUsers[0].user.id);
        const groups = groupAlbumsByOwner(albums, order, 'mine', language, 'My albums');
        expect(groups.map(({ id }) => id)).toEqual(order === SortOrder.Asc ? ['mine', ...others] : [...others, 'mine']);
        expect(groups.find(({ id }) => id === 'mine')?.name).toBe('My albums');
        expect(groups.find(({ id }) => id === 'a')?.name).toBe('ä');
        expect(groups.find(({ id }) => id === 'a')?.albums).toEqual([albums[1], albums[4]]);
      }
    },
  );

  it('retains numeric key enumeration and stable equal owner names', () => {
    const albums = [ownerAlbum('10', 'Same'), ownerAlbum('2', 'Same'), ownerAlbum('__proto__', 'Same')];
    expect(groupAlbumsByOwner(albums, SortOrder.Asc, 'mine', 'en', 'My albums').map(({ id }) => id)).toEqual([
      '2',
      '10',
      '__proto__',
    ]);
  });

  it('does not construct a collator when no owner name comparison is needed', () => {
    expect(groupAlbumsByOwner([], SortOrder.Asc, 'mine', 'bad_locale', 'My albums')).toEqual([]);
    expect(
      groupAlbumsByOwner(
        [ownerAlbum('mine', 'Current'), ownerAlbum('other', 'Other')],
        SortOrder.Asc,
        'mine',
        'bad_locale',
        'My albums',
      ).map(({ id }) => id),
    ).toEqual(['mine', 'other']);
    expect(() =>
      groupAlbumsByOwner(
        [ownerAlbum('a', 'A'), ownerAlbum('b', 'B')],
        SortOrder.Asc,
        'mine',
        'bad_locale',
        'My albums',
      ),
    ).toThrow(RangeError);
  });
});
