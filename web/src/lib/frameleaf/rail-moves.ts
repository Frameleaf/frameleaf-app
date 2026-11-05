/**
 * Moving albums in the sidebar (approved design, 2026-11-04, `LibraryRail.jsx`): drag an album above or
 * below another to reorder it, onto an album or collection to put it inside, or use ⌥ and the arrows.
 * A move is saved as the album's `parentId` and `sortOrder` (lower first, nulls last on the server).
 */
import { AlbumKind, type AlbumResponseDto } from '@frameleaf/sdk';
import { canEdit, isOwner } from '$lib/frameleaf/album-directory';

export type RailDrop = 'before' | 'after' | 'into';
export type RailUpdate = { id: string; sortOrder: number; parentId?: string | null };

const GAP = 1024;

/** Where in a row the pointer is: the top quarter drops before it, the bottom quarter after, else into. */
export const dropZone = (offsetY: number, height: number, canNest = true): RailDrop => {
  const at = height > 0 ? offsetY / height : 0.5;
  if (!canNest) {
    return at < 0.5 ? 'before' : 'after';
  }
  return at < 0.28 ? 'before' : at > 0.72 ? 'after' : 'into';
};

/**
 * The updates that put `dragId` before, after or into `targetId`, or null when that move isn't allowed
 * (a space, someone else's album, into itself or something inside it, or a place it already is).
 * `records` are the albums in the order the sidebar shows them, so siblings keep that order.
 */
export function planRailMove(
  records: AlbumResponseDto[],
  dragId: string,
  targetId: string,
  where: RailDrop,
  userId: string,
): RailUpdate[] | null {
  const byId = new Map(records.map((album) => [album.id, album]));
  const dragged = byId.get(dragId);
  const target = byId.get(targetId);
  if (!dragged || !target || dragged.id === target.id) {
    return null;
  }
  if (dragged.kind === AlbumKind.Space || target.kind === AlbumKind.Space || !isOwner(dragged, userId)) {
    return null;
  }
  // Never into itself or anything inside it.
  for (let at: AlbumResponseDto | undefined = target; at; at = at.parentId ? byId.get(at.parentId) : undefined) {
    if (at.id === dragged.id) {
      return null;
    }
  }
  const parentId = where === 'into' ? target.id : target.parentId;
  const parent = parentId ? byId.get(parentId) : undefined;
  if (parentId && (!parent || !canEdit(parent, userId))) {
    return null;
  }
  const siblings = records.filter(
    (album) => album.id !== dragged.id && album.kind !== AlbumKind.Space && (album.parentId ?? null) === parentId,
  );
  const index =
    where === 'into'
      ? siblings.length
      : siblings.findIndex((album) => album.id === target.id) + (where === 'after' ? 1 : 0);
  const order = [...siblings.slice(0, index), dragged, ...siblings.slice(index)];
  const before = records.filter(
    (album) => album.kind !== AlbumKind.Space && (album.parentId ?? null) === (dragged.parentId ?? null),
  );
  if (parentId === (dragged.parentId ?? null) && order.every((album, i) => before[i]?.id === album.id)) {
    return null;
  }
  const moved = parentId === (dragged.parentId ?? null) ? {} : { parentId };
  const previous = order[index - 1];
  const next = order[index + 1];
  const low = previous?.sortOrder ?? null;
  const high = next?.sortOrder ?? null;
  if (!previous || low !== null) {
    // Nulls sort last, so before an unplaced album any number after `low` will do.
    const sortOrder =
      low !== null && high !== null ? (low + high) / 2 : low === null ? (high === null ? GAP : high - GAP) : low + GAP;
    return [{ id: dragged.id, sortOrder, ...moved }];
  }
  // The albums above it have no place yet: number them all, which only their owner may do.
  const placed = order.slice(0, index + 1);
  if (placed.some((album) => album.id !== dragged.id && !isOwner(album, userId))) {
    return null;
  }
  return placed.flatMap((album, i) =>
    album.id === dragged.id
      ? [{ id: album.id, sortOrder: (i + 1) * GAP, ...moved }]
      : album.sortOrder === (i + 1) * GAP
        ? []
        : [{ id: album.id, sortOrder: (i + 1) * GAP }],
  );
}

/** ⌥↑ and ⌥↓ move an album among its siblings, ⌥→ puts it in the one above, ⌥← takes it out one level. */
export function planKeyMove(
  records: AlbumResponseDto[],
  albumId: string,
  key: string,
  userId: string,
): RailUpdate[] | null {
  const album = records.find(({ id }) => id === albumId);
  if (!album) {
    return null;
  }
  const siblings = records.filter(
    (item) => item.kind !== AlbumKind.Space && (item.parentId ?? null) === (album.parentId ?? null),
  );
  const at = siblings.findIndex(({ id }) => id === albumId);
  switch (key) {
    case 'ArrowUp': {
      return at > 0 ? planRailMove(records, albumId, siblings[at - 1].id, 'before', userId) : null;
    }
    case 'ArrowDown': {
      return at < siblings.length - 1 ? planRailMove(records, albumId, siblings[at + 1].id, 'after', userId) : null;
    }
    case 'ArrowRight': {
      return at > 0 ? planRailMove(records, albumId, siblings[at - 1].id, 'into', userId) : null;
    }
    case 'ArrowLeft': {
      return album.parentId ? planRailMove(records, albumId, album.parentId, 'after', userId) : null;
    }
    default: {
      return null;
    }
  }
}
