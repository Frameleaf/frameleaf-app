import type { AlbumResponseDto, AlbumTreeResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { buildAlbumTree, flattenAlbumTree } from '$lib/frameleaf/album-tree';

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

const tree = (partial: Partial<AlbumTreeResponseDto>): AlbumTreeResponseDto => ({
  albums: [],
  collections: [],
  spaces: [],
  ...partial,
});

describe('Frameleaf album tree adapter', () => {
  it('maps collections, their albums, standalone albums and shared spaces one to one', () => {
    const result = buildAlbumTree(
      tree({
        collections: [
          {
            collection: album({ id: 'trips', albumName: 'Trips', icon: 'airplane' }),
            albums: [album({ id: 'iceland', albumName: 'Iceland', parentId: 'trips', assetCount: 12 })],
            albumCount: 1,
            assetCount: 12,
          },
        ],
        albums: [album({ id: 'solo', albumName: 'Solo album' })],
        spaces: [album({ id: 'family', albumName: 'Family', shared: true })],
      }),
    );

    expect(result.collections.map((node) => [node.id, node.kind, node.icon])).toEqual([
      ['trips', 'collection', 'airplane'],
    ]);
    expect(result.collections[0].children.map((node) => [node.id, node.kind, node.assetCount])).toEqual([
      ['iceland', 'album', 12],
    ]);
    expect(result.albums.map((node) => [node.id, node.kind])).toEqual([['solo', 'album']]);
    expect(result.spaces.map((node) => [node.id, node.kind, node.shared])).toEqual([['family', 'space', true]]);
  });

  it('keeps a collection one level deep: its albums never carry children of their own', () => {
    const result = buildAlbumTree(
      tree({
        collections: [
          {
            collection: album({ id: 'root', albumName: 'Root' }),
            albums: [album({ id: 'child', albumName: 'Child', parentId: 'root' })],
            albumCount: 1,
            assetCount: 0,
          },
        ],
      }),
    );

    expect(result.collections[0].children.every((node) => node.children.length === 0)).toBe(true);
  });

  it('produces an empty tree from an empty response', () => {
    expect(buildAlbumTree(tree({}))).toEqual({ collections: [], albums: [], spaces: [] });
  });

  it('carries the stored icon and asset count through to the rail', () => {
    const result = buildAlbumTree(
      tree({ albums: [album({ id: 'trip', albumName: 'Trip', icon: 'airplane', assetCount: 3 })] }),
    );

    expect(result.albums[0]).toMatchObject({ icon: 'airplane', assetCount: 3 });
  });

  it('flattens in rail order: collections with their albums, then albums, then spaces, preserving server order', () => {
    const result = buildAlbumTree(
      tree({
        collections: [
          {
            collection: album({ id: 'trips', albumName: 'Trips' }),
            albums: [album({ id: 'iceland', albumName: 'Iceland', parentId: 'trips' })],
            albumCount: 1,
            assetCount: 0,
          },
        ],
        albums: [album({ id: 'solo', albumName: 'Solo' })],
        spaces: [album({ id: 'family', albumName: 'Family', shared: true })],
      }),
    );

    expect(flattenAlbumTree(result).map((node) => node.id)).toEqual(['trips', 'iceland', 'solo', 'family']);
  });
});
