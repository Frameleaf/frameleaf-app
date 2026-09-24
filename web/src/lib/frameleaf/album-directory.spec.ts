import { AlbumKind, AlbumUserRole, type AlbumResponseDto, type AlbumTreeResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import {
  arrangeAlbumDirectory,
  canDropOnCollection,
  canTakeOut,
  compareAlbums,
  defaultAlbumDirectoryView,
  matchesFilter,
  monthSpan,
  moveInOrder,
  moveTargets,
  normalizeAlbumDirectoryView,
  orderGroupOf,
  othersOf,
  placeBefore,
  removalOutcome,
} from './album-directory';

const me = userAdminFactory.build({ id: 'me' });
const jamie = userAdminFactory.build({ id: 'jamie' });

const owned = (overrides: Partial<AlbumResponseDto> = {}) =>
  albumFactory.build({
    kind: AlbumKind.Album,
    albumUsers: [{ user: me, role: AlbumUserRole.Owner }],
    ...overrides,
  });

const tree = (partial: Partial<AlbumTreeResponseDto>): AlbumTreeResponseDto => ({
  collections: [],
  albums: [],
  spaces: [],
  ...partial,
});

describe('album directory rules', () => {
  const family = owned({ id: 'family', albumName: 'Family', kind: AlbumKind.Collection, assetCount: 1 });
  const rockies = owned({
    id: 'rockies',
    albumName: 'Summer in the Rockies',
    parentId: 'family',
    assetCount: 10,
    updatedAt: '2026-09-10T00:00:00.000Z',
  });
  const winter = owned({
    id: 'winter',
    albumName: 'Winter 2026',
    parentId: 'family',
    assetCount: 3,
    updatedAt: '2026-09-01T00:00:00.000Z',
  });
  const trail = albumFactory.build({
    id: 'trail',
    albumName: 'Trail camera',
    kind: AlbumKind.Album,
    isSmart: true,
    assetCount: 7,
    albumUsers: [
      { user: jamie, role: AlbumUserRole.Owner },
      { user: me, role: AlbumUserRole.Viewer },
    ],
  });
  const space = owned({
    id: 'space',
    albumName: 'Family Space',
    kind: AlbumKind.Space,
    albumUsers: [
      { user: me, role: AlbumUserRole.Owner },
      { user: jamie, role: AlbumUserRole.Editor },
    ],
  });
  const directory = tree({
    collections: [{ collection: family, albums: [winter, rockies], albumCount: 2, assetCount: 14 }],
    albums: [trail],
    spaces: [space],
  });

  it('lays out shelves, standalone albums and spaces with totals', () => {
    const result = arrangeAlbumDirectory(directory, { filter: 'all', sort: 'modified', search: '', userId: 'me' });
    expect(result.shelves.map(({ collection, albums }) => [collection.id, albums.map(({ id }) => id)])).toEqual([
      ['family', ['rockies', 'winter']],
    ]);
    expect(result.albums.map(({ id }) => id)).toEqual(['trail']);
    expect(result.spaces.map(({ id }) => id)).toEqual(['space']);
    expect(result.totals).toEqual({ albums: 3, collections: 1, shared: 2 });
    expect(result.empty).toBe(false);
  });

  it('applies the filter pills', () => {
    expect(matchesFilter(trail, 'owned', 'me')).toBe(false);
    expect(matchesFilter(trail, 'shared', 'me')).toBe(true);
    expect(matchesFilter(trail, 'smart', 'me')).toBe(true);
    expect(matchesFilter(rockies, 'smart', 'me')).toBe(false);

    const smart = arrangeAlbumDirectory(directory, { filter: 'smart', sort: 'title', search: '', userId: 'me' });
    expect(smart.shelves).toEqual([]);
    expect(smart.albums.map(({ id }) => id)).toEqual(['trail']);
    expect(smart.spaces).toEqual([]);

    const mine = arrangeAlbumDirectory(directory, { filter: 'owned', sort: 'title', search: '', userId: 'me' });
    expect(mine.shelves[0].albums).toHaveLength(2);
    expect(mine.albums).toEqual([]);
  });

  it('keeps a shelf while searching when the collection itself matches, and hides it otherwise', () => {
    const byAlbum = arrangeAlbumDirectory(directory, { filter: 'all', sort: 'title', search: 'winter', userId: 'me' });
    expect(byAlbum.shelves[0].albums.map(({ id }) => id)).toEqual(['winter']);
    expect(byAlbum.albums).toEqual([]);

    const byCollection = arrangeAlbumDirectory(directory, {
      filter: 'all',
      sort: 'title',
      search: 'family',
      userId: 'me',
    });
    expect(byCollection.shelves[0].albums).toHaveLength(2);
    expect(byCollection.spaces.map(({ id }) => id)).toEqual(['space']);

    const miss = arrangeAlbumDirectory(directory, { filter: 'all', sort: 'title', search: 'zzz', userId: 'me' });
    expect(miss.empty).toBe(true);
    expect(miss.searching).toBe(true);
  });

  it('offers one sort menu whose orders put missing dates last', () => {
    const a = owned({ id: 'a', albumName: 'B', assetCount: 1, endDate: '2026-08-01T00:00:00.000Z' });
    const b = owned({ id: 'b', albumName: 'A', assetCount: 5, endDate: undefined });
    const c = owned({ id: 'c', albumName: 'C', assetCount: 3, endDate: '2026-09-01T00:00:00.000Z' });
    const ids = (sort: Parameters<typeof compareAlbums>[0]) => [a, b, c].sort(compareAlbums(sort)).map(({ id }) => id);
    expect(ids('title')).toEqual(['b', 'a', 'c']);
    expect(ids('items')).toEqual(['b', 'c', 'a']);
    expect(ids('recent-photo')).toEqual(['c', 'a', 'b']);
  });

  it('lets only the owner drag an album onto a collection they can edit', () => {
    expect(canDropOnCollection(winter, family, 'me')).toBe(false); // already inside
    expect(canDropOnCollection(trail, family, 'me')).toBe(false); // not the owner of the album
    const mine = owned({ id: 'mine' });
    expect(canDropOnCollection(mine, family, 'me')).toBe(true);
    expect(canDropOnCollection(mine, family, 'jamie')).toBe(false);
    expect(canDropOnCollection(family, family, 'me')).toBe(false);
    expect(canDropOnCollection(space, family, 'me')).toBe(false);
    expect(canDropOnCollection(mine, rockies, 'me')).toBe(false); // an album is not a container
    expect(canTakeOut(winter, 'me')).toBe(true);
    expect(canTakeOut(mine, 'me')).toBe(false);
    expect(canTakeOut(winter, 'jamie')).toBe(false);
  });

  it('offers only editable collections as move targets, never the album itself', () => {
    const readOnly = albumFactory.build({
      id: 'theirs',
      albumName: 'Their collection',
      kind: AlbumKind.Collection,
      albumUsers: [
        { user: jamie, role: AlbumUserRole.Owner },
        { user: me, role: AlbumUserRole.Viewer },
      ],
    });
    const withOther = tree({
      collections: [...directory.collections, { collection: readOnly, albums: [], albumCount: 0, assetCount: 0 }],
    });
    expect(moveTargets(withOther, rockies, 'me').map(({ collection }) => collection.id)).toEqual(['family']);
    expect(moveTargets(withOther, family, 'me')).toEqual([]);
  });

  it('lists the other members for the avatar stack', () => {
    expect(othersOf(trail, 'me').map(({ id }) => id)).toEqual(['jamie']);
    expect(othersOf(rockies, 'me')).toEqual([]);
  });

  it('formats a capture span', () => {
    expect(monthSpan(undefined, undefined, 'en-US')).toBe('');
    expect(monthSpan('2026-08-03T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'en-US')).toBe('Aug 2026');
    expect(monthSpan('2026-06-03T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'en-US')).toBe('Jun – Aug 2026');
    expect(monthSpan('2025-06-03T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'en-US')).toBe('2025 – 2026');
  });

  it('keeps the server\'s own order under "Custom order" (FL-52)', () => {
    const result = arrangeAlbumDirectory(directory, { filter: 'all', sort: 'custom', search: '', userId: 'me' });
    expect(result.shelves[0].albums.map(({ id }) => id)).toEqual(['winter', 'rockies']);
    expect(normalizeAlbumDirectoryView({ sort: 'custom' }).sort).toBe('custom');
  });

  it('names the group a custom order applies to (FL-52)', () => {
    expect(orderGroupOf(directory, 'family')).toEqual({ parentId: null, ids: ['family'] });
    expect(orderGroupOf(directory, 'rockies')).toEqual({ parentId: 'family', ids: ['winter', 'rockies'] });
    expect(orderGroupOf(directory, 'trail')).toEqual({ parentId: null, ids: ['trail'] });
    expect(orderGroupOf(directory, 'space')).toEqual({ parentId: null, ids: ['space'] });
    expect(orderGroupOf(directory, 'missing')).toBeUndefined();
  });

  it('moves an item one place earlier or later, and not past either end (FL-52)', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveInOrder(['a', 'b', 'c'], 'a', -1)).toBeUndefined();
    expect(moveInOrder(['a', 'b', 'c'], 'c', 1)).toBeUndefined();
    expect(moveInOrder(['a', 'b'], 'x', 1)).toBeUndefined();
  });

  it('places a dropped item before its target (FL-52)', () => {
    expect(placeBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(placeBefore(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
    expect(placeBefore(['a', 'b', 'c'], 'a', 'b')).toBeUndefined();
    expect(placeBefore(['a', 'b', 'c'], 'a', 'a')).toBeUndefined();
    expect(placeBefore(['a', 'b'], 'x', 'a')).toBeUndefined();
  });

  it('repairs a persisted view', () => {
    expect(normalizeAlbumDirectoryView(null)).toEqual(defaultAlbumDirectoryView);
    expect(normalizeAlbumDirectoryView({ filter: 'smart', sort: 'nope', view: 'list', collapsed: ['a', 1] })).toEqual({
      filter: 'smart',
      sort: 'modified',
      view: 'list',
      collapsed: ['a'],
    });
  });

  it('navigates once when someone leaves: the leave action, never the removal echo (FL-53)', () => {
    const page = { albumId: 'a', userId: 'me', isOwner: false, leftLocally: false };
    expect(removalOutcome({ albumId: 'b', userId: 'me' }, page)).toBe('ignore');
    expect(removalOutcome({ albumId: 'a', userId: 'jamie' }, page)).toBe('refresh');
    // Removed by the owner elsewhere: the page leaves and says so.
    expect(removalOutcome({ albumId: 'a', userId: 'me' }, page)).toBe('exit');
    // Left from this tab: the local announcement and the server echo are both ignored.
    expect(removalOutcome({ albumId: 'a', userId: 'me' }, { ...page, leftLocally: true })).toBe('ignore');
    expect(removalOutcome({ albumId: 'a', userId: 'me' }, { ...page, isOwner: true })).toBe('refresh');
  });
});
