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
    expect(planRailMove(records, 'summer', 'hikes', 'before', ME)).toEqual([{ id: 'summer', sortOrder: 1536 }]);
  });

  it('puts an album into a collection at its end', () => {
    expect(planRailMove(records, 'hikes', 'trips', 'into', ME)).toEqual([
      { id: 'hikes', sortOrder: 3072, parentId: 'trips' },
    ]);
  });

  it('takes an album out to sit after its parent', () => {
    expect(planKeyMove(records, 'japan', 'ArrowLeft', ME)).toEqual([{ id: 'japan', sortOrder: 1536, parentId: null }]);
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

  it('does nothing for a drop where the album already is', () => {
    expect(planRailMove(records, 'hikes', 'summer', 'before', ME)).toBeNull();
    expect(planKeyMove(records, 'trips', 'ArrowUp', ME)).toBeNull();
  });

  it('numbers albums that have no place yet when one moves below them', () => {
    const unplaced = [album('a', null, null), album('b', null, null), album('c', null, null)];
    expect(planRailMove(unplaced, 'a', 'b', 'after', ME)).toEqual([
      { id: 'b', sortOrder: 1024 },
      { id: 'a', sortOrder: 2048 },
    ]);
    expect(planRailMove(unplaced, 'c', 'a', 'before', ME)).toEqual([{ id: 'c', sortOrder: 1024 }]);
  });

  it('moves with the keyboard among siblings and into the album above', () => {
    expect(planKeyMove(records, 'summer', 'ArrowUp', ME)).toEqual([{ id: 'summer', sortOrder: 1536 }]);
    expect(planKeyMove(records, 'hikes', 'ArrowRight', ME)).toEqual([
      { id: 'hikes', sortOrder: 3072, parentId: 'trips' },
    ]);
  });
});

it('reads the drop zone from where the pointer is in the row', () => {
  expect(dropZone(2, 32)).toBe('before');
  expect(dropZone(16, 32)).toBe('into');
  expect(dropZone(30, 32)).toBe('after');
  expect(dropZone(16, 32, false)).toBe('after');
});
