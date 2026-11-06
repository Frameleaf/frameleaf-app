import { AlbumKind, AlbumUserRole, type AlbumResponseDto } from '@frameleaf/sdk';
import { dropZone, planKeyMove, planRailMove } from '$lib/frameleaf/rail-moves';

const ME = 'me';
const album = (
  id: string,
  parentId: string | null,
  sortOrder: number | null,
  extra: Partial<AlbumResponseDto> = {},
): AlbumResponseDto =>
  ({
    id,
    albumName: id,
    parentId,
    sortOrder,
    kind: AlbumKind.Album,
    albumUsers: [{ user: { id: ME }, role: AlbumUserRole.Owner }],
    ...extra,
  }) as unknown as AlbumResponseDto;

// Display order: trips (collection) › [italy, japan], then hikes, then summer
const records = [
  album('trips', null, 1024, { kind: AlbumKind.Collection }),
  album('italy', 'trips', 1024),
  album('japan', 'trips', 2048),
  album('hikes', null, 2048),
  album('summer', null, 3072),
];

describe('planRailMove', () => {
  it('reorders between two siblings at the midpoint', () => {
    expect(planRailMove(records, 'summer', 'hikes', 'before', ME)?.updates).toEqual([
      { id: 'summer', sortOrder: 1536 },
    ]);
  });

  it('puts an album into a collection at its end', () => {
    expect(planRailMove(records, 'hikes', 'trips', 'into', ME)?.updates).toEqual([
      { id: 'hikes', sortOrder: 3072, parentId: 'trips' },
    ]);
  });

  it('takes an album out to sit after its parent', () => {
    expect(planKeyMove(records, 'japan', 'ArrowLeft', ME)?.updates).toEqual([
      { id: 'japan', sortOrder: 1536, parentId: null },
    ]);
  });

  it('refuses a move into itself or its own album, a space, or someone else’s album', () => {
    expect(planRailMove(records, 'trips', 'italy', 'into', ME)).toBeNull();
    expect(planRailMove(records, 'trips', 'trips', 'into', ME)).toBeNull();
    const space = album('family', null, null, { kind: AlbumKind.Space });
    expect(planRailMove([...records, space], 'hikes', 'family', 'into', ME)).toBeNull();
    const theirs = album('theirs', null, 4096, {
      albumUsers: [{ user: { id: 'them' }, role: AlbumUserRole.Owner }] as never,
    });
    expect(planRailMove([...records, theirs], 'theirs', 'hikes', 'before', ME)).toBeNull();
  });

  it('refuses to nest an album into a smart album, by drop or with ⌥→, as the Albums page does', () => {
    const smart = [album('favourites', null, 1024, { isSmart: true }), album('hikes', null, 2048)];
    expect(planRailMove(smart, 'hikes', 'favourites', 'into', ME)).toBeNull();
    expect(planKeyMove(smart, 'hikes', 'ArrowRight', ME)).toBeNull();
    expect(planRailMove(smart, 'hikes', 'favourites', 'before', ME)).not.toBeNull();
  });

  it('numbers the siblings again when no number is left between two of them', () => {
    const tight = [album('x', null, 1), album('y', null, 1 + 2 ** -52), album('z', null, 3)];
    expect(planRailMove(tight, 'z', 'y', 'before', ME)?.updates).toEqual([
      { id: 'x', sortOrder: 1024 },
      { id: 'z', sortOrder: 2048 },
      { id: 'y', sortOrder: 3072 },
    ]);
  });

  it('does nothing for a drop where the album already is', () => {
    expect(planRailMove(records, 'hikes', 'summer', 'before', ME)).toBeNull();
    expect(planKeyMove(records, 'trips', 'ArrowUp', ME)).toBeNull();
  });

  it('numbers albums that have no place yet when one moves below them', () => {
    const unplaced = [album('a', null, null), album('b', null, null), album('c', null, null)];
    expect(planRailMove(unplaced, 'a', 'b', 'after', ME)?.updates).toEqual([
      { id: 'b', sortOrder: 1024 },
      { id: 'a', sortOrder: 2048 },
    ]);
    expect(planRailMove(unplaced, 'c', 'a', 'before', ME)?.updates).toEqual([{ id: 'c', sortOrder: 1024 }]);
  });

  it('moves with the keyboard among siblings and into the album above', () => {
    expect(planKeyMove(records, 'summer', 'ArrowUp', ME)?.updates).toEqual([{ id: 'summer', sortOrder: 1536 }]);
    expect(planKeyMove(records, 'hikes', 'ArrowRight', ME)?.updates).toEqual([
      { id: 'hikes', sortOrder: 3072, parentId: 'trips' },
    ]);
  });
});

describe('the person’s own order (FL-1240)', () => {
  it('saves the whole group a move lands in, in the order the sidebar will show it', () => {
    expect(planRailMove(records, 'summer', 'hikes', 'before', ME)).toMatchObject({
      parentId: null,
      albumIds: ['trips', 'summer', 'hikes'],
    });
    expect(planRailMove(records, 'hikes', 'trips', 'into', ME)).toMatchObject({
      parentId: 'trips',
      albumIds: ['italy', 'japan', 'hikes'],
    });
    expect(planKeyMove(records, 'japan', 'ArrowLeft', ME)).toMatchObject({
      parentId: null,
      albumIds: ['trips', 'japan', 'hikes', 'summer'],
    });
  });

  it('does not write a meaningless sortOrder where the shown order is the person’s own', () => {
    // Arranged on the Albums page: summer shows above hikes although its sortOrder is higher.
    const arranged = [records[0], records[1], records[2], records[4], records[3]];
    expect(planRailMove(arranged, 'hikes', 'summer', 'before', ME)).toEqual({
      updates: [],
      parentId: null,
      albumIds: ['trips', 'hikes', 'summer'],
    });
  });

  it('still saves a new parent where the shown order is the person’s own', () => {
    const arranged = [records[0], records[2], records[1], records[3], records[4]];
    expect(planRailMove(arranged, 'hikes', 'italy', 'before', ME)).toEqual({
      updates: [{ id: 'hikes', parentId: 'trips' }],
      parentId: 'trips',
      albumIds: ['japan', 'hikes', 'italy'],
    });
  });

  it('keeps the move as the person’s own when the shared order would need someone else’s album renumbered', () => {
    const shared = [
      album('theirs', null, null, { albumUsers: [{ user: { id: 'them' }, role: AlbumUserRole.Owner }] as never }),
      album('x', null, null),
      album('mine', null, null),
    ];
    expect(planRailMove(shared, 'mine', 'x', 'before', ME)).toEqual({
      updates: [],
      parentId: null,
      albumIds: ['theirs', 'mine', 'x'],
    });
  });
});

it('reads the drop zone from where the pointer is in the row', () => {
  expect(dropZone(2, 32)).toBe('before');
  expect(dropZone(16, 32)).toBe('into');
  expect(dropZone(30, 32)).toBe('after');
  expect(dropZone(16, 32, false)).toBe('after');
});
