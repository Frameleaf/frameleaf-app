import { AlbumKind, type AlbumResponseDto, type AlbumTreeResponseDto } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  ALBUM_COLORS,
  albumAncestorNames,
  albumColor,
  albumColorStyle,
  albumPickerTree,
  albumSelectionOptions,
  buildAlbumTree,
  descendantIds,
  flattenAlbumTree,
  moveRefusal,
  searchAlbums,
} from '$lib/frameleaf/album-tree';

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

it('keeps every level of the hierarchy in rail and flattened navigation', () => {
  const result = buildAlbumTree({
    roots: [
      {
        album: album({ id: 'a', albumName: 'A', kind: AlbumKind.Album }),
        children: [
          {
            album: album({ id: 'b', albumName: 'B', kind: AlbumKind.Collection, parentId: 'a' }),
            children: [
              {
                album: album({ id: 'c', albumName: 'C', kind: AlbumKind.Album, parentId: 'b' }),
                children: [],
              },
            ],
          },
        ],
      },
    ],
  });
  const [
    {
      children: [
        {
          children: [grandchild],
        },
      ],
    },
  ] = result.albums;
  expect(grandchild.id).toBe('c');
  expect(flattenAlbumTree(result).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
});

it('preserves mixed root sibling order from the hierarchy', () => {
  const result = buildAlbumTree({
    roots: [
      { album: album({ id: 'first', albumName: 'First', kind: AlbumKind.Album }), children: [] },
      { album: album({ id: 'second', albumName: 'Second', kind: AlbumKind.Collection }), children: [] },
    ],
  });
  expect(flattenAlbumTree(result).map(({ id }) => id)).toEqual(['first', 'second']);
});

it('names nested album choices using only readable ancestors', () => {
  const choices = albumSelectionOptions([
    album({ id: 'root', albumName: 'Brand' }),
    album({ id: 'child', albumName: 'Packaging', parentId: 'root' }),
    album({ id: 'private-parent-child', albumName: 'Visible album', parentId: 'not-readable' }),
  ]);
  expect(choices).toEqual([
    { value: 'root', label: 'Brand' },
    { value: 'child', label: 'Brand / Packaging' },
    { value: 'private-parent-child', label: 'Visible album' },
  ]);
});

describe('album colours (Boards, README point 22)', () => {
  it('offers the eight tag colours in picker order, each with a name', () => {
    expect(ALBUM_COLORS.map(({ id }) => id)).toEqual([
      'grey',
      'green',
      'teal',
      'blue',
      'purple',
      'pink',
      'amber',
      'red',
    ]);
    for (const color of ALBUM_COLORS) {
      expect(color.labelKey).toBe(`frameleaf_album_color_${color.id}`);
    }
  });

  it('keeps a known colour and drops anything else to the plain look', () => {
    expect(albumColor('teal')).toBe('teal');
    expect(albumColor('magenta')).toBeNull();
    expect(albumColor(null)).toBeNull();
    expect(albumColor(undefined)).toBeNull();
    expect(albumColorStyle('amber')).toContain('--mark-light: #a8761a');
    expect(albumColorStyle('nope')).toBeUndefined();
  });

  it('carries the colour onto every tree node', () => {
    const result = buildAlbumTree(tree({ albums: [album({ id: 'a', albumName: 'A', color: 'pink' })] }));
    expect(result.albums[0].color).toBe('pink');
  });
});

describe('album pickers', () => {
  const albums = [
    album({ id: 'brand', albumName: 'Brand refresh' }),
    album({ id: 'mood', albumName: 'Moodboard', parentId: 'brand' }),
    album({ id: 'type', albumName: 'Type', parentId: 'brand' }),
    album({ id: 'deep', albumName: 'Deep mood', parentId: 'mood' }),
    album({ id: 'other', albumName: 'Other' }),
  ];

  it('nests albums under the parents in the list, and keeps an orphan at the top', () => {
    const roots = albumPickerTree([...albums, album({ id: 'orphan', albumName: 'Orphan', parentId: 'gone' })]);
    expect(roots.map(({ album }) => album.id)).toEqual(['brand', 'other', 'orphan']);
    expect(roots[0].children.map(({ album }) => album.id)).toEqual(['mood', 'type']);
    expect(roots[0].children[0].children.map(({ album }) => album.id)).toEqual(['deep']);
  });

  it('survives a parent loop without recursing forever', () => {
    const loop = [album({ id: 'x', albumName: 'X', parentId: 'y' }), album({ id: 'y', albumName: 'Y', parentId: 'x' })];
    expect(albumPickerTree(loop)).toEqual([]);
    expect([...descendantIds(loop, 'x')]).toEqual(['y']);
  });

  it('lists every album inside one, at any depth', () => {
    expect([...descendantIds(albums, 'brand')].sort()).toEqual(['deep', 'mood', 'type']);
    expect(descendantIds(albums, 'other').size).toBe(0);
  });

  it('names the path above a search result', () => {
    expect(albumAncestorNames(albums, 'deep')).toEqual(['Brand refresh', 'Moodboard']);
    expect(albumAncestorNames(albums, 'brand')).toEqual([]);
  });

  it('refuses a move into the collection itself or anything inside it, and says which', () => {
    expect(moveRefusal(albums, 'brand', 'brand')).toBe('self');
    expect(moveRefusal(albums, 'brand', 'deep')).toBe('inside');
    expect(moveRefusal(albums, 'brand', 'other')).toBeNull();
    expect(moveRefusal(albums, 'mood', 'type')).toBeNull();
  });

  it('matches every word of a search, ignoring case', () => {
    expect(searchAlbums(albums, 'MOOD').map(({ id }) => id)).toEqual(['mood', 'deep']);
    expect(searchAlbums(albums, 'deep mood').map(({ id }) => id)).toEqual(['deep']);
    expect(searchAlbums(albums, '  ')).toHaveLength(albums.length);
  });
});
