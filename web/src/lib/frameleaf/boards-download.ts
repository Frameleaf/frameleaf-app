import { AlbumUserRole, getAlbumItems, LibraryAssetItemKind, type AlbumResponseDto } from '@frameleaf/sdk';
import { downloadArchive, ignoreCancelledDownload } from '$lib/utils/asset-utils';
import { handleError } from '$lib/utils/handle-error';

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

/**
 * A library file lists only the account's own items: the server refuses one for anything shared
 * with them. A collection qualifies when this person owns it and nobody else can add to it.
 */
export const canIncludeLibraryForCollection = (album: AlbumResponseDto, userId: string) =>
  album.albumUsers.some(({ role, user }) => role === AlbumUserRole.Owner && user.id === userId) &&
  album.albumUsers.every(({ role }) => role !== AlbumUserRole.Editor);

/** Every file and saved link in a collection, read a page at a time. */
export const collectionItems = async (albumId: string, signal?: AbortSignal) => {
  const assetIds: string[] = [];
  const bookmarkIds: string[] = [];
  let cursor: { afterId: string; afterKind: import('@frameleaf/sdk').LibraryItemKind } | undefined;
  do {
    const page = await getAlbumItems({ id: albumId, limit: ITEMS_PAGE, ...cursor }, { signal });
    for (const item of page.items) {
      if (item.kind === LibraryAssetItemKind.Asset) {
        assetIds.push(item.asset.id);
      } else {
        bookmarkIds.push(item.bookmark.id);
      }
    }
    cursor = page.nextCursor ? { afterId: page.nextCursor.id, afterKind: page.nextCursor.kind } : undefined;
  } while (cursor && assetIds.length + bookmarkIds.length <= LIBRARY_FILE_LIMIT);
  return { assetIds, bookmarkIds };
};

/**
 * A collection's Download. Without the library file the server reads the collection itself; with
 * it, every file and saved link is listed first so the library file can name them all.
 */
export const downloadBoardsCollection = async ({
  album,
  fileName,
  includeLibrary,
  errorMessage,
}: {
  album: AlbumResponseDto;
  fileName: string;
  includeLibrary: boolean;
  /** Shown when the collection's items cannot be read. */
  errorMessage: string;
}) => {
  if (!includeLibrary) {
    return downloadArchive(fileName, { albumId: album.id }, { originals: true }).catch(ignoreCancelledDownload);
  }
  let items: Awaited<ReturnType<typeof collectionItems>>;
  try {
    items = await collectionItems(album.id);
  } catch (error) {
    handleError(error, errorMessage);
    return;
  }
  return downloadBoardsItems({ fileName, ...items, includeLibrary: true });
};
