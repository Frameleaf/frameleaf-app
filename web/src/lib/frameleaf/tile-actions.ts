import { AssetVisibility } from '@frameleaf/sdk';
import { isRevealedLock } from '$lib/frameleaf/session-access.svelte';
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
  /** Right-click: the selection bar's actions as a menu at the pointer. */
  onContextMenu?: (event: MouseEvent) => void;
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
 * as the selection bar's descriptors decide (`bulk-actions.ts`). A Locked item on the Locked page
 * offers none of them. Revealed in an unlocked session (FL-195) it acts like any other item — favorite
 * and edit (the editor keeps its copy Locked) — but is never shared: a link would carry it out to
 * people who must never see it. More (the viewer, which applies its own Locked rules) always remains.
 */
export const tileActionAvailability = (
  asset: Pick<TimelineAsset, 'ownerId' | 'isTrashed' | 'visibility' | 'lockReason'>,
  context: TileActionContext,
): TileActionAvailability => {
  const owned = !!context.currentUserId && asset.ownerId === context.currentUserId;
  // FL-195: a revealed mark or detection outside the Locked view behaves like any other item, except
  // that it is never shared: a link would carry it out to people who must never see it
  const revealed = !context.locked && isRevealedLock(asset);
  const locked = !!context.locked || (asset.visibility === AssetVisibility.Locked && !revealed);
  const live = owned && !asset.isTrashed && !context.trash && !locked;
  return {
    favorite: live,
    edit: live && context.canEdit,
    share: live && !revealed && context.canShare,
    more: context.canOpen,
  };
};
