import type { AlbumResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { buildAlbumTree, flattenAlbumTree } from '$lib/frameleaf/album-tree';

type AlbumUsers = AlbumResponseDto['albumUsers'];

/** The owner is always the first entry, so two members means the album is shared. */
const members = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ user: { id: `user-${index}` } })) as unknown as AlbumUsers;

const album = (partial: Partial<AlbumResponseDto> & { id: string; albumName: string }): AlbumResponseDto =>
  ({
    albumThumbnailAssetId: null,
    albumUsers: [],
    assetCount: 0,
    createdAt: '2026-09-22T00:00:00.000Z',
    description: '',
    hasSharedLink: false,
    icon: null,
    isActivityEnabled: true,
    parentId: null,
    shared: false,
    sortOrder: null,
    updatedAt: '2026-09-22T00:00:00.000Z',
    ...partial,
  }) as AlbumResponseDto;

describe('Frameleaf album tree adapter', () => {
  it('splits collections, standalone albums and shared spaces', () => {
    const tree = buildAlbumTree([
      album({ id: 'trips', albumName: 'Trips' }),
      album({ id: 'iceland', albumName: 'Iceland', parentId: 'trips', assetCount: 12 }),
      album({ id: 'solo', albumName: 'Solo album' }),
      album({ id: 'family', albumName: 'Family', shared: true, albumUsers: members(2) }),
      album({ id: 'linked', albumName: 'Linked', shared: true, hasSharedLink: true }),
    ]);

    expect(tree.collections.map((node) => node.id)).toEqual(['trips']);
    expect(tree.collections[0].kind).toBe('collection');
    expect(tree.collections[0].children.map((node) => [node.id, node.kind])).toEqual([['iceland', 'album']]);
    // A public link does not make a space: the album stays an album and the link is
    // reached from Shared links.
    expect(tree.albums.map((node) => node.id)).toEqual(['linked', 'solo']);
    expect(tree.spaces.map((node) => [node.id, node.kind])).toEqual([['family', 'space']]);
  });

  it('keeps collections one level deep instead of nesting a subcollection', () => {
    const tree = buildAlbumTree([
      album({ id: 'root', albumName: 'Root' }),
      album({ id: 'child', albumName: 'Child', parentId: 'root' }),
      album({ id: 'grandchild', albumName: 'Grandchild', parentId: 'child' }),
    ]);

    expect(tree.collections).toHaveLength(1);
    expect(tree.collections[0].children.map((node) => node.id)).toEqual(['child', 'grandchild']);
    expect(tree.collections[0].children.every((node) => node.children.length === 0)).toBe(true);
  });

  it('promotes an album whose parent is not in the list', () => {
    const tree = buildAlbumTree([album({ id: 'orphan', albumName: 'Orphan', parentId: 'missing' })]);

    expect(tree.albums.map((node) => node.id)).toEqual(['orphan']);
    expect(tree.collections).toEqual([]);
  });

  it('does not loop on a cycle in parentId', () => {
    const tree = buildAlbumTree([
      album({ id: 'a', albumName: 'A', parentId: 'b' }),
      album({ id: 'b', albumName: 'B', parentId: 'a' }),
    ]);

    expect(flattenAlbumTree(tree)).toHaveLength(2);
  });

  it('orders siblings by sortOrder, then name', () => {
    const tree = buildAlbumTree([
      album({ id: 'z', albumName: 'Zebra', sortOrder: 1 }),
      album({ id: 'a', albumName: 'Antelope' }),
      album({ id: 'm', albumName: 'Moose' }),
    ]);

    expect(tree.albums.map((node) => node.name)).toEqual(['Zebra', 'Antelope', 'Moose']);
  });

  it('carries the stored icon and asset count through to the rail', () => {
    const tree = buildAlbumTree([album({ id: 'trip', albumName: 'Trip', icon: 'airplane', assetCount: 3 })]);

    expect(tree.albums[0]).toMatchObject({ icon: 'airplane', assetCount: 3 });
  });

  it('flattens in rail order: collections with their albums, then albums, then spaces', () => {
    const tree = buildAlbumTree([
      album({ id: 'trips', albumName: 'Trips' }),
      album({ id: 'iceland', albumName: 'Iceland', parentId: 'trips' }),
      album({ id: 'solo', albumName: 'Solo' }),
      album({ id: 'family', albumName: 'Family', shared: true, albumUsers: members(2) }),
    ]);

    expect(flattenAlbumTree(tree).map((node) => node.id)).toEqual(['trips', 'iceland', 'solo', 'family']);
  });
});
