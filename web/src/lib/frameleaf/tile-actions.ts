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
  /** The page is the Locked view, whose items are never favorited, edited or shared from a tile. */
  locked?: boolean;
};

export type TileActionAvailability = { favorite: boolean; edit: boolean; share: boolean; more: boolean };

/**
 * What a tile may offer. Favorite, edit and share change the item, so they are the owner's alone,
 * as the selection bar's descriptors decide (`bulk-actions.ts`). A Locked item — on the Locked page
 * or revealed in an unlocked session — offers none of them: the bar offers no favorite for Locked
 * items, the editor would write a new version outside the Locked session, and a link would carry it
 * out of it. Only More (the viewer, which applies its own Locked rules) remains.
 */
export const tileActionAvailability = (
  asset: Pick<TimelineAsset, 'ownerId' | 'isTrashed' | 'visibility'>,
  context: TileActionContext,
): TileActionAvailability => {
  const owned = !!context.currentUserId && asset.ownerId === context.currentUserId;
  const locked = !!context.locked || asset.visibility === AssetVisibility.Locked;
  const live = owned && !asset.isTrashed && !context.trash && !locked;
  return {
    favorite: live,
    edit: live && context.canEdit,
    share: live && context.canShare,
    more: context.canOpen,
  };
};
