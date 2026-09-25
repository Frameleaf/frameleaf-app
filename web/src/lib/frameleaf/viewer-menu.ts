import type { Translations } from 'svelte-i18n';

/**
 * Frameleaf viewer "More" menu composition (FL-35).
 *
 * Ported from the approved template `design/frameleaf/template/src/media-viewer.mjs`
 * (`VIEWER_ACTIONS` / `viewerActionGroups`, lines 7-43 and 667-881) and the Viewer group that
 * `MediaViewer.jsx:1215-1282` appends. This module owns *only* the decision of which grouped
 * entries belong in the menu for a given asset and context, their labels and which ones open a
 * chooser. Every id maps to an action that already exists in the production web client, wired in
 * `$lib/components/frameleaf/ViewerMoreMenu.svelte`.
 *
 * Nothing here performs an action or talks to the server; it is pure so the hiding rules can be
 * tested without rendering the viewer.
 *
 * Differences from the template, all kept on purpose:
 * - `send-copy` ("Send a copy…", FL-54) sits in the Download group (September 24 port plan).
 * - `stack-remove-this` stays in the Stack group: FL-36 requires the contextual remove-member
 *   action, which the template does not draw (audit V-10, recorded deviation).
 * - The template disables Play slideshow for a single item; here it is left out, because FL-36
 *   requires unsupported actions to be absent rather than no-op controls. The same applies to the
 *   filmstrip toggle where the caller has no list of neighbours to show.
 * - The accept, rerun and clear enrichment actions stay in the information panel's Enrichment card
 *   (FL-36), where the score and review state they act on are visible, as the template draws them.
 * - The template's `lock`/`unlock` pair is one entry, `set-visibility-locked`, labelled Mark or
 *   Unmark Sensitive (FL-34).
 */

/** Every action the Frameleaf viewer menu can offer. Mirrors the prototype's `VIEWER_ACTIONS`. */
export const VIEWER_ACTIONS = [
  'download',
  'download-original',
  'send-copy',
  'copy-image',
  'restore',
  'delete-permanently',
  'add-to-album',
  'remove-from-album',
  'archive',
  'unarchive',
  'set-visibility-locked',
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
  'transcode',
  'tag-people',
  'cast',
  'toggle-filmstrip',
  'play-slideshow',
  'slideshow-settings',
] as const;

export type ViewerActionId = (typeof VIEWER_ACTIONS)[number];

export type ViewerMenuGroupId = 'download' | 'trash' | 'organize' | 'stack' | 'set-as' | 'navigate' | 'jobs' | 'viewer';

/** The template's two choosers (`ChooserDialog`, MediaViewer.jsx:2242-2292). */
export type ViewerChooserKind = 'album' | 'person';

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
  /** The current user may set that album's cover: its owner or an editor (`Permission.AlbumUpdate`). */
  canSetAlbumCover: boolean;
  /**
   * How many albums that hold this item the user may set the cover of. With no album context the
   * Album cover entry opens the album chooser over them (`chooser: "album"`, media-viewer.mjs:787-795).
   */
  albumCoverChoices: number;
  /** How many named, visible people are tagged in this item (the person chooser's rows). */
  peopleChoices: number;
  hasOriginalPath: boolean;
  hasCoordinates: boolean;
  hasCastDestination: boolean;
  smartSearchEnabled: boolean;
  foldersEnabled: boolean;
  /** The collection behind the viewer has more than one item. */
  canNavigateCollection: boolean;
  /** A filmstrip needs a real list of neighbours from the caller. */
  canShowFilmstrip: boolean;
  /** Whether the filmstrip is showing now, for the Show/Hide label. */
  filmstripShown: boolean;
  /** Whether a slideshow is playing now, for the Play/Pause label. */
  slideshowPlaying: boolean;
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
    canDownload,
    canSendCopy,
    canCopyImage,
    hasStack,
    stackSize,
    isStackPrimary,
    hasAlbumContext,
    canEditAlbum,
    canSetAlbumCover,
    albumCoverChoices,
    peopleChoices,
    hasOriginalPath,
    hasCoordinates,
    hasCastDestination,
    smartSearchEnabled,
    foldersEnabled,
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
    // media-viewer.mjs:692-712: Restore and the danger "Delete permanently", for whoever may change the item.
    groups.push({
      id: 'trash',
      labelKey: 'frameleaf_viewer_group_trash',
      items: compact([isOwner && !isLocked && 'restore', isOwner && 'delete-permanently']),
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
        ]),
      },
      {
        id: 'stack',
        labelKey: 'frameleaf_viewer_group_stack',
        items: compact([
          // media-viewer.mjs:752-757: Add to stack only for an item that is not stacked yet.
          isOwner && !hasStack && 'add-to-stack',
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
          isImage && !isLocked && ((hasAlbumContext && canSetAlbumCover) || albumCoverChoices > 0) && 'set-album-cover',
          isImage && isOwner && !isLocked && peopleChoices > 0 && 'set-person-featured',
          isImage && isOwner && !isLocked && 'set-profile-picture',
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
          isOwner && isVideo && 'transcode',
        ]),
      },
    );
  }

  // MediaViewer.jsx:1215-1282: Tag people, Cast, the filmstrip, the slideshow and its settings.
  const canPlay = !isLocked && canNavigateCollection;
  groups.push({
    id: 'viewer',
    labelKey: 'frameleaf_viewer_group_viewer',
    items: compact([
      isOwner && isImage && !isTrashed && 'tag-people',
      hasCastDestination && !isTrashed && 'cast',
      canShowFilmstrip && canNavigateCollection && 'toggle-filmstrip',
      canPlay && 'play-slideshow',
      canPlay && 'slideshow-settings',
    ]),
  });

  return groups.filter((group) => group.items.length > 0);
}

/** True when `id` survived the grouping rules — used to gate each rendered control. */
export const viewerMenuHas = (groups: ViewerMenuGroup[], id: ViewerActionId): boolean =>
  groups.some((group) => group.items.includes(id));

/**
 * Which chooser an entry opens instead of acting at once (media-viewer.mjs:787-800): the album cover
 * outside an album the user may edit, and the featured photo, which always picks a person.
 */
export function viewerMenuChooser(id: ViewerActionId, context: ViewerMenuContext): ViewerChooserKind | null {
  if (id === 'set-album-cover') {
    return context.hasAlbumContext && context.canSetAlbumCover ? null : 'album';
  }
  if (id === 'set-person-featured') {
    return 'person';
  }
  return null;
}

/**
 * The template's menu labels (media-viewer.mjs:683-872, MediaViewer.jsx:1219-1281). The shared
 * action titles elsewhere in the app keep their own wording; the viewer menu uses these.
 */
export function viewerMenuLabelKey(id: ViewerActionId, context: ViewerMenuContext): Translations {
  switch (id) {
    case 'download': {
      return 'download';
    }
    case 'download-original': {
      return 'download_original';
    }
    case 'send-copy': {
      return 'frameleaf_send_copy';
    }
    case 'copy-image': {
      return 'frameleaf_viewer_menu_copy_image';
    }
    case 'restore': {
      return 'restore';
    }
    case 'delete-permanently': {
      return 'frameleaf_viewer_delete_permanently';
    }
    case 'add-to-album': {
      return 'add_to_album';
    }
    case 'remove-from-album': {
      return 'remove_from_album';
    }
    case 'archive': {
      return 'to_archive';
    }
    case 'unarchive': {
      return 'unarchive';
    }
    case 'set-visibility-locked': {
      return context.isLocked ? 'frameleaf_bulk_unmark_sensitive' : 'frameleaf_bulk_mark_sensitive';
    }
    case 'add-to-stack': {
      return 'frameleaf_viewer_menu_add_to_stack';
    }
    case 'unstack': {
      return 'frameleaf_viewer_menu_unstack';
    }
    case 'stack-keep-this': {
      return 'frameleaf_viewer_menu_keep_this';
    }
    case 'stack-set-primary': {
      return 'frameleaf_viewer_menu_set_stack_primary';
    }
    case 'stack-remove-this': {
      return 'frameleaf_viewer_menu_remove_from_stack';
    }
    case 'set-album-cover': {
      return 'frameleaf_viewer_menu_album_cover';
    }
    case 'set-person-featured': {
      return 'frameleaf_viewer_menu_person_featured';
    }
    case 'set-profile-picture': {
      return 'frameleaf_viewer_menu_profile_picture';
    }
    case 'view-in-timeline': {
      return 'view_in_timeline';
    }
    case 'find-similar': {
      return 'frameleaf_viewer_menu_find_similar';
    }
    case 'view-on-map': {
      return 'frameleaf_viewer_view_on_map';
    }
    case 'open-folder': {
      return 'frameleaf_viewer_show_in_folder';
    }
    case 'refresh-faces': {
      return 'refresh_faces';
    }
    case 'refresh-metadata': {
      return 'refresh_metadata';
    }
    case 'refresh-thumbnails': {
      return 'refresh_thumbnails';
    }
    case 'refresh-encoded': {
      return 'frameleaf_viewer_menu_refresh_encoded';
    }
    case 'transcode': {
      return 'frameleaf_viewer_menu_transcode';
    }
    case 'tag-people': {
      return 'frameleaf_viewer_menu_tag_people';
    }
    case 'cast': {
      return 'cast';
    }
    case 'toggle-filmstrip': {
      return context.filmstripShown ? 'frameleaf_viewer_hide_filmstrip' : 'frameleaf_viewer_show_filmstrip';
    }
    case 'play-slideshow': {
      return context.slideshowPlaying ? 'frameleaf_viewer_pause_slideshow' : 'frameleaf_viewer_play_slideshow';
    }
    case 'slideshow-settings': {
      return 'frameleaf_viewer_slideshow_settings';
    }
  }
}
