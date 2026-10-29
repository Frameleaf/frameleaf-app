import { getAlbumItems, LibraryAssetItemKind, type AlbumResponseDto } from '@frameleaf/sdk';
import { downloadArchive, ignoreCancelledDownload } from '$lib/utils/asset-utils';

/**
 * Boards' Download (FL-660, prototype `ExportDialog`, README point 10): the originals as a .zip,
 * optionally with `frameleaf-library.json` so the work can move to another app.
 */

/** The server builds a library file for at most this many files and links (`DownloadArchiveDto`). */
export const LIBRARY_FILE_LIMIT = 10_000;

/** The largest page `GET /albums/{id}/items` returns. */
const ITEMS_PAGE = 200;

export type BoardsDownload = {
  fileName: string;
  assetIds: string[];
  /** Saved links in the selection. They have no file, so only the library file lists them. */
  bookmarkIds: string[];
  includeLibrary: boolean;
};

/** Starts the download in the download panel; a cancel there is not an error. */
export const downloadBoardsItems = ({ fileName, assetIds, bookmarkIds, includeLibrary }: BoardsDownload) =>
  downloadArchive(fileName, { assetIds }, includeLibrary ? { library: { bookmarkIds } } : { originals: true }).catch(
    ignoreCancelledDownload,
  );

export type CollectionItems = {
  assetIds: string[];
  bookmarkIds: string[];
  /** Every file and link read belongs to this person. */
  owned: boolean;
  /** Every page was read: reading stops once there are more than a library file can list. */
  complete: boolean;
};

/**
 * Every file and saved link in a collection, read a page at a time, and whether they are all this
 * person's own. A collection they own can still hold items that the people it is shared with added.
 */
export const collectionItems = async (
  albumId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<CollectionItems> => {
  const assetIds: string[] = [];
  const bookmarkIds: string[] = [];
  let owned = true;
  let cursor: { afterId: string; afterKind: import('@frameleaf/sdk').LibraryItemKind } | undefined;
  do {
    const page = await getAlbumItems({ id: albumId, limit: ITEMS_PAGE, ...cursor }, { signal });
    for (const item of page.items) {
      if (item.kind === LibraryAssetItemKind.Asset) {
        assetIds.push(item.asset.id);
        owned &&= 'ownerId' in item.asset && item.asset.ownerId === userId;
      } else {
        bookmarkIds.push(item.bookmark.id);
        owned &&= item.bookmark.ownerId === userId;
      }
    }
    cursor = page.nextCursor ? { afterId: page.nextCursor.id, afterKind: page.nextCursor.kind } : undefined;
  } while (cursor && assetIds.length + bookmarkIds.length <= LIBRARY_FILE_LIMIT);
  return { assetIds, bookmarkIds, owned, complete: !cursor };
};

/**
 * The server makes a library file only for the account's own items, at most `LIBRARY_FILE_LIMIT`
 * of them. Until a collection's items are read (`null`) the answer is no.
 */
export const canIncludeLibrary = (items: CollectionItems | null) =>
  !!items && items.owned && items.complete && items.assetIds.length + items.bookmarkIds.length <= LIBRARY_FILE_LIMIT;

/**
 * A collection's Download. With the library file it downloads the items that were read, so the
 * file can name them all; otherwise the server reads the collection itself.
 */
export const downloadBoardsCollection = ({
  album,
  fileName,
  items,
  includeLibrary,
}: {
  album: AlbumResponseDto;
  fileName: string;
  items: CollectionItems | null;
  includeLibrary: boolean;
}) => {
  if (includeLibrary && items && canIncludeLibrary(items)) {
    const { assetIds, bookmarkIds } = items;
    return downloadBoardsItems({ fileName, assetIds, bookmarkIds, includeLibrary: true });
  }
  return downloadArchive(fileName, { albumId: album.id }, { originals: true }).catch(ignoreCancelledDownload);
};
