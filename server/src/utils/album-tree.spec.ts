import { describe, expect, it } from 'vitest';
import { AlbumResponseDto } from 'src/dtos/album.dto.js';
import { AlbumKind } from 'src/enum.js';
import { buildAlbumTree } from 'src/utils/album-tree.js';

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
