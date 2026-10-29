import {
  addAssetsToAlbum,
  deleteAssets,
  trashBookmark,
  updateAssets,
  updateBookmark,
  type LibraryScope,
  addBookmarksToAlbum,
  removeAssetFromAlbum,
  removeBookmarksFromAlbum,
  bulkTagAssets,
  BulkIdErrorReason,
  addBookmarkTags,
  LibraryAssetItemKind,
  upsertTags,
  type LibraryItemDto,
} from '@frameleaf/sdk';
import { chunk, type BulkPayload } from '$lib/frameleaf/bulk-operations';

/** Mixed organization changes memberships and tags, never original files or media identity. */
export const organizeLibraryItems = async (
  items: LibraryItemDto[],
  keys: string[],
  ownerId: string,
  payload: BulkPayload,
  current: () => boolean,
  operation: 'add' | 'remove' = 'add',
) => {
  const assertCurrent = () => {
    if (!current()) {
      throw new DOMException('Library access changed', 'AbortError');
    }
  };
  assertCurrent();
  const selected = new Set(keys);
  const assets: string[] = [];
  const bookmarks: string[] = [];
  for (const item of items) {
    if (item.kind === LibraryAssetItemKind.Asset) {
      if (selected.has(item.asset.id)) {
        assets.push(item.asset.id);
      }
    } else if (selected.has(`bookmark:${item.bookmark.id}`)) {
      if (operation !== 'remove' && item.bookmark.ownerId !== ownerId) {
        throw new Error('Only owned bookmarks can be organized');
      }
      bookmarks.push(item.bookmark.id);
    }
  }
  if (assets.length + bookmarks.length !== selected.size) {
    throw new Error('The selection is no longer available');
  }
  if (payload.albumId) {
    for (const [ids, add] of [
      [
        assets,
        (ids: string[]) =>
          operation === 'remove'
            ? removeAssetFromAlbum({ id: payload.albumId!, bulkIdsDto: { ids } })
            : addAssetsToAlbum({ id: payload.albumId!, bulkIdsDto: { ids } }),
      ],
      [
        bookmarks,
        (ids: string[]) =>
          operation === 'remove'
            ? removeBookmarksFromAlbum({ id: payload.albumId!, bookmarkIdsDto: { ids } })
            : addBookmarksToAlbum({ id: payload.albumId!, bookmarkIdsDto: { ids } }),
      ],
    ] as const) {
      for (const batch of chunk(ids)) {
        assertCurrent();
        const result = await add(batch);
        assertCurrent();
        if (result.some((row) => !row.success && row.error !== BulkIdErrorReason.Duplicate)) {
          throw new Error('Some album memberships failed');
        }
      }
    }
    return;
  }
  if (operation === 'remove') {
    throw new Error('Album is required');
  }
  let tagIds = [...new Set(payload.tagIds)];
  const names = payload.newTagNames?.map((name) => name.trim()).filter(Boolean) ?? [];
  if (names.length > 0) {
    const tags = await upsertTags({ tagUpsertDto: { tags: names } });
    assertCurrent();
    tagIds = [...new Set([...tagIds, ...tags.map((tag) => tag.id)])];
  }
  if (tagIds.length === 0) {
    return;
  }
  for (const batch of chunk(assets)) {
    assertCurrent();
    await bulkTagAssets({ tagBulkAssetsDto: { assetIds: batch, tagIds } });
    assertCurrent();
  }
  for (const id of bookmarks) {
    assertCurrent();
    await addBookmarkTags({ id, bookmarkTagsDto: { ids: tagIds } });
    assertCurrent();
  }
};

type Current = () => boolean;

const guard = (current: Current) => () => {
  if (!current()) {
    throw new DOMException('Library access changed', 'AbortError');
  }
};

/**
 * The selected files and saved links, in page order. Every key must still be on the page, and with
 * `ownerId` every item must belong to that account: rating, "Show in Photos too" and trash change the
 * item itself, which only its owner may do.
 */
export const splitLibrarySelection = (items: LibraryItemDto[], keys: string[], ownerId?: string) => {
  const selected = new Set(keys);
  const assets: string[] = [];
  const bookmarks: string[] = [];
  for (const item of items) {
    if (item.kind === LibraryAssetItemKind.Asset) {
      if (selected.has(item.asset.id)) {
        if (ownerId && (!('ownerId' in item.asset) || item.asset.ownerId !== ownerId)) {
          throw new Error('Only owned items can be changed');
        }
        assets.push(item.asset.id);
      }
    } else if (selected.has(`bookmark:${item.bookmark.id}`)) {
      if (ownerId && item.bookmark.ownerId !== ownerId) {
        throw new Error('Only owned items can be changed');
      }
      bookmarks.push(item.bookmark.id);
    }
  }
  if (assets.length + bookmarks.length !== selected.size) {
    throw new Error('The selection is no longer available');
  }
  return { assets, bookmarks };
};

/** True when every selected item on the page belongs to `ownerId`. */
export const ownsLibrarySelection = (items: LibraryItemDto[], keys: string[], ownerId: string) => {
  try {
    splitLibrarySelection(items, keys, ownerId);
    return keys.length > 0;
  } catch {
    return false;
  }
};

/** Rate files and links together: 1–5 stars, -1 rejected (kept, but left out of picks), or null. */
export const rateLibraryItems = async (
  items: LibraryItemDto[],
  keys: string[],
  ownerId: string,
  rating: number | null,
  current: Current,
) => {
  const assertCurrent = guard(current);
  assertCurrent();
  const { assets, bookmarks } = splitLibrarySelection(items, keys, ownerId);
  for (const ids of chunk(assets)) {
    assertCurrent();
    await updateAssets({ assetBulkUpdateDto: { ids, rating } });
  }
  for (const id of bookmarks) {
    assertCurrent();
    await updateBookmark({ id, bookmarkUpdateDto: { rating } });
  }
  assertCurrent();
};

/**
 * "Show in Photos too" (`both`) or "Boards only" (`design`) for the selected files. Saved links never
 * appear in Photos, so they are left as they are.
 */
export const setLibraryItemsScope = async (
  items: LibraryItemDto[],
  keys: string[],
  ownerId: string,
  libraryScope: LibraryScope,
  current: Current,
) => {
  const assertCurrent = guard(current);
  assertCurrent();
  const { assets } = splitLibrarySelection(items, keys, ownerId);
  for (const ids of chunk(assets)) {
    assertCurrent();
    await updateAssets({ assetBulkUpdateDto: { ids, libraryScope } });
  }
  assertCurrent();
};

/** Move the selected files and links to the trash; both can be restored from there. */
export const trashLibraryItems = async (items: LibraryItemDto[], keys: string[], ownerId: string, current: Current) => {
  const assertCurrent = guard(current);
  assertCurrent();
  const { assets, bookmarks } = splitLibrarySelection(items, keys, ownerId);
  for (const ids of chunk(assets)) {
    assertCurrent();
    await deleteAssets({ assetBulkDeleteDto: { ids } });
  }
  for (const id of bookmarks) {
    assertCurrent();
    await trashBookmark({ id });
  }
  assertCurrent();
};
