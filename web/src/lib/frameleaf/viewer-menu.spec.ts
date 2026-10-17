import {
  VIEWER_ACTIONS,
  viewerMenuChooser,
  viewerMenuGroups,
  viewerMenuHas,
  viewerMenuLabelKey,
  type ViewerMenuContext,
} from '$lib/frameleaf/viewer-menu';

const baseContext = (overrides: Partial<ViewerMenuContext> = {}): ViewerMenuContext => ({
  isVideo: false,
  isImage: true,
  isOwner: true,
  isTrashed: false,
  isLocked: false,
  isArchived: false,
  isEdited: false,
  isSharedLink: false,
  canDownload: true,
  canSendCopy: false,
  canCopyImage: true,
  hasStack: false,
  stackSize: 0,
  isStackPrimary: false,
  hasAlbumContext: false,
  canEditAlbum: false,
  canSetAlbumCover: false,
  albumCoverChoices: 0,
  peopleChoices: 0,
  hasOriginalPath: true,
  hasCoordinates: false,
  hasCastDestination: false,
  smartSearchEnabled: true,
  foldersEnabled: true,
  canNavigateCollection: true,
  canShowFilmstrip: true,
  filmstripShown: false,
  slideshowPlaying: false,
  ...overrides,
});

const idsOf = (context: ViewerMenuContext) => viewerMenuGroups(context).flatMap((group) => group.items);

describe('viewerMenuGroups', () => {
  it('keeps the design order of the groups it renders', () => {
    const groups = viewerMenuGroups(
      baseContext({ hasStack: true, stackSize: 3, hasAlbumContext: true, canSetAlbumCover: true }),
    );
    expect(groups.map((group) => group.id)).toEqual([
      'download',
      'organize',
      'stack',
      'set-as',
      'navigate',
      'jobs',
      'viewer',
    ]);
  });

  it('only ever emits known action ids', () => {
    for (const id of idsOf(baseContext({ isVideo: true, isImage: false, hasStack: true, stackSize: 4 }))) {
      expect(VIEWER_ACTIONS).toContain(id);
    }
  });

  it('never renders an empty group', () => {
    for (const group of viewerMenuGroups(baseContext({ isOwner: false }))) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it('gives a shared-link viewer no menu at all', () => {
    expect(viewerMenuGroups(baseContext({ isSharedLink: true }))).toEqual([]);
  });

  describe('download group', () => {
    it('offers the original only for an edited asset', () => {
      expect(idsOf(baseContext({ isEdited: false }))).not.toContain('download-original');
      expect(idsOf(baseContext({ isEdited: true }))).toContain('download-original');
    });

    it('hides both downloads when the context forbids downloading', () => {
      const ids = idsOf(baseContext({ canDownload: false, isEdited: true }));
      expect(ids).not.toContain('download');
      expect(ids).not.toContain('download-original');
    });

    // FL-35 / FL-54: "Send a copy…" through the native share sheet, beside the downloads.
    it('offers Send a copy only where the browser can share files and the item may be downloaded', () => {
      expect(idsOf(baseContext())).not.toContain('send-copy');
      expect(idsOf(baseContext({ canSendCopy: true }))).toContain('send-copy');
      expect(idsOf(baseContext({ canSendCopy: true, canDownload: false }))).not.toContain('send-copy');
    });

    it('never offers Send a copy for a Locked or trashed item', () => {
      expect(idsOf(baseContext({ canSendCopy: true, isLocked: true }))).not.toContain('send-copy');
      expect(idsOf(baseContext({ canSendCopy: true, isTrashed: true }))).not.toContain('send-copy');
    });

    it('hides copy image for video and where the clipboard cannot take it', () => {
      expect(idsOf(baseContext({ isVideo: true, isImage: false }))).not.toContain('copy-image');
      expect(idsOf(baseContext({ canCopyImage: false }))).not.toContain('copy-image');
    });
  });

  describe('trash context', () => {
    const trashed = baseContext({ isTrashed: true, hasStack: true, stackSize: 3, hasAlbumContext: true });

    it('replaces Organize, Stack, Set as, Go to and Jobs with Trash', () => {
      expect(viewerMenuGroups(trashed).map((group) => group.id)).toEqual(['download', 'trash', 'viewer']);
    });

    it('offers restore and delete permanently and never the organizing actions (V-4)', () => {
      const ids = idsOf(trashed);
      expect(ids).toContain('restore');
      expect(ids).toContain('delete-permanently');
      expect(ids).not.toContain('add-to-album');
      expect(ids).not.toContain('archive');
      expect(ids).not.toContain('refresh-metadata');
    });

    it('does not offer restore for a locked asset', () => {
      expect(idsOf(baseContext({ isTrashed: true, isLocked: true }))).not.toContain('restore');
    });

    it("keeps someone else's trashed item out of the Trash group", () => {
      const groups = viewerMenuGroups(baseContext({ isTrashed: true, isOwner: false }));
      expect(groups.find((group) => group.id === 'trash')).toBeUndefined();
    });
  });

  describe('organize group', () => {
    it('toggles archive and unarchive on the current state', () => {
      expect(idsOf(baseContext({ isArchived: false }))).toContain('archive');
      expect(idsOf(baseContext({ isArchived: false }))).not.toContain('unarchive');
      expect(idsOf(baseContext({ isArchived: true }))).toContain('unarchive');
    });

    it('hides album membership, archive and sensitive marking for a non-owner', () => {
      const ids = idsOf(baseContext({ isOwner: false, hasAlbumContext: true, canEditAlbum: false }));
      expect(ids).not.toContain('remove-from-album');
      expect(ids).not.toContain('archive');
      expect(ids).not.toContain('set-visibility-locked');
    });

    it('offers one Locked entry, Mark or Unmark Sensitive, to the owner (FL-34)', () => {
      expect(idsOf(baseContext())).toContain('set-visibility-locked');
      expect(idsOf(baseContext({ isLocked: true }))).toContain('set-visibility-locked');
      expect(VIEWER_ACTIONS).not.toContain('mark-sensitive' as never);
    });

    it('keeps add to album but hides archive for a locked asset', () => {
      const ids = idsOf(baseContext({ isLocked: true }));
      expect(ids).toContain('add-to-album');
      expect(ids).not.toContain('archive');
    });

    it('leaves tagging to the information panel, as the template does (V-10)', () => {
      expect(VIEWER_ACTIONS).not.toContain('add-tag' as never);
    });

    it('only offers remove from album inside an album the user may edit', () => {
      expect(idsOf(baseContext({ hasAlbumContext: false }))).not.toContain('remove-from-album');
      expect(idsOf(baseContext({ hasAlbumContext: true, canEditAlbum: false }))).not.toContain('remove-from-album');
      expect(idsOf(baseContext({ hasAlbumContext: true, canEditAlbum: true }))).toContain('remove-from-album');
    });
  });

  describe('stack group', () => {
    it('offers only Add to stack when the asset is not stacked', () => {
      const groups = viewerMenuGroups(baseContext({ hasStack: false }));
      expect(groups.find((group) => group.id === 'stack')?.items).toEqual(['add-to-stack']);
    });

    it('offers Add to stack only to an item that is not stacked (media-viewer.mjs:752-757)', () => {
      expect(idsOf(baseContext({ hasStack: true, stackSize: 2 }))).not.toContain('add-to-stack');
    });

    it('offers keep-this and set-primary for a non-primary member', () => {
      const ids = idsOf(baseContext({ hasStack: true, stackSize: 2, isStackPrimary: false }));
      expect(ids).toContain('stack-keep-this');
      expect(ids).toContain('stack-set-primary');
      expect(ids).toContain('unstack');
    });

    it('hides set-primary on the primary member', () => {
      const ids = idsOf(baseContext({ hasStack: true, stackSize: 3, isStackPrimary: true }));
      expect(ids).not.toContain('stack-set-primary');
      expect(ids).not.toContain('stack-remove-this');
      expect(ids).toContain('stack-keep-this');
    });

    it('only removes one member while the stack would survive it', () => {
      expect(idsOf(baseContext({ hasStack: true, stackSize: 2 }))).not.toContain('stack-remove-this');
      expect(idsOf(baseContext({ hasStack: true, stackSize: 3 }))).toContain('stack-remove-this');
    });

    it('drops the whole group for a non-owner', () => {
      const groups = viewerMenuGroups(baseContext({ isOwner: false, hasStack: true, stackSize: 3 }));
      expect(groups.find((group) => group.id === 'stack')).toBeUndefined();
    });
  });

  describe('set as group', () => {
    it('is dropped entirely for video', () => {
      const groups = viewerMenuGroups(
        baseContext({
          isVideo: true,
          isImage: false,
          hasAlbumContext: true,
          canSetAlbumCover: true,
          peopleChoices: 2,
        }),
      );
      expect(groups.find((group) => group.id === 'set-as')).toBeUndefined();
    });

    it('offers the album cover inside an album whose cover the user may set, or over the albums that hold it', () => {
      expect(idsOf(baseContext({ hasAlbumContext: true, canSetAlbumCover: true }))).toContain('set-album-cover');
      expect(idsOf(baseContext({ hasAlbumContext: true, canSetAlbumCover: false }))).not.toContain('set-album-cover');
      expect(idsOf(baseContext({ albumCoverChoices: 0 }))).not.toContain('set-album-cover');
      expect(idsOf(baseContext({ albumCoverChoices: 2 }))).toContain('set-album-cover');
    });

    it('never offers a locked asset as the album cover (FL-53)', () => {
      expect(
        idsOf(baseContext({ hasAlbumContext: true, canSetAlbumCover: true, albumCoverChoices: 1, isLocked: true })),
      ).not.toContain('set-album-cover');
    });

    it('offers the featured photo when named people are tagged in it', () => {
      expect(idsOf(baseContext({ peopleChoices: 1 }))).toContain('set-person-featured');
      expect(idsOf(baseContext({ peopleChoices: 0 }))).not.toContain('set-person-featured');
      expect(idsOf(baseContext({ peopleChoices: 1, isOwner: false }))).not.toContain('set-person-featured');
    });

    it('never offers a locked asset as the featured photo (FL-53)', () => {
      expect(idsOf(baseContext({ peopleChoices: 1, isLocked: true }))).not.toContain('set-person-featured');
    });

    it('never offers a locked asset as the profile picture', () => {
      expect(idsOf(baseContext({ isLocked: true }))).not.toContain('set-profile-picture');
    });
  });

  describe('go to group', () => {
    it('hides the map without coordinates', () => {
      expect(idsOf(baseContext({ hasCoordinates: false }))).not.toContain('view-on-map');
      expect(idsOf(baseContext({ hasCoordinates: true }))).toContain('view-on-map');
    });

    it('hides the folder when folders are off or the path is unknown', () => {
      expect(idsOf(baseContext({ foldersEnabled: false }))).not.toContain('open-folder');
      expect(idsOf(baseContext({ hasOriginalPath: false }))).not.toContain('open-folder');
      expect(idsOf(baseContext())).toContain('open-folder');
    });

    it('hides find similar when smart search is disabled', () => {
      expect(idsOf(baseContext({ smartSearchEnabled: false }))).not.toContain('find-similar');
    });

    it('hides the timeline link for archived and locked assets', () => {
      expect(idsOf(baseContext({ isArchived: true }))).not.toContain('view-in-timeline');
      expect(idsOf(baseContext({ isLocked: true }))).not.toContain('view-in-timeline');
    });
  });

  describe('jobs group', () => {
    it('offers face refresh for stills and encoded-video refresh for video', () => {
      const still = idsOf(baseContext());
      expect(still).toContain('refresh-faces');
      expect(still).not.toContain('refresh-encoded');

      const video = idsOf(baseContext({ isVideo: true, isImage: false }));
      expect(video).toContain('refresh-encoded');
      expect(video).toContain('transcode');
      expect(still).not.toContain('transcode');
      expect(video).not.toContain('refresh-faces');
    });

    it('is dropped entirely for a non-owner', () => {
      const groups = viewerMenuGroups(baseContext({ isOwner: false }));
      expect(groups.find((group) => group.id === 'jobs')).toBeUndefined();
    });
  });

  describe('viewer group', () => {
    it('leaves the video source and panorama view to the footer, as the template does (V-10)', () => {
      expect(VIEWER_ACTIONS).not.toContain('play-original-video' as never);
      expect(VIEWER_ACTIONS).not.toContain('panorama-look-around' as never);
    });

    it('offers the slideshow and its settings (V-7)', () => {
      const ids = idsOf(baseContext());
      expect(ids).toContain('play-slideshow');
      expect(ids).toContain('slideshow-settings');
      expect(viewerMenuGroups(baseContext()).at(-1)?.items).toEqual([
        'tag-people',
        'toggle-filmstrip',
        'play-slideshow',
        'slideshow-settings',
      ]);
    });

    it('hides cast until a destination is available', () => {
      expect(idsOf(baseContext())).not.toContain('cast');
      expect(idsOf(baseContext({ hasCastDestination: true }))).toContain('cast');
      // the trash's top row has no Cast either
      expect(idsOf(baseContext({ hasCastDestination: true, isTrashed: true }))).not.toContain('cast');
    });

    it('hides the filmstrip and the slideshow for a single item', () => {
      const ids = idsOf(baseContext({ canNavigateCollection: false }));
      expect(ids).not.toContain('toggle-filmstrip');
      expect(ids).not.toContain('play-slideshow');
      expect(ids).not.toContain('slideshow-settings');
    });

    it('hides the filmstrip when the caller has no list to show', () => {
      expect(idsOf(baseContext({ canShowFilmstrip: false }))).not.toContain('toggle-filmstrip');
    });

    it('never offers a slideshow from a locked asset', () => {
      expect(idsOf(baseContext({ isLocked: true }))).not.toContain('play-slideshow');
    });
  });
});

describe('viewerMenuHas', () => {
  it('reports membership across all groups', () => {
    const groups = viewerMenuGroups(baseContext({ hasStack: true, stackSize: 3 }));
    expect(viewerMenuHas(groups, 'download')).toBe(true);
    expect(viewerMenuHas(groups, 'stack-keep-this')).toBe(true);
    expect(viewerMenuHas(groups, 'restore')).toBe(false);
  });
});

describe('viewerMenuChooser', () => {
  it('sets the cover of the album the viewer was opened in directly, and chooses otherwise (V-9)', () => {
    expect(viewerMenuChooser('set-album-cover', baseContext({ hasAlbumContext: true, canSetAlbumCover: true }))).toBe(
      null,
    );
    expect(viewerMenuChooser('set-album-cover', baseContext({ albumCoverChoices: 2 }))).toBe('album');
    expect(viewerMenuChooser('set-person-featured', baseContext({ peopleChoices: 1 }))).toBe('person');
    expect(viewerMenuChooser('download', baseContext())).toBe(null);
  });
});

describe('viewerMenuLabelKey', () => {
  it("uses the template's labels (V-11)", () => {
    const context = baseContext();
    expect(viewerMenuLabelKey('stack-keep-this', context)).toBe('frameleaf_viewer_menu_keep_this');
    expect(viewerMenuLabelKey('stack-set-primary', context)).toBe('frameleaf_viewer_menu_set_stack_primary');
    expect(viewerMenuLabelKey('find-similar', context)).toBe('frameleaf_viewer_menu_find_similar');
    expect(viewerMenuLabelKey('refresh-encoded', context)).toBe('frameleaf_viewer_menu_refresh_encoded');
    expect(viewerMenuLabelKey('delete-permanently', context)).toBe('frameleaf_viewer_delete_permanently');
  });

  it('follows the current state for the toggles', () => {
    expect(viewerMenuLabelKey('play-slideshow', baseContext({ slideshowPlaying: true }))).toBe(
      'frameleaf_viewer_pause_slideshow',
    );
    expect(viewerMenuLabelKey('toggle-filmstrip', baseContext({ filmstripShown: true }))).toBe(
      'frameleaf_viewer_hide_filmstrip',
    );
    expect(viewerMenuLabelKey('set-visibility-locked', baseContext({ isLocked: true }))).toBe(
      'frameleaf_bulk_unmark_sensitive',
    );
  });

  it('has a label for every action', () => {
    for (const id of VIEWER_ACTIONS) {
      expect(viewerMenuLabelKey(id, baseContext())).toMatch(/^[a-z_]+$/);
    }
  });
});
