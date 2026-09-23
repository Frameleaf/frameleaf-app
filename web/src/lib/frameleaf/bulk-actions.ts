import { AssetTypeEnum, AssetVisibility, type AssetResponseDto } from '@immich/sdk';

/**
 * Bulk action descriptors for the Frameleaf selection bar.
 *
 * Ported for FL-32 from the approved prototype `design/frameleaf/template/src/selection.mjs`
 * (`bulkActions`, `bulkActionGroups`, `actionLabel`) and the `bulkAction` dispatcher in `App.jsx`.
 * The September 22, 2026 interaction revision fixes what this module has to guarantee:
 *
 * - Selection is a multi-select state separate from the open item, and the floating selection bar
 *   carries the complete bulk set: favorite, add to album, share link, download, stack, link motion
 *   clips, change date, description and location, archive, Mark Sensitive and Unmark Sensitive,
 *   tag, delete with undo, and the per-item refresh jobs.
 * - Trash undo uses restore; partial failures report per item.
 *
 * This module is pure: it decides which actions a selection offers and what they are called. The
 * calls themselves live in `bulk-operations.ts`, which binds each id to an existing endpoint.
 */
export type BulkActionGroupId = 'primary' | 'organize' | 'visibility' | 'album' | 'jobs';

export const BULK_ACTION_GROUP_ORDER: readonly BulkActionGroupId[] = [
  'primary',
  'organize',
  'visibility',
  'album',
  'jobs',
];

export type BulkActionGroup = { id: BulkActionGroupId; titleKey: string };

/** Menu section headings, in the prototype's order. */
export const bulkActionGroups: readonly BulkActionGroup[] = [
  { id: 'primary', titleKey: 'frameleaf_bulk_group_primary' },
  { id: 'organize', titleKey: 'frameleaf_bulk_group_organize' },
  { id: 'visibility', titleKey: 'frameleaf_bulk_group_visibility' },
  { id: 'album', titleKey: 'frameleaf_bulk_group_album' },
  { id: 'jobs', titleKey: 'frameleaf_bulk_group_jobs' },
];

export type BulkActionId =
  | 'favorite'
  | 'unfavorite'
  | 'add-to-album'
  | 'create-shared-link'
  | 'download'
  | 'delete'
  | 'restore'
  | 'delete-permanently'
  | 'stack'
  | 'unstack'
  | 'link-live-photo'
  | 'unlink-live-photo'
  | 'tag'
  /** Undo-only: reverses a tag. It has no descriptor row, so it never appears in the bar. */
  | 'untag'
  | 'change-date'
  | 'change-description'
  | 'change-location'
  | 'archive'
  | 'unarchive'
  | 'mark-sensitive'
  | 'unmark-sensitive'
  | 'move-to-locked'
  | 'remove-from-locked'
  | 'remove-from-album'
  | 'set-album-cover'
  | 'remove-from-shared-link'
  | 'refresh-thumbnails'
  | 'refresh-metadata'
  | 'refresh-encoded'
  | 'refresh-faces';

/**
 * The part of an asset a descriptor reads. The production list DTO is a superset; `toBulkAsset`
 * narrows it so the selection bar never depends on fields a bucket response may omit.
 */
export type BulkAsset = {
  id: string;
  ownerId?: string;
  isVideo?: boolean;
  isFavorite?: boolean;
  isArchived?: boolean;
  isTrashed?: boolean;
  isLivePhoto?: boolean;
  stackId?: string | null;
};

export const toBulkAsset = (asset: AssetResponseDto): BulkAsset => ({
  id: asset.id,
  ownerId: asset.ownerId,
  isVideo: asset.type === AssetTypeEnum.Video,
  isFavorite: asset.isFavorite,
  isArchived: asset.isArchived || asset.visibility === AssetVisibility.Archive,
  isTrashed: asset.isTrashed,
  isLivePhoto: !!asset.livePhotoVideoId,
  stackId: asset.stack?.id ?? null,
});

export type BulkActionContext = {
  /** The selected assets when they are loaded. May be empty for a snapshot selection. */
  assets?: BulkAsset[];
  /** How many items are selected. Used when the assets themselves are not loaded. */
  count?: number;
  /** Set when the results are an album's contents; enables the album-scoped actions. */
  albumId?: string | null;
  /** Set when the results are a shared link's contents. */
  sharedLinkId?: string | null;
  /** True on the trash destination: the live actions are replaced by restore and permanent delete. */
  trash?: boolean;
  /**
   * True on the Locked destination. Locked browsing is its own, elevated context: the items are
   * deliberately out of the library, so the sharing and organizing actions are not offered and the
   * only removal is the permanent one, exactly as the legacy locked select bar behaved.
   */
  locked?: boolean;
  /**
   * True where the viewer may look and download but not change anything — a shared link opened by
   * someone who is not signed in. Only the download survives; nothing that mutates is offered.
   */
  readOnly?: boolean;
  /** The authenticated user. Assets owned by anyone else cannot be mutated. */
  currentUserId?: string;
  /**
   * True for a "select everything matching" snapshot, where the ids are not resolved yet. Actions
   * that need the individual assets (stack, Live Photo linking, album cover) are not offered.
   */
  snapshot?: boolean;
};

export type BulkAction = {
  id: BulkActionId;
  labelKey: string;
  icon: string;
  group: BulkActionGroupId;
  available: boolean;
  /** Destructive styling and, with `confirm`, a deliberate confirmation. */
  danger: boolean;
  /** Opens a dialog to collect a payload before anything is sent. */
  dialog: boolean;
  /** Requires an explicit confirmation; used only where there is no undo. */
  confirm: boolean;
  /** Offers an undo entry once it has run. Trash undoes through restore. */
  undoable: boolean;
  /** Album the action acts on, for the album-scoped entries. */
  albumId?: string;
};

const asAssets = (context: BulkActionContext): BulkAsset[] =>
  Array.isArray(context.assets) ? context.assets.filter(Boolean) : [];

/** Assets the authenticated user may mutate. Without an owner the caller has not resolved it yet. */
export const ownedAssets = (assets: BulkAsset[], currentUserId?: string): BulkAsset[] =>
  currentUserId ? assets.filter((asset) => !asset.ownerId || asset.ownerId === currentUserId) : assets;

/** The single photo/video pair that can become a Live Photo, or null. */
export const livePhotoPair = (assets: BulkAsset[]): { photoId: string; videoId: string } | null => {
  const photos = assets.filter((asset) => !asset.isVideo);
  const videos = assets.filter((asset) => asset.isVideo);
  if (photos.length !== 1 || videos.length !== 1 || photos[0].isLivePhoto) {
    return null;
  }
  return { photoId: photos[0].id, videoId: videos[0].id };
};

/** Distinct stack ids across a selection, for Unstack. */
export const selectedStackIds = (assets: BulkAsset[]): string[] => [
  ...new Set(assets.map((asset) => asset.stackId).filter((id): id is string => !!id)),
];

/**
 * The ordered descriptors for a selection. Mirrors the prototype's availability rules; where the
 * production list response cannot answer a predicate (the sensitive mark is not carried on the
 * asset DTO) both directions of the action are offered and the server decides per item.
 */
export const bulkActions = (context: BulkActionContext = {}): BulkAction[] => {
  const assets = asAssets(context);
  const count = assets.length || Math.max(0, Number(context.count) || 0);
  const has = count > 0;
  const albumId = typeof context.albumId === 'string' && context.albumId ? context.albumId : null;
  const sharedLinkId =
    typeof context.sharedLinkId === 'string' && context.sharedLinkId ? context.sharedLinkId : null;
  const trash = !!context.trash;
  const locked = !!context.locked;
  const readOnly = !!context.readOnly;
  /** The ordinary library destinations: neither trash nor the Locked folder. */
  const live = !trash && !locked && !readOnly;
  const snapshot = !!context.snapshot;
  /** True when no asset is loaded: the descriptor cannot inspect the selection, so it offers. */
  const unknown = assets.length === 0;
  const any = (predicate: (asset: BulkAsset) => boolean) => assets.some(predicate);
  const resolved = has && !snapshot;

  const rows: (Omit<BulkAction, 'danger' | 'dialog' | 'confirm' | 'undoable' | 'albumId'> &
    Partial<Pick<BulkAction, 'danger' | 'dialog' | 'confirm' | 'undoable'>>)[] = [
    {
      id: 'favorite',
      labelKey: 'frameleaf_bulk_favorite',
      icon: 'mdiHeartOutline',
      group: 'primary',
      undoable: true,
      available: live && has && (unknown || any((asset) => !asset.isFavorite)),
    },
    {
      id: 'unfavorite',
      labelKey: 'frameleaf_bulk_unfavorite',
      icon: 'mdiHeart',
      group: 'primary',
      undoable: true,
      available: live && has && (unknown || any((asset) => !!asset.isFavorite)),
    },
    {
      id: 'add-to-album',
      labelKey: 'frameleaf_bulk_add_to_album',
      icon: 'mdiImageAlbum',
      group: 'primary',
      undoable: true,
      dialog: true,
      available: live && has,
    },
    {
      id: 'create-shared-link',
      labelKey: 'frameleaf_bulk_create_shared_link',
      icon: 'mdiLinkVariant',
      group: 'primary',
      available: live && has,
    },
    {
      id: 'download',
      labelKey: 'frameleaf_bulk_download',
      icon: 'mdiDownloadOutline',
      group: 'primary',
      available: has,
    },
    {
      id: 'delete',
      labelKey: 'frameleaf_bulk_delete',
      icon: 'mdiDeleteOutline',
      group: 'primary',
      danger: true,
      // Trash is reversible: it offers undo rather than a confirmation.
      undoable: true,
      available: live && has,
    },
    {
      id: 'restore',
      labelKey: 'frameleaf_bulk_restore',
      icon: 'mdiDeleteRestore',
      group: 'primary',
      available: !readOnly && trash && has,
    },
    {
      id: 'delete-permanently',
      labelKey: 'frameleaf_bulk_delete_permanently',
      icon: 'mdiDeleteForeverOutline',
      group: 'primary',
      danger: true,
      confirm: true,
      // The Locked folder has no trash step of its own: a delete there is the permanent one.
      available: !readOnly && (trash || locked) && has,
    },
    {
      id: 'stack',
      labelKey: 'frameleaf_bulk_stack',
      icon: 'mdiLayersPlus',
      group: 'organize',
      undoable: true,
      // Stacking needs the exact members and their order; a snapshot has neither.
      available: live && resolved && count >= 2,
    },
    {
      id: 'unstack',
      labelKey: 'frameleaf_bulk_unstack',
      icon: 'mdiLayersOutline',
      group: 'organize',
      available: live && resolved && any((asset) => !!asset.stackId),
    },
    {
      id: 'link-live-photo',
      labelKey: 'frameleaf_bulk_link_live_photo',
      icon: 'mdiMotionPlayOutline',
      group: 'organize',
      undoable: true,
      available: live && resolved && !!livePhotoPair(assets),
    },
    {
      id: 'unlink-live-photo',
      labelKey: 'frameleaf_bulk_unlink_live_photo',
      icon: 'mdiMotionPauseOutline',
      group: 'organize',
      available: live && resolved && any((asset) => !!asset.isLivePhoto),
    },
    {
      id: 'tag',
      labelKey: 'frameleaf_bulk_tag',
      icon: 'mdiTagPlusOutline',
      group: 'organize',
      undoable: true,
      dialog: true,
      available: live && has,
    },
    {
      id: 'change-date',
      labelKey: 'frameleaf_bulk_change_date',
      icon: 'mdiCalendarEdit',
      group: 'organize',
      dialog: true,
      available: !readOnly && (live || locked) && has,
    },
    {
      id: 'change-description',
      labelKey: 'frameleaf_bulk_change_description',
      icon: 'mdiTextBoxOutline',
      group: 'organize',
      dialog: true,
      available: live && has,
    },
    {
      id: 'change-location',
      labelKey: 'frameleaf_bulk_change_location',
      icon: 'mdiMapMarkerOutline',
      group: 'organize',
      dialog: true,
      available: !readOnly && (live || locked) && has,
    },
    {
      id: 'archive',
      labelKey: 'frameleaf_bulk_archive',
      icon: 'mdiArchiveOutline',
      group: 'visibility',
      undoable: true,
      available: live && has && (unknown || any((asset) => !asset.isArchived)),
    },
    {
      id: 'unarchive',
      labelKey: 'frameleaf_bulk_unarchive',
      icon: 'mdiArchiveArrowUpOutline',
      group: 'visibility',
      undoable: true,
      available: live && has && (unknown || any((asset) => !!asset.isArchived)),
    },
    {
      // Marking is metadata on the asset; album membership and organization are untouched and no
      // asset is relocated. "Locked" remains the name of the filtered destination, never this action.
      id: 'mark-sensitive',
      labelKey: 'frameleaf_bulk_mark_sensitive',
      icon: 'mdiShieldLockOutline',
      group: 'visibility',
      undoable: true,
      available: live && has,
    },
    {
      id: 'unmark-sensitive',
      labelKey: 'frameleaf_bulk_unmark_sensitive',
      icon: 'mdiShieldOutline',
      group: 'visibility',
      undoable: true,
      available: live && has,
    },
    {
      // Moving into the Locked folder is a visibility change on the asset, and the only way back
      // out is the matching action on the Locked destination itself.
      id: 'move-to-locked',
      labelKey: 'frameleaf_bulk_move_to_locked',
      icon: 'mdiLockOutline',
      group: 'visibility',
      confirm: true,
      available: live && has,
    },
    {
      id: 'remove-from-locked',
      labelKey: 'frameleaf_bulk_remove_from_locked',
      icon: 'mdiLockOpenVariantOutline',
      group: 'visibility',
      confirm: true,
      available: !readOnly && locked && has,
    },
    {
      id: 'remove-from-album',
      labelKey: 'frameleaf_bulk_remove_from_album',
      icon: 'mdiPlaylistRemove',
      group: 'album',
      undoable: true,
      available: live && has && !!albumId,
    },
    {
      id: 'set-album-cover',
      labelKey: 'frameleaf_bulk_set_album_cover',
      icon: 'mdiImageOutline',
      group: 'album',
      available: live && resolved && count === 1 && !!albumId,
    },
    {
      id: 'remove-from-shared-link',
      labelKey: 'frameleaf_bulk_remove_from_shared_link',
      icon: 'mdiLinkOff',
      group: 'album',
      // The link's own owner may prune it even from a read-only viewer, which is the only
      // mutation that viewer ever offered. The caller passes the id only when they own it.
      available: !trash && !locked && has && !!sharedLinkId,
    },
    {
      id: 'refresh-thumbnails',
      labelKey: 'frameleaf_bulk_refresh_thumbnails',
      icon: 'mdiImageMultipleOutline',
      group: 'jobs',
      available: !readOnly && !locked && has,
    },
    {
      id: 'refresh-metadata',
      labelKey: 'frameleaf_bulk_refresh_metadata',
      icon: 'mdiDatabaseRefreshOutline',
      group: 'jobs',
      available: !readOnly && !locked && has,
    },
    {
      id: 'refresh-faces',
      labelKey: 'frameleaf_bulk_refresh_faces',
      icon: 'mdiFaceRecognition',
      group: 'jobs',
      available: !readOnly && !locked && has,
    },
    {
      id: 'refresh-encoded',
      labelKey: 'frameleaf_bulk_refresh_encoded',
      icon: 'mdiMovieEditOutline',
      group: 'jobs',
      available: !readOnly && !locked && has && (unknown || assets.some((asset) => asset.isVideo)),
    },
  ];

  return rows
    .map((row) => ({
      danger: false,
      dialog: false,
      confirm: false,
      undoable: false,
      ...row,
      ...(row.group === 'album' && albumId ? { albumId } : {}),
    }))
    .sort((left, right) => BULK_ACTION_GROUP_ORDER.indexOf(left.group) - BULK_ACTION_GROUP_ORDER.indexOf(right.group));
};

export const bulkActionById = (actions: BulkAction[]): Partial<Record<BulkActionId, BulkAction>> =>
  Object.fromEntries(actions.map((action) => [action.id, action]));

/** The actions the bar shows as buttons; everything else sits in the More menu. */
export const PRIMARY_BULK_ACTIONS: readonly BulkActionId[] = [
  'favorite',
  'add-to-album',
  'create-shared-link',
  'download',
  'delete',
];
export const TRASH_PRIMARY_BULK_ACTIONS: readonly BulkActionId[] = ['restore', 'download', 'delete-permanently'];
export const LOCKED_PRIMARY_BULK_ACTIONS: readonly BulkActionId[] = [
  'remove-from-locked',
  'download',
  'delete-permanently',
];
export const MENU_BULK_ACTION_GROUPS: readonly BulkActionGroupId[] = ['organize', 'visibility', 'album', 'jobs'];

/**
 * The bar's buttons. Favorite collapses to whichever direction applies so a selection that is
 * already favorited offers the removal in the same slot, exactly as the prototype does.
 */
export const primaryBulkActions = (actions: BulkAction[], trash: boolean, locked = false): BulkAction[] => {
  const byId = bulkActionById(actions);
  const order = trash ? TRASH_PRIMARY_BULK_ACTIONS : locked ? LOCKED_PRIMARY_BULK_ACTIONS : PRIMARY_BULK_ACTIONS;
  return order
    .map((id) =>
      id === 'favorite' && !byId.favorite?.available && byId.unfavorite?.available ? byId.unfavorite : byId[id],
    )
    .filter((action): action is BulkAction => !!action?.available);
};

export type BulkActionMenuGroup = BulkActionGroup & { items: BulkAction[] };

/** The More menu, grouped, without repeating anything already drawn as a button. */
export const menuBulkActions = (actions: BulkAction[], trash: boolean, locked = false): BulkActionMenuGroup[] => {
  const primary = new Set(primaryBulkActions(actions, trash, locked).map((action) => action.id));
  return bulkActionGroups
    .filter((group) => MENU_BULK_ACTION_GROUPS.includes(group.id))
    .map((group) => ({
      ...group,
      items: actions.filter((action) => action.group === group.id && action.available && !primary.has(action.id)),
    }))
    .filter((group) => group.items.length > 0);
};
