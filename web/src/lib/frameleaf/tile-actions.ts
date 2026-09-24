import { AssetVisibility } from '@immich/sdk';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';

/**
 * A tile's hover quick actions (prototype `AssetTile.jsx` `.at-actions`: favorite, edit, share,
 * more). Each is present only when the tile may offer it; an absent one is not drawn.
 */
export type TileQuickActions = {
  onFavorite?: () => void;
  onEdit?: () => void;
  onShare?: () => void;
  onMore?: () => void;
};

export type TileActionContext = {
  currentUserId?: string;
  /** The page has a viewer with the quick editor. */
  canEdit: boolean;
  /** The page can create a shared link (its selection bar is the Frameleaf one). */
  canShare: boolean;
  /** The page has a viewer to open. */
  canOpen: boolean;
  /** The page shows the trash, where nothing but restore and delete applies. */
  trash?: boolean;
};

export type TileActionAvailability = { favorite: boolean; edit: boolean; share: boolean; more: boolean };

/**
 * What a tile may offer. Favorite, edit and share change the item, so they are the owner's alone,
 * as the selection bar's descriptors decide (`bulk-actions.ts`). A Locked item is never shared from
 * a tile: a link would carry it out of the Locked session.
 */
export const tileActionAvailability = (
  asset: Pick<TimelineAsset, 'ownerId' | 'isTrashed' | 'visibility'>,
  context: TileActionContext,
): TileActionAvailability => {
  const owned = !!context.currentUserId && asset.ownerId === context.currentUserId;
  const live = owned && !asset.isTrashed && !context.trash;
  return {
    favorite: live,
    edit: live && context.canEdit,
    share: live && context.canShare && asset.visibility !== AssetVisibility.Locked,
    more: context.canOpen,
  };
};
