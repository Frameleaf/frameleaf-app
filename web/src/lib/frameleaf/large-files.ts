import type { AssetResponseDto } from '@immich/sdk';

/**
 * The large-file review (FL-47), ported from the large-files part of the design template's
 * `UtilitiesManager.jsx`. The list is the server's own largest originals the account can see
 * (`searchLargeAssets`): its own media, and media partners share with it. Only its own can be moved
 * to the trash; a partner's item shows "Owner access required", as in the template.
 */

/** Where an item stands on this page. */
export type LargeFileStatus = 'open' | 'trashed' | 'shared';

/** "Needs attention" hides what was already moved to the trash; "All results" keeps it in view. */
export type LargeFileShow = 'open' | 'all';

/** All accounts, or one owner's id. */
export const LARGE_FILES_ALL_ACCOUNTS = 'all';

export type LargeFileContext = {
  userId: string;
  /** Items moved to the trash since the list was loaded, here, in the viewer or in another tab. */
  trashed: ReadonlySet<string>;
};

/** The logical size of the original, in bytes; not the space removing it frees. */
export const largeFileSize = (asset: Pick<AssetResponseDto, 'exifInfo'>) => asset.exifInfo?.fileSizeInByte ?? 0;

export const largeFileStatus = (
  asset: Pick<AssetResponseDto, 'id' | 'ownerId'>,
  context: LargeFileContext,
): LargeFileStatus => {
  if (context.trashed.has(asset.id)) {
    return 'trashed';
  }
  return asset.ownerId === context.userId ? 'open' : 'shared';
};

/** Only the owner's own items that are still in the library can be moved to the trash. */
export const canTrashLargeFile = (asset: Pick<AssetResponseDto, 'id' | 'ownerId'>, context: LargeFileContext) =>
  largeFileStatus(asset, context) === 'open';

export type LargeFileFilters = {
  owner: string;
  show: LargeFileShow;
  query: string;
  /** Owner name and status label, as the page shows them, for "Filename, owner or status" search. */
  describe: (asset: AssetResponseDto) => string;
};

/** The rows in view, largest original first. */
export const filterLargeFiles = (
  assets: readonly AssetResponseDto[],
  context: LargeFileContext,
  { owner, show, query, describe }: LargeFileFilters,
) => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return assets
    .filter((asset) => {
      if (owner !== LARGE_FILES_ALL_ACCOUNTS && asset.ownerId !== owner) {
        return false;
      }
      if (show === 'open' && largeFileStatus(asset, context) === 'trashed') {
        return false;
      }
      if (terms.length === 0) {
        return true;
      }
      const searchable = `${asset.originalFileName} ${describe(asset)}`.toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    })
    .toSorted((a, b) => largeFileSize(b) - largeFileSize(a));
};

/** The owners present in the list, the signed-in account first, for the Account select. */
export const largeFileOwners = (assets: readonly Pick<AssetResponseDto, 'ownerId'>[], userId: string) => {
  const others = [...new Set(assets.map((asset) => asset.ownerId))].filter((id) => id !== userId);
  return [userId, ...others];
};

/** The downloadable file list: what is in view, with sizes, never file contents. */
export const largeFileExport = (
  rows: readonly AssetResponseDto[],
  { owner, ownerName }: { owner: string; ownerName: (id: string) => string },
) => ({
  scope: owner === LARGE_FILES_ALL_ACCOUNTS ? 'all' : ownerName(owner),
  items: rows.map((asset) => ({
    id: asset.id,
    name: asset.originalFileName,
    owner: ownerName(asset.ownerId),
    bytes: largeFileSize(asset),
  })),
});
