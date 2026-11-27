import { AlbumKind, AlbumUserRole, type AlbumResponseDto, type AlbumTreeResponseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import {
  albumAncestors,
  arrangeInGroup,
  browseAlbumDirectory,
  canEdit,
  isOwner,
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

  const browse = (options: Partial<Parameters<typeof browseAlbumDirectory>[1]> = {}) =>
    browseAlbumDirectory(directory, {
      inside: null,
      filter: 'all',
      sort: 'modified',
      order: 'desc',
      group: 'kind',
      hideEmpty: true,
      collectionsFirst: false,
      search: '',
      userId: 'me',
      ...options,
    });
  const sections = (result: ReturnType<typeof browseAlbumDirectory>) =>
    result.groups.map(({ id, albums }) => [id, albums.map((album) => album.id)]);

  it('lists the top level grouped by kind, with a collection as one item and totals (FL-1836)', () => {
    const result = browse();
    expect(sections(result)).toEqual([
      ['kind:collections', ['family']],
      ['kind:smart', ['trail']],
      ['kind:spaces', ['space']],
    ]);
    expect(result.inside.get('family')).toBe(2);
    // A collection's items are the server's total for it, everything inside included.
    expect(result.items.get('family')).toBe(14);
    expect(result.totals).toEqual({ albums: 3, collections: 1, spaces: 1, emptyHidden: 0 });
    expect(result.path).toEqual([]);
    expect(result.empty).toBe(false);
  });

  it('opens a collection in place, with the path down to it (FL-1836)', () => {
    const result = browse({ inside: 'family', group: 'none' });
    expect(result.here?.id).toBe('family');
    expect(result.path.map(({ id }) => id)).toEqual(['family']);
    expect(sections(result)).toEqual([['none', ['rockies', 'winter']]]);
  });

  it('applies the filter pills, including albums made from folders', () => {
    expect(matchesFilter(trail, 'owned', 'me')).toBe(false);
    expect(matchesFilter(trail, 'shared', 'me')).toBe(true);
    expect(matchesFilter(trail, 'smart', 'me')).toBe(true);
    expect(matchesFilter(rockies, 'smart', 'me')).toBe(false);
    expect(matchesFilter(rockies, 'folders', 'me')).toBe(false);
    expect(matchesFilter(owned({ folderAlbum: { libraryId: 'l', folderPath: '/p' } }), 'folders', 'me')).toBe(true);

    expect(sections(browse({ filter: 'smart' }))).toEqual([['kind:smart', ['trail']]]);
    expect(sections(browse({ filter: 'owned' }))).toEqual([
      ['kind:collections', ['family']],
      ['kind:spaces', ['space']],
    ]);
  });

  it('searches every level below where you are, and says when nothing matches', () => {
    const byAlbum = browse({ search: 'winter', group: 'none' });
    expect(byAlbum.searching).toBe(true);
    expect(sections(byAlbum)).toEqual([['none', ['winter']]]);

    const insideFamily = browse({ inside: 'family', search: 'summer', group: 'none' });
    expect(sections(insideFamily)).toEqual([['none', ['rockies']]]);

    const miss = browse({ search: 'zzz' });
    expect(miss.empty).toBe(true);
  });

  it('hides empty albums, and collections holding only empty albums, unless asked (FL-1836)', () => {
    const empty = owned({ id: 'empty', albumName: 'Empty', assetCount: 0 });
    const shell = owned({ id: 'shell', albumName: 'Shell', kind: AlbumKind.Collection, assetCount: 0 });
    const hollow = owned({ id: 'hollow', albumName: 'Hollow', parentId: 'shell', assetCount: 0 });
    const withEmpties = tree({
      ...directory,
      collections: [...directory.collections, { collection: shell, albums: [hollow], albumCount: 1, assetCount: 0 }],
      albums: [...directory.albums, empty],
    });
    const options = {
      inside: null,
      filter: 'all' as const,
      sort: 'title' as const,
      order: 'asc' as const,
      group: 'none' as const,
      collectionsFirst: false,
      search: '',
      userId: 'me',
    };
    const hidden = browseAlbumDirectory(withEmpties, { ...options, hideEmpty: true });
    expect(hidden.listed.map(({ id }) => id)).toEqual(['family', 'space', 'trail']);
    expect(hidden.totals.emptyHidden).toBe(2);
    const shown = browseAlbumDirectory(withEmpties, { ...options, hideEmpty: false });
    expect(shown.listed.map(({ id }) => id)).toEqual(['empty', 'family', 'space', 'shell', 'trail']);
    expect(shown.totals.emptyHidden).toBe(0);
  });

  it('groups by source, year, month and owner, with sections in a fixed or dated order (FL-1836)', () => {
    const folder = owned({
      id: 'folder',
      albumName: '2026-11-19 - Event',
      assetCount: 4,
      endDate: '2026-11-19T00:00:00.000Z',
      folderAlbum: { libraryId: 'l', folderPath: '/photos/2026-11-19 - Event' },
    });
    const old = owned({ id: 'old', albumName: 'Old', assetCount: 2, endDate: '2019-05-01T00:00:00.000Z' });
    const mixed = tree({ ...directory, albums: [...directory.albums, folder, old] });
    const by = (group: 'source' | 'year' | 'month' | 'owner') =>
      browseAlbumDirectory(mixed, {
        inside: null,
        filter: 'all',
        sort: 'title',
        order: 'desc',
        group,
        hideEmpty: true,
        collectionsFirst: false,
        search: '',
        userId: 'me',
      }).groups.map(({ id }) => id);
    expect(by('source')).toEqual(['source:made', 'source:folders', 'source:smart', 'source:spaces']);
    expect(by('year').slice(0, 2)).toEqual(['year:2026', 'year:2019']);
    expect(by('year').at(-1)).toBe('year:none');
    expect(by('month').slice(0, 2)).toEqual(['month:2026-11', 'month:2019-05']);
    expect(by('owner')).toEqual(['owner:me', 'owner:jamie']);
  });

  it('puts collections first when asked', () => {
    const result = browse({ group: 'none', sort: 'title', order: 'desc', collectionsFirst: true });
    expect(result.listed[0].id).toBe('family');
  });

  it('sorts by date of photos, name (as people read numbers), recently opened, changes and item count', () => {
    const a = owned({ id: 'a', albumName: 'Album 10', assetCount: 1, endDate: '2026-08-01T00:00:00.000Z' });
    const b = owned({ id: 'b', albumName: 'Album 9', assetCount: 5, endDate: undefined });
    const c = owned({ id: 'c', albumName: 'Album 11', assetCount: 3, endDate: '2026-09-01T00:00:00.000Z' });
    const ids = (...args: Parameters<typeof compareAlbums>) =>
      [a, b, c].sort(compareAlbums(...args)).map(({ id }) => id);
    expect(ids('title', 'asc')).toEqual(['b', 'a', 'c']);
    expect(ids('title', 'desc')).toEqual(['c', 'a', 'b']);
    expect(ids('items', 'desc')).toEqual(['b', 'c', 'a']);
    expect(ids('items', 'asc')).toEqual(['a', 'c', 'b']);
    expect(ids('date', 'desc')).toEqual(['c', 'a', 'b']);
    expect(ids('date', 'asc')).toEqual(['a', 'c', 'b']);
    expect(ids('opened', 'desc', ['c', 'b'])).toEqual(['c', 'b', 'a']);
    // Never opened here goes last whichever way the list runs.
    expect(ids('opened', 'asc', ['c', 'b'])).toEqual(['b', 'c', 'a']);
  });

  it('lets only the owner drag an album onto a collection they can edit', () => {
    expect(canDropOnCollection(winter, family, 'me')).toBe(false); // already inside
    expect(canDropOnCollection(trail, family, 'me')).toBe(false); // not the owner of the album
    const mine = owned({ id: 'mine' });
    expect(canDropOnCollection(mine, family, 'me')).toBe(true);
    expect(canDropOnCollection(mine, family, 'jamie')).toBe(false);
    expect(canDropOnCollection(family, family, 'me')).toBe(false);
    expect(canDropOnCollection(space, family, 'me')).toBe(false);
    expect(canDropOnCollection(mine, rockies, 'me')).toBe(true);
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
    expect(moveTargets(withOther, rockies, 'me').map(({ collection }) => collection.id)).toEqual(['family', 'winter']);
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
    const result = browse({ inside: 'family', group: 'none', sort: 'custom' });
    expect(result.listed.map(({ id }) => id)).toEqual(['winter', 'rockies']);
    expect(normalizeAlbumDirectoryView({ sort: 'custom' }).sort).toBe('custom');
  });

  it('names the group a custom order applies to (FL-52)', () => {
    // FL-1836: the siblings the page shows together, as the server's hierarchy groups them.
    expect(orderGroupOf(directory, 'family')).toEqual({ parentId: null, ids: ['family', 'trail'] });
    expect(orderGroupOf(directory, 'rockies')).toEqual({ parentId: 'family', ids: ['winter', 'rockies'] });
    expect(orderGroupOf(directory, 'trail')).toEqual({ parentId: null, ids: ['family', 'trail'] });
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

  it('repairs a persisted view, and reads a sort saved before FL-1836', () => {
    expect(normalizeAlbumDirectoryView(null)).toEqual(defaultAlbumDirectoryView);
    expect(defaultAlbumDirectoryView.group).toBe('kind');
    expect(
      normalizeAlbumDirectoryView({ filter: 'smart', sort: 'nope', view: 'list', group: 'x', collapsed: ['a', 1] }),
    ).toEqual({ ...defaultAlbumDirectoryView, filter: 'smart', view: 'list', collapsed: ['a'] });
    expect(normalizeAlbumDirectoryView({ sort: 'oldest-photo' })).toMatchObject({ sort: 'date', order: 'asc' });
    expect(normalizeAlbumDirectoryView({ sort: 'recent-photo' })).toMatchObject({ sort: 'date', order: 'desc' });
    expect(normalizeAlbumDirectoryView({ sort: 'title' })).toMatchObject({ sort: 'title', order: 'asc' });
    expect(normalizeAlbumDirectoryView({ hideEmpty: false }).hideEmpty).toBe(false);
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

describe('the hierarchy the Albums page browses (FL-1836)', () => {
  const base = {
    inside: null,
    filter: 'all' as const,
    sort: 'title' as const,
    order: 'asc' as const,
    group: 'none' as const,
    hideEmpty: true,
    collectionsFirst: false,
    search: '',
    userId: 'me',
  };
  const ids = (result: ReturnType<typeof browseAlbumDirectory>) => result.listed.map(({ id }) => id);

  it('keeps an album under a plain album inside it, and orders it with its real siblings', () => {
    const parent = owned({ id: 'parent', albumName: 'Parent', assetCount: 1 });
    const child = owned({ id: 'child', albumName: 'Child', parentId: 'parent', assetCount: 2 });
    const other = owned({ id: 'other', albumName: 'Other', assetCount: 1 });
    const directory = tree({ albums: [parent, child, other] });
    expect(ids(browseAlbumDirectory(directory, base))).toEqual(['other', 'parent']);
    expect(ids(browseAlbumDirectory(directory, { ...base, inside: 'parent' }))).toEqual(['child']);
    expect(orderGroupOf(directory, 'child')).toEqual({ parentId: 'parent', ids: ['child'] });
    expect(orderGroupOf(directory, 'other')).toEqual({ parentId: null, ids: ['parent', 'other'] });
  });

  it('treats an album under a shared space, and a parent cycle, as top level', () => {
    const space = owned({ id: 'space', albumName: 'Space', kind: AlbumKind.Space });
    const under = owned({ id: 'under', albumName: 'Under', parentId: 'space', assetCount: 1 });
    const a = owned({ id: 'a', albumName: 'A', parentId: 'b', assetCount: 1 });
    const b = owned({ id: 'b', albumName: 'B', parentId: 'a', assetCount: 1 });
    const directory = tree({ albums: [under, a, b], spaces: [space] });
    const result = browseAlbumDirectory(directory, base);
    // The cycle is broken at one point, so both stay reachable: B now opens inside A.
    expect(ids(result)).toEqual(['a', 'space', 'under']);
    expect(ids(browseAlbumDirectory(directory, { ...base, inside: 'a' }))).toEqual(['b']);
    expect(result.inside.get('space')).toBeUndefined();
  });

  it('keeps a collection under a filter when something inside it matches', () => {
    const shelf = owned({ id: 'shelf', albumName: 'Shelf', kind: AlbumKind.Collection });
    const smart = owned({ id: 'smart', albumName: 'Smart one', parentId: 'shelf', isSmart: true, assetCount: 3 });
    const directory = tree({ collections: [{ collection: shelf, albums: [smart], albumCount: 1, assetCount: 3 }] });
    expect(ids(browseAlbumDirectory(directory, { ...base, filter: 'smart' }))).toEqual(['shelf']);
  });

  it('adds up items through every level, and keeps an empty new collection in view', () => {
    const top = owned({ id: 'top', albumName: 'Top', kind: AlbumKind.Collection, assetCount: 0 });
    const mid = owned({ id: 'mid', albumName: 'Mid', parentId: 'top', assetCount: 2 });
    const deep = owned({ id: 'deep', albumName: 'Deep', parentId: 'mid', assetCount: 5 });
    const fresh = owned({ id: 'fresh', albumName: 'Fresh', kind: AlbumKind.Collection, assetCount: 0 });
    const result = browseAlbumDirectory(
      tree({
        collections: [
          { collection: top, albums: [mid], albumCount: 1, assetCount: 2 },
          { collection: fresh, albums: [], albumCount: 0, assetCount: 0 },
        ],
        albums: [deep],
      }),
      base,
    );
    expect(result.items.get('top')).toBe(7);
    expect(result.items.get('mid')).toBe(7);
    expect(ids(result)).toEqual(['fresh', 'top']);
  });

  it('groups and sorts a collection by the photos inside it, not its own empty numbers (recheck)', () => {
    const shelf = owned({ id: 'shelf', albumName: 'Shelf', kind: AlbumKind.Collection, assetCount: 0 });
    const inside = owned({
      id: 'inside',
      albumName: 'Inside',
      parentId: 'shelf',
      assetCount: 1240,
      startDate: '2024-03-01T00:00:00.000Z',
      endDate: '2024-06-01T00:00:00.000Z',
    });
    const small = owned({ id: 'small', albumName: 'Small', assetCount: 3, endDate: '2026-01-01T00:00:00.000Z' });
    const directory = tree({
      collections: [{ collection: shelf, albums: [inside], albumCount: 1, assetCount: 1240 }],
      albums: [small],
    });
    expect(
      browseAlbumDirectory(directory, { ...base, group: 'year', order: 'desc' }).groups.map(({ id }) => id),
    ).toEqual(['year:2026', 'year:2024']);
    expect(ids(browseAlbumDirectory(directory, { ...base, sort: 'items', order: 'desc' }))).toEqual(['shelf', 'small']);
  });

  it('arranges the top level kind by kind, keeping collections ahead of albums as shown (recheck)', () => {
    const c1 = owned({ id: 'c1', albumName: 'C1', kind: AlbumKind.Collection });
    const c2 = owned({ id: 'c2', albumName: 'C2', kind: AlbumKind.Collection });
    const a1 = owned({ id: 'a1', albumName: 'A1' });
    const a2 = owned({ id: 'a2', albumName: 'A2' });
    const directory = tree({
      collections: [
        { collection: c1, albums: [], albumCount: 0, assetCount: 0 },
        { collection: c2, albums: [], albumCount: 0, assetCount: 0 },
      ],
      albums: [a1, a2],
    });
    expect(arrangeInGroup(directory, 'a2', (band) => moveInOrder(band, 'a2', -1))).toEqual({
      parentId: null,
      ids: ['c1', 'c2', 'a2', 'a1'],
    });
    expect(arrangeInGroup(directory, 'c2', (band) => moveInOrder(band, 'c2', -1))).toEqual({
      parentId: null,
      ids: ['c2', 'c1', 'a1', 'a2'],
    });
    // An album can't be placed among the collections: they are listed apart.
    expect(arrangeInGroup(directory, 'a1', (band) => placeBefore(band, 'a1', 'c1'))).toBeUndefined();
  });

  it('marks a level that holds a broken parent cycle, which the server cannot arrange', () => {
    const a = owned({ id: 'a', albumName: 'A', parentId: 'b', assetCount: 1 });
    const b = owned({ id: 'b', albumName: 'B', parentId: 'a', assetCount: 1 });
    expect(browseAlbumDirectory(tree({ albums: [a, b] }), base).cycleHere).toBe(true);
  });

  it('counts what hiding empty albums leaves out at this level', () => {
    const empty = owned({ id: 'empty', albumName: 'Empty', assetCount: 0 });
    const full = owned({ id: 'full', albumName: 'Full', assetCount: 1 });
    expect(browseAlbumDirectory(tree({ albums: [empty, full] }), base).hiddenHere).toBe(1);
  });
});

describe('nested album organization', () => {
  const root = owned({ id: 'root', parentId: null });
  const child = owned({ id: 'child', parentId: 'root', kind: AlbumKind.Collection });
  const leaf = owned({ id: 'leaf', parentId: 'child' });
  const other = owned({ id: 'other', parentId: null });
  const nested = tree({
    collections: [{ collection: child, albums: [leaf], albumCount: 1, assetCount: 0 }],
    albums: [root, other],
  });
  it('offers albums as parents but excludes the moving subtree', () => {
    expect(moveTargets(nested, root, 'me').map(({ collection }) => collection.id)).toEqual(['other']);
    expect(
      moveTargets(nested, leaf, 'me')
        .map(({ collection }) => collection.id)
        .sort(),
    ).toEqual(['child', 'other', 'root']);
    expect(canDropOnCollection(child, other, 'me')).toBe(true);
    expect(canTakeOut(child, 'me')).toBe(true);
  });
  it('builds full breadcrumbs and stops at unavailable ancestors', () => {
    expect(albumAncestors(nested, leaf).map(({ id }) => id)).toEqual(['root', 'child']);
    expect(albumAncestors(tree({ albums: [leaf] }), leaf)).toEqual([]);
  });
});

/** FL-1796: the slim rail list carries only the viewer's own role, and edit rights read it. */
describe('edit rights from a slim rail item', () => {
  it.each([
    [AlbumUserRole.Owner, true, true],
    [AlbumUserRole.Editor, true, false],
    [AlbumUserRole.Viewer, false, false],
  ])('a %s may edit: %s, owns it: %s', (role, edit, own) => {
    expect(canEdit({ role }, 'me')).toBe(edit);
    expect(isOwner({ role }, 'me')).toBe(own);
  });
});
