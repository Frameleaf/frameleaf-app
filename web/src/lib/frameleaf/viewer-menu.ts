import type { Translations } from 'svelte-i18n';

/**
 * Frameleaf viewer "More" menu composition (FL-35).
 *
 * Ported from the approved design template `design/frameleaf/template/src/media-viewer.mjs`
 * (`VIEWER_ACTIONS` / `viewerActionGroups`). This module owns *only* the decision of which
 * grouped entries belong in the menu for a given asset and context. Every id maps to an
 * action that already exists in the production web client — see `viewerActionSources` in
 * the accompanying spec and the wiring in
 * `$lib/components/frameleaf/ViewerMoreMenu.svelte`.
 *
 * Nothing here performs an action or talks to the server; it is pure so the hiding rules
 * can be tested without rendering the viewer.
 *
 * Extension points for the neighbouring stories: the prototype's `accept-description`,
 * `rerun-description` and `rerun-sensitive` ids are deliberately absent. They belong to the
 * information panel's enrichment card (FL-36) and to the people and face edits (FL-38),
 * which own `DetailPanelImageEnrichment.svelte` and `DetailPanelPeople.svelte`. When those
 * land, add their ids to `VIEWER_ACTIONS` and a group here only if the design puts them in
 * the More menu rather than in the panel.
 *
 * FL-36 has landed and adds no id: the design keeps accept, clear and rerun inside the
 * enrichment card, where the score and the review state they act on are visible.
 *
 * FL-34: Locked is one lock, so the menu has one entry for it, `set-visibility-locked`, labelled Mark
 * Sensitive or Unmark Sensitive as in the prototype (its `lock` and `unlock`). The separate
 * `mark-sensitive` and `unmark-sensitive` entries it used to carry wrote the same mark and are gone.
 */

/** Every action the Frameleaf viewer menu can offer. Mirrors the prototype's `VIEWER_ACTIONS`. */
export const VIEWER_ACTIONS = [
  'download',
  'download-original',
  'send-copy',
  'copy-image',
  'restore',
  'add-to-album',
  'remove-from-album',
  'archive',
  'unarchive',
  'set-visibility-locked',
  'add-tag',
  'add-to-stack',
  'unstack',
  'stack-keep-this',
  'stack-set-primary',
  'stack-remove-this',
  'set-album-cover',
  'set-person-featured',
  'set-profile-picture',
  'view-in-timeline',
  'find-similar',
  'view-on-map',
  'open-folder',
  'refresh-faces',
  'refresh-metadata',
  'refresh-thumbnails',
  'refresh-encoded',
  'play-slideshow',
  'toggle-filmstrip',
  'play-original-video',
  'panorama-look-around',
  'cast',
  'tag-people',
] as const;

export type ViewerActionId = (typeof VIEWER_ACTIONS)[number];

export type ViewerMenuGroupId = 'download' | 'trash' | 'organize' | 'stack' | 'set-as' | 'navigate' | 'jobs' | 'viewer';

export interface ViewerMenuGroup {
  id: ViewerMenuGroupId;
  /** i18n key for the group heading. */
  labelKey: Translations;
  items: ViewerActionId[];
}

/**
 * Everything the grouping rules need, derived from `AssetResponseDto`, the album/person
 * context the viewer was opened in, the signed-in user and the feature preferences.
 */
export interface ViewerMenuContext {
  isVideo: boolean;
  isImage: boolean;
  isOwner: boolean;
  isTrashed: boolean;
  isLocked: boolean;
  isArchived: boolean;
  isEdited: boolean;
  isPanorama: boolean;
  isLivePhoto: boolean;
  /** A shared-link viewer: no private actions at all. */
  isSharedLink: boolean;
  canDownload: boolean;
  /** The browser's share sheet takes files (FL-35 / FL-54 "Send a copy…"). */
  canSendCopy: boolean;
  canCopyImage: boolean;
  hasStack: boolean;
  stackSize: number;
  isStackPrimary: boolean;
  /** The viewer was opened inside an album, so album-scoped actions make sense. */
  hasAlbumContext: boolean;
  /** The current user may change that album (owner of the asset or of the album). */
  canEditAlbum: boolean;
  /** The viewer was opened from a person page. */
  hasPersonContext: boolean;
  hasOriginalPath: boolean;
  hasCoordinates: boolean;
  hasCastDestination: boolean;
  smartSearchEnabled: boolean;
  foldersEnabled: boolean;
  tagsEnabled: boolean;
  /** The collection behind the viewer has more than one item. */
  canNavigateCollection: boolean;
  /** A filmstrip needs a real list of neighbours from the caller. */
  canShowFilmstrip: boolean;
}

const compact = (items: (ViewerActionId | false | null | undefined)[]): ViewerActionId[] =>
  items.filter((item): item is ViewerActionId => typeof item === 'string');

/**
 * The complete grouped menu for one asset, in the order the design fixes:
 * Download, Organize (or Trash), Stack, Set as, Go to, Jobs, Viewer.
 *
 * Groups with no visible entry are dropped so no empty heading is ever rendered.
 */
export function viewerMenuGroups(context: ViewerMenuContext): ViewerMenuGroup[] {
  // A shared link is a public read-only surface: it gets no menu at all.
  if (context.isSharedLink) {
    return [];
  }

  const {
    isVideo,
    isImage,
    isOwner,
    isTrashed,
    isLocked,
    isArchived,
    isEdited,
    isPanorama,
    canDownload,
    canSendCopy,
    canCopyImage,
    hasStack,
    stackSize,
    isStackPrimary,
    hasAlbumContext,
    canEditAlbum,
    hasPersonContext,
    hasOriginalPath,
    hasCoordinates,
    hasCastDestination,
    smartSearchEnabled,
    foldersEnabled,
    tagsEnabled,
    canNavigateCollection,
    canShowFilmstrip,
  } = context;

  const groups: ViewerMenuGroup[] = [
    {
      id: 'download',
      labelKey: 'frameleaf_viewer_group_download',
      items: compact([
        canDownload && 'download',
        canDownload && isEdited && 'download-original',
        // A copy through the native share sheet; a Locked or trashed item is never sent.
        canDownload && canSendCopy && !isLocked && !isTrashed && 'send-copy',
        isImage && canCopyImage && 'copy-image',
      ]),
    },
  ];

  if (isTrashed) {
    // Permanent delete stays on the toolbar (DeleteAction), so it is not repeated here.
    groups.push({
      id: 'trash',
      labelKey: 'frameleaf_viewer_group_trash',
      items: compact([isOwner && !isLocked && 'restore']),
    });
  } else {
    groups.push(
      {
        id: 'organize',
        labelKey: 'frameleaf_viewer_group_organize',
        items: compact([
          // A Locked item is only ever shown to its owner in an unlocked session, who may put it in any
          // album (owner decision, September 22, 2026); the album hides it from everyone else.
          'add-to-album',
          hasAlbumContext && canEditAlbum && 'remove-from-album',
          isOwner && !isLocked && (isArchived ? 'unarchive' : 'archive'),
          // Mark or Unmark Sensitive (FL-34): the lock, metadata on the asset, which keeps its albums.
          isOwner && 'set-visibility-locked',
          tagsEnabled && 'add-tag',
        ]),
      },
      {
        id: 'stack',
        labelKey: 'frameleaf_viewer_group_stack',
        items: compact([
          isOwner && 'add-to-stack',
          isOwner && hasStack && 'unstack',
          isOwner && hasStack && 'stack-keep-this',
          isOwner && hasStack && !isStackPrimary && 'stack-set-primary',
          isOwner && hasStack && !isStackPrimary && stackSize > 2 && 'stack-remove-this',
        ]),
      },
      {
        id: 'set-as',
        labelKey: 'frameleaf_viewer_group_set_as',
        items: compact([
          // A Locked photo is never a cover or a featured face (owner decision, September 22, 2026).
          isImage && hasAlbumContext && canEditAlbum && !isLocked && 'set-album-cover',
          isImage && hasPersonContext && !isLocked && 'set-person-featured',
          isImage && !isLocked && 'set-profile-picture',
        ]),
      },
      {
        id: 'navigate',
        labelKey: 'frameleaf_viewer_group_go_to',
        items: compact([
          isOwner && !isLocked && !isArchived && 'view-in-timeline',
          !isLocked && !isArchived && smartSearchEnabled && 'find-similar',
          !isLocked && hasCoordinates && 'view-on-map',
          isOwner && foldersEnabled && hasOriginalPath && 'open-folder',
        ]),
      },
      {
        id: 'jobs',
        labelKey: 'frameleaf_viewer_group_jobs',
        items: compact([
          isOwner && isImage && 'refresh-faces',
          isOwner && 'refresh-metadata',
          isOwner && 'refresh-thumbnails',
          isOwner && isVideo && 'refresh-encoded',
        ]),
      },
    );
  }

  groups.push({
    id: 'viewer',
    labelKey: 'frameleaf_viewer_group_viewer',
    items: compact([
      isOwner && isImage && !isTrashed && 'tag-people',
      hasCastDestination && !isTrashed && 'cast',
      isVideo && 'play-original-video',
      isPanorama && isImage && 'panorama-look-around',
      canShowFilmstrip && canNavigateCollection && 'toggle-filmstrip',
      !isLocked && canNavigateCollection && 'play-slideshow',
    ]),
  });

  return groups.filter((group) => group.items.length > 0);
}

/** True when `id` survived the grouping rules — used to gate each rendered control. */
export const viewerMenuHas = (groups: ViewerMenuGroup[], id: ViewerActionId): boolean =>
  groups.some((group) => group.items.includes(id));
