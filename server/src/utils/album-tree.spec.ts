import { describe, expect, it } from 'vitest';
import { AlbumResponseDto } from 'src/dtos/album.dto.js';
import { AlbumKind } from 'src/enum.js';
import { albumOrderGroup, buildAlbumHierarchy, buildAlbumTree, orderAlbumTree } from 'src/utils/album-tree.js';

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

  it('keeps duplicate shelves independent and preserves empty-parent membership', () => {
    const first = album({ id: '', kind: AlbumKind.Collection, assetCount: 2 });
    const second = album({ id: '', kind: AlbumKind.Collection, assetCount: 7 });
    const child = album({ id: 'child', parentId: '', assetCount: 3 });
    const inputs = [child, first, second];
    const tree = buildAlbumTree(inputs);

    expect(tree.collections).toEqual([
      { collection: first, albums: [child], albumCount: 1, assetCount: 5 },
      { collection: second, albums: [child], albumCount: 1, assetCount: 10 },
    ]);
    expect(tree.albums).toEqual([child]);
    expect(tree.collections[0].albums[0]).toBe(child);
    tree.collections[0].albums.pop();
    expect(tree.collections[1].albums).toEqual([child]);
    expect(inputs).toEqual([child, first, second]);
  });

  it('does not rescan each album parent for every collection', () => {
    let parentReads = 0;
    const collections = Array.from({ length: 40 }, (_, index) =>
      album({ id: `collection-${index}`, kind: AlbumKind.Collection }),
    );
    const members = Array.from({ length: 80 }, (_, index) => {
      const member = album({ id: `album-${index}`, parentId: `collection-${index % 40}` });
      Object.defineProperty(member, 'parentId', {
        get: () => {
          parentReads++;
          return `collection-${index % 40}`;
        },
      });
      return member;
    });

    const tree = buildAlbumTree([...members, ...collections]);

    expect(tree.collections[0].albums.map(({ id }) => id)).toEqual(['album-0', 'album-40']);
    expect(tree.albums).toEqual([]);
    expect(parentReads).toBe(members.length);
  });

  it('classifies each input once and skips sparse entries and unknown kinds', () => {
    let kindReads = 0;
    const family = album({ id: 'family', kind: AlbumKind.Collection });
    const child = album({ id: 'child', parentId: 'family' });
    const space = album({ id: 'space', kind: AlbumKind.Space });
    const unknown = album({ id: 'unknown' });
    Reflect.set(unknown, 'kind', 'unsupported');
    const inputs = [child, family, space, unknown];
    for (const input of inputs) {
      const kind = input.kind;
      Object.defineProperty(input, 'kind', {
        get: () => {
          kindReads++;
          return kind;
        },
      });
    }
    inputs.length++;

    const tree = buildAlbumTree(inputs);

    expect(tree.collections[0].collection).toBe(family);
    expect(tree.collections[0].albums).toEqual([child]);
    expect(tree.albums).toEqual([]);
    expect(tree.spaces).toEqual([space]);
    expect(kindReads).toBe(4);
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

  it.each([
    { parentId: null, firstId: 'family', expected: ['family'] },
    { parentId: null, firstId: 'space', expected: ['space'] },
    { parentId: 'family', firstId: 'winter', expected: ['rockies', 'winter'] },
  ])('does not build an unused collection index for $parentId / $firstId', ({ parentId, firstId, expected }) => {
    let reads = 0;
    const counted = items.map((item) => ({
      ...item,
      get kind() {
        reads++;
        return item.kind;
      },
    }));
    expect(albumOrderGroup(counted, parentId, firstId)).toEqual(expected);
    expect(reads).toBe(items.length + 1);
  });
});

describe('recursive album hierarchy', () => {
  it('keeps albums and nested collections in one ordered tree', () => {
    const root = album({ id: 'root' });
    const group = album({ id: 'group', kind: AlbumKind.Collection, parentId: 'root' });
    const leaf = album({ id: 'leaf', parentId: 'group' });
    const sibling = album({ id: 'sibling', parentId: 'root' });
    const result = buildAlbumHierarchy(
      [leaf, sibling, root, group],
      new Map([
        ['group', 0],
        ['sibling', 1],
      ]),
    );
    expect(result.roots).toEqual([
      {
        album: root,
        children: [
          { album: group, children: [{ album: leaf, children: [] }] },
          { album: sibling, children: [] },
        ],
      },
    ]);
  });

  it('promotes accessible children without disclosing an inaccessible parent', () => {
    const item = album({ id: 'child', parentId: 'private' });
    const result = buildAlbumHierarchy([item]);
    expect(result.roots).toEqual([{ album: { ...item, parentId: null }, children: [] }]);
    expect(item.parentId).toBe('private');
  });

  it('keeps spaces at the root and does not attach children to them', () => {
    const space = album({ id: 'space', kind: AlbumKind.Space, parentId: 'child' });
    const child = album({ id: 'child', parentId: 'space' });
    expect(
      buildAlbumHierarchy([space, child]).roots.map(({ album: value, children }) => [
        value.id,
        value.parentId,
        children,
      ]),
    ).toEqual([
      ['space', null, []],
      ['child', null, []],
    ]);
  });

  it('breaks corrupt cycles without hiding any accessible item', () => {
    const first = album({ id: 'first', parentId: 'second' });
    const second = album({ id: 'second', parentId: 'first' });
    const result = buildAlbumHierarchy([first, second]);
    expect(result.roots).toEqual([
      { album: { ...first, parentId: null }, children: [{ album: second, children: [] }] },
    ]);
    expect(JSON.stringify(result)).toContain('second');
  });
});

describe('hierarchy order groups', () => {
  const items = [
    { id: 'root', kind: AlbumKind.Album, parentId: null },
    { id: 'group', kind: AlbumKind.Collection, parentId: 'root' },
    { id: 'leaf', kind: AlbumKind.Album, parentId: 'root' },
    { id: 'hidden-parent-child', kind: AlbumKind.Album, parentId: 'private' },
  ];
  it('orders mixed siblings and promotes inaccessible parents', () => {
    expect(albumOrderGroup(items, 'root', 'group', true)).toEqual(['group', 'leaf']);
    expect(albumOrderGroup(items, null, 'root', true)).toEqual(['root', 'hidden-parent-child']);
    expect(albumOrderGroup(items, 'private', 'hidden-parent-child', true)).toBeUndefined();
  });
});
