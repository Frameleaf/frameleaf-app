import { AssetOrder } from '@immich/sdk';
import { LIBRARY_SORTS, type LibrarySort } from '$lib/frameleaf/library-session';

/**
 * FL-31: "Keep personal viewing sort distinct from shared album ordering."
 *
 * An album's display order (`AlbumResponseDto.order`, the template's `displayOrder` in the album
 * options, `CollectionHeader.jsx:953-1000`) is shared: every member sees the album in that order and
 * only an editor changes it. The results toolbar's Sort (`App.jsx` "Sort assets") is the viewer's
 * own. On an album the viewer's sort starts from the shared order and a choice made here is kept for
 * that album on this device only; it never writes the shared order, and a later change to the
 * shared order shows through again once the viewer's choice matches it or is cleared.
 */
export const ALBUM_VIEW_SORT_KEY = 'frameleaf.albumViewSort';

type SortMap = Record<string, LibrarySort>;

const readMap = (storage: Pick<Storage, 'getItem'> | undefined): SortMap => {
  try {
    const value: unknown = JSON.parse(storage?.getItem(ALBUM_VIEW_SORT_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, LibrarySort] =>
          typeof entry[1] === 'string' && LIBRARY_SORTS.includes(entry[1] as LibrarySort),
      ),
    );
  } catch {
    return {};
  }
};

/** The sort the album's shared display order stands for. */
export const albumOrderSort = (order?: AssetOrder | null): LibrarySort =>
  order === AssetOrder.Asc ? 'captured-asc' : 'captured-desc';

/** The viewer's own sort for this album on this device, or null when they follow the shared order. */
export const readAlbumViewSort = (storage: Pick<Storage, 'getItem'> | undefined, albumId: string) =>
  readMap(storage)[albumId] ?? null;

/**
 * Keeps the viewer's choice for this album. Choosing the album's own order clears the choice, so the
 * viewer follows the shared order again.
 */
export const writeAlbumViewSort = (
  storage: (Pick<Storage, 'getItem'> & Pick<Storage, 'setItem'>) | undefined,
  albumId: string,
  sort: LibrarySort,
  order?: AssetOrder | null,
): LibrarySort | null => {
  const map = readMap(storage);
  const personal = sort === albumOrderSort(order) ? null : sort;
  if (personal) {
    map[albumId] = personal;
  } else {
    delete map[albumId];
  }
  try {
    storage?.setItem(ALBUM_VIEW_SORT_KEY, JSON.stringify(map));
  } catch {
    // A per-device convenience; the choice still holds for this visit.
  }
  return personal;
};

/** The sort the album is shown in: the viewer's own choice, else the album's shared order. */
export const effectiveAlbumSort = (personal: LibrarySort | null, order?: AssetOrder | null): LibrarySort =>
  personal ?? albumOrderSort(order);
