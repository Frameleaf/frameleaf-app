import { describe, expect, it } from 'vitest';
import { AlbumResponseDto } from 'src/dtos/album.dto.js';
import { AlbumKind } from 'src/enum.js';
import { albumOrderGroup, buildAlbumTree, orderAlbumTree } from 'src/utils/album-tree.js';

const album = (overrides: Partial<AlbumResponseDto> & { id: string }): AlbumResponseDto => ({
  albumName: overrides.id,
  description: '',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  albumThumbnailAssetId: null,
  shared: false,
  albumUsers: [],
  hasSharedLink: false,
  assetCount: 0,
  isActivityEnabled: true,
  parentId: null,
  icon: null,
  sortOrder: null,
  kind: AlbumKind.Album,
  ...overrides,
});

describe(buildAlbumTree.name, () => {
  it('returns empty groups for no albums', () => {
    expect(buildAlbumTree([])).toEqual({ collections: [], albums: [], spaces: [] });
  });

  it('lays collections out as shelves with their albums, then standalone albums, then spaces', () => {
    const family = album({ id: 'family', kind: AlbumKind.Collection, assetCount: 2 });
    const rockies = album({ id: 'rockies', parentId: 'family', assetCount: 10 });
    const winter = album({ id: 'winter', parentId: 'family', assetCount: 3 });
    const loose = album({ id: 'loose', assetCount: 7 });
    const space = album({ id: 'space', kind: AlbumKind.Space, assetCount: 1 });

    const tree = buildAlbumTree([space, rockies, family, loose, winter]);

    expect(tree.collections).toEqual([
      { collection: family, albums: [rockies, winter], albumCount: 2, assetCount: 15 },
    ]);
    expect(tree.albums).toEqual([loose]);
    expect(tree.spaces).toEqual([space]);
  });

  it('keeps an album visible on its own when its collection is not visible to the user', () => {
    const orphan = album({ id: 'orphan', parentId: 'someone-elses-collection' });
    expect(buildAlbumTree([orphan]).albums).toEqual([orphan]);
  });

  it('never nests collections or spaces, even when saved data gave them a parent', () => {
    const outer = album({ id: 'outer', kind: AlbumKind.Collection });
    const inner = album({ id: 'inner', kind: AlbumKind.Collection, parentId: 'outer' });
    const leaf = album({ id: 'leaf', parentId: 'inner' });
    const space = album({ id: 'space', kind: AlbumKind.Space, parentId: 'outer' });

    const tree = buildAlbumTree([outer, inner, leaf, space]);

    expect(tree.collections.map(({ collection, albums }) => [collection.id, albums.map(({ id }) => id)])).toEqual([
      ['outer', []],
      ['inner', ['leaf']],
    ]);
    expect(tree.albums).toEqual([]);
    expect(tree.spaces).toEqual([space]);
  });

  it('does not let an album nest inside another album', () => {
    const parent = album({ id: 'parent' });
    const child = album({ id: 'child', parentId: 'parent' });
    const tree = buildAlbumTree([parent, child]);
    expect(tree.collections).toEqual([]);
    expect(tree.albums).toEqual([parent, child]);
  });
});

describe(orderAlbumTree.name, () => {
  const family = album({ id: 'family', kind: AlbumKind.Collection });
  const trips = album({ id: 'trips', kind: AlbumKind.Collection });
  const rockies = album({ id: 'rockies', parentId: 'family' });
  const winter = album({ id: 'winter', parentId: 'family' });
  const loose = album({ id: 'loose' });
  const other = album({ id: 'other' });
  const space = album({ id: 'space', kind: AlbumKind.Space });
  const tree = buildAlbumTree([family, trips, rockies, winter, loose, other, space]);

  it('keeps the display order when nothing was arranged', () => {
    expect(orderAlbumTree(tree, new Map())).toBe(tree);
  });

  it('puts every group in the custom order, unplaced items after the placed ones', () => {
    const ordered = orderAlbumTree(
      tree,
      new Map([
        ['trips', 0],
        ['family', 1],
        ['winter', 0],
        ['other', 0],
      ]),
    );
    expect(ordered.collections.map(({ collection }) => collection.id)).toEqual(['trips', 'family']);
    expect(ordered.collections[1].albums.map(({ id }) => id)).toEqual(['winter', 'rockies']);
    expect(ordered.albums.map(({ id }) => id)).toEqual(['other', 'loose']);
    expect(ordered.spaces.map(({ id }) => id)).toEqual(['space']);
  });
});

describe(albumOrderGroup.name, () => {
  const items = [
    { id: 'family', kind: AlbumKind.Collection, parentId: null },
    { id: 'rockies', kind: AlbumKind.Album, parentId: 'family' },
    { id: 'winter', kind: AlbumKind.Album, parentId: 'family' },
    { id: 'loose', kind: AlbumKind.Album, parentId: null },
    { id: 'orphan', kind: AlbumKind.Album, parentId: 'hidden-collection' },
    { id: 'space', kind: AlbumKind.Space, parentId: null },
  ];

  it('names the albums inside a visible collection', () => {
    expect(albumOrderGroup(items, 'family', 'winter')).toEqual(['rockies', 'winter']);
  });

  it('refuses a collection the person cannot see', () => {
    expect(albumOrderGroup(items, 'hidden-collection', 'orphan')).toBeUndefined();
  });

  it('picks the top-level group from the first id', () => {
    expect(albumOrderGroup(items, null, 'family')).toEqual(['family']);
    expect(albumOrderGroup(items, null, 'loose')).toEqual(['loose', 'orphan']);
    expect(albumOrderGroup(items, null, 'space')).toEqual(['space']);
    expect(albumOrderGroup(items, null, 'unknown')).toBeUndefined();
  });
});
