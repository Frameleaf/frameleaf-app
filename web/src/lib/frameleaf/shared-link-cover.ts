import { AssetOrder, AssetVisibility, searchAssets, type SharedLinkResponseDto } from '@frameleaf/sdk';

/**
 * What a shared link's cover shows (the design's `AssetCollage`, `SharedLinkForm.jsx:31-53`): up to
 * four of the items it shares, and how many it shares in all for the "+N" and the item count.
 */
export interface SharedLinkCover {
  ids: string[];
  count: number;
}

/**
 * The cover of a link, as the server gives it on every link it returns: an album's chosen cover and
 * then its newest items, or a selection's first items, and the number of items shared. The server
 * leaves Locked, trashed and hidden items out of both, so nothing is worked out here.
 */
export const sharedLinkCover = (
  link: Pick<SharedLinkResponseDto, 'coverAssetIds' | 'assetCount'>,
): SharedLinkCover => ({
  ids: link.coverAssetIds,
  count: link.assetCount,
});

const COVER_ITEMS = 4;
// Room to leave Locked items and the chosen cover's own place out and still fill the cover.
const ALBUM_PAGE = COVER_ITEMS * 3;

/**
 * The cover a new album link will have, read before the link exists so the form's preview matches
 * the card the person gets. It is the server's rule for an album link (`SharedLinkRepository.getAll`):
 * the cover the album's owner chose first, then the newest items, four at most, never a Locked one.
 */
export const loadAlbumLinkCoverIds = async (albumId: string, chosenCoverId?: string | null): Promise<string[]> => {
  const { assets } = await searchAssets({
    metadataSearchDto: { albumIds: [albumId], order: AssetOrder.Desc, size: ALBUM_PAGE },
  });
  const newest = assets.items.filter(({ visibility }) => visibility !== AssetVisibility.Locked).map(({ id }) => id);
  return (chosenCoverId ? [chosenCoverId, ...newest.filter((id) => id !== chosenCoverId)] : newest).slice(
    0,
    COVER_ITEMS,
  );
};
