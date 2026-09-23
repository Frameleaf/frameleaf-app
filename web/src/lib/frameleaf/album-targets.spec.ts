import { AlbumKind, AlbumUserRole, getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
import { describe, expect, it, vi } from 'vitest';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import {
  albumTargetRows,
  buildAlbumTargets,
  countAlbumTargets,
  flattenAlbumTargets,
  loadAlbumTargets,
  searchAlbumTargets,
} from './album-targets';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAllAlbums: vi.fn(),
}));

const me = userAdminFactory.build({ id: 'me' });
const jamie = userAdminFactory.build({ id: 'jamie' });

const album = (overrides: Partial<AlbumResponseDto> & { id: string; albumName: string }, role = AlbumUserRole.Owner) =>
  albumFactory.build({
    kind: AlbumKind.Album,
    parentId: null,
    assetCount: 3,
    albumUsers: [{ user: me, role }],
    ...overrides,
  });

const library = () => [
  album({ id: 'family', albumName: 'Family', kind: AlbumKind.Collection }),
  album({ id: 'rockies', albumName: 'Summer in the Rockies', parentId: 'family' }),
  album({ id: 'birthday', albumName: 'Birthday', parentId: 'family' }),
  album({ id: 'solo', albumName: 'Receipts' }),
  album({ id: 'viewer', albumName: 'Only looking', albumUsers: [{ user: me, role: AlbumUserRole.Viewer }] }),
  album({
    id: 'shared-edit',
    albumName: 'Jamie trip',
    albumUsers: [
      { user: jamie, role: AlbumUserRole.Owner },
      { user: me, role: AlbumUserRole.Editor },
    ],
  }),
  album({ id: 'space', albumName: 'Household', kind: AlbumKind.Space }, AlbumUserRole.Editor),
  album({ id: 'orphan', albumName: 'Orphan', parentId: 'someone-elses-collection' }),
  album({ id: 'empty-collection', albumName: 'Nothing here', kind: AlbumKind.Collection }),
];

describe('album targets for Add to album', () => {
  it('offers albums the user owns or edits, grouped one level deep, with spaces at the top level', () => {
    const directory = buildAlbumTargets(library(), 'me');

    expect(directory.albums.map(({ id }) => id)).toEqual(['shared-edit', 'orphan', 'solo']);
    expect(directory.collections).toEqual([
      {
        id: 'family',
        name: 'Family',
        albums: [
          { id: 'birthday', name: 'Birthday', count: 3, kind: 'album' },
          { id: 'rockies', name: 'Summer in the Rockies', count: 3, kind: 'album' },
        ],
      },
    ]);
    expect(directory.spaces.map(({ id, kind }) => ({ id, kind }))).toEqual([{ id: 'space', kind: 'space' }]);
  });

  it('never offers a collection itself, an album the user may only view, or anything they are not in', () => {
    const ids = flattenAlbumTargets(buildAlbumTargets(library(), 'me')).map(({ id }) => id);

    expect(ids).not.toContain('family');
    expect(ids).not.toContain('empty-collection');
    expect(ids).not.toContain('viewer');
    expect(flattenAlbumTargets(buildAlbumTargets(library(), 'stranger'))).toEqual([]);
  });

  it('names an unnamed album', () => {
    const directory = buildAlbumTargets([album({ id: 'x', albumName: '' })], 'me', 'Unnamed Album');
    expect(directory.albums[0].name).toBe('Unnamed Album');
  });

  it('searches album names and keeps a whole collection when its own name matches', () => {
    const directory = buildAlbumTargets(library(), 'me');

    const rockies = searchAlbumTargets(directory, 'rock');
    expect(flattenAlbumTargets(rockies).map(({ id }) => id)).toEqual(['rockies']);
    expect(rockies.collections.map(({ id }) => id)).toEqual(['family']);

    const family = searchAlbumTargets(directory, 'family');
    expect(flattenAlbumTargets(family).map(({ id }) => id)).toEqual(['birthday', 'rockies']);

    expect(countAlbumTargets(searchAlbumTargets(directory, 'nothing matches this'))).toBe(0);
    expect(searchAlbumTargets(directory, ' '.repeat(3))).toBe(directory);
  });

  it('pages the rows, heading a collection only above albums that made the page', () => {
    const directory = buildAlbumTargets(library(), 'me');

    const all = albumTargetRows(directory);
    expect(all.hasMore).toBe(false);
    expect(all.rows.map((row) => (row.type === 'collection' ? `#${row.id}` : row.target.id))).toEqual([
      'shared-edit',
      'orphan',
      'solo',
      '#family',
      'birthday',
      'rockies',
      'space',
    ]);
    expect(all.rows.find((row) => row.type === 'target' && row.target.id === 'birthday')).toMatchObject({
      nested: true,
    });

    const first = albumTargetRows(directory, 3);
    expect(first.hasMore).toBe(true);
    expect(first.rows.map((row) => (row.type === 'collection' ? `#${row.id}` : row.target.id))).toEqual([
      'shared-edit',
      'orphan',
      'solo',
    ]);

    const second = albumTargetRows(directory, 4);
    expect(second.rows.map((row) => (row.type === 'collection' ? `#${row.id}` : row.target.id))).toEqual([
      'shared-edit',
      'orphan',
      'solo',
      '#family',
      'birthday',
    ]);
  });

  it('loads through the album API itself, so no caller has to pass a list', async () => {
    vi.mocked(getAllAlbums).mockResolvedValue(library());

    const directory = await loadAlbumTargets('me');

    expect(getAllAlbums).toHaveBeenCalledWith({});
    expect(countAlbumTargets(directory)).toBe(6);
  });
});
