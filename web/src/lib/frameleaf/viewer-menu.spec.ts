import { VIEWER_ACTIONS, viewerMenuGroups, viewerMenuHas, type ViewerMenuContext } from '$lib/frameleaf/viewer-menu';

const baseContext = (overrides: Partial<ViewerMenuContext> = {}): ViewerMenuContext => ({
  isVideo: false,
  isImage: true,
  isOwner: true,
  isTrashed: false,
  isLocked: false,
  isArchived: false,
  isEdited: false,
  isPanorama: false,
  isLivePhoto: false,
  isSharedLink: false,
  canDownload: true,
  canCopyImage: true,
  hasStack: false,
  stackSize: 0,
  isStackPrimary: false,
  hasAlbumContext: false,
  canEditAlbum: false,
  hasPersonContext: false,
  hasOriginalPath: true,
  hasCoordinates: false,
  hasCastDestination: false,
  smartSearchEnabled: true,
  foldersEnabled: true,
  tagsEnabled: true,
  canNavigateCollection: true,
  canShowFilmstrip: true,
  ...overrides,
});

const idsOf = (context: ViewerMenuContext) => viewerMenuGroups(context).flatMap((group) => group.items);

describe('viewerMenuGroups', () => {
  it('keeps the design order of the groups it renders', () => {
    const groups = viewerMenuGroups(baseContext({ hasStack: true, stackSize: 3, hasAlbumContext: true }));
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

    it('offers restore and never the organizing actions', () => {
      const ids = idsOf(trashed);
      expect(ids).toContain('restore');
      expect(ids).not.toContain('add-to-album');
      expect(ids).not.toContain('archive');
      expect(ids).not.toContain('refresh-metadata');
    });

    it('does not offer restore for a locked asset', () => {
      expect(idsOf(baseContext({ isTrashed: true, isLocked: true }))).not.toContain('restore');
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
      expect(ids).not.toContain('mark-sensitive');
      expect(ids).not.toContain('set-visibility-locked');
    });

    it('hides add to album and archive for a locked asset', () => {
      const ids = idsOf(baseContext({ isLocked: true }));
      expect(ids).not.toContain('add-to-album');
      expect(ids).not.toContain('archive');
    });

    it('hides tagging when the tags preference is off', () => {
      expect(idsOf(baseContext({ tagsEnabled: false }))).not.toContain('add-tag');
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
        baseContext({ isVideo: true, isImage: false, hasAlbumContext: true, canEditAlbum: true, hasPersonContext: true }),
      );
      expect(groups.find((group) => group.id === 'set-as')).toBeUndefined();
    });

    it('offers the album cover only inside an editable album', () => {
      expect(idsOf(baseContext({ hasAlbumContext: true, canEditAlbum: true }))).toContain('set-album-cover');
      expect(idsOf(baseContext({ hasAlbumContext: true, canEditAlbum: false }))).not.toContain('set-album-cover');
    });

    it('offers the featured photo only from a person page', () => {
      expect(idsOf(baseContext({ hasPersonContext: true }))).toContain('set-person-featured');
      expect(idsOf(baseContext({ hasPersonContext: false }))).not.toContain('set-person-featured');
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
      expect(video).not.toContain('refresh-faces');
    });

    it('is dropped entirely for a non-owner', () => {
      const groups = viewerMenuGroups(baseContext({ isOwner: false }));
      expect(groups.find((group) => group.id === 'jobs')).toBeUndefined();
    });
  });

  describe('viewer group', () => {
    it('offers the video source switch only for video', () => {
      expect(idsOf(baseContext({ isVideo: true, isImage: false }))).toContain('play-original-video');
      expect(idsOf(baseContext())).not.toContain('play-original-video');
    });

    it('offers panorama look-around only for a panorama still', () => {
      expect(idsOf(baseContext({ isPanorama: true }))).toContain('panorama-look-around');
      expect(idsOf(baseContext({ isPanorama: true, isVideo: true, isImage: false }))).not.toContain(
        'panorama-look-around',
      );
    });

    it('hides cast until a destination is available', () => {
      expect(idsOf(baseContext())).not.toContain('cast');
      expect(idsOf(baseContext({ hasCastDestination: true }))).toContain('cast');
    });

    it('hides the filmstrip and the slideshow for a single item', () => {
      const ids = idsOf(baseContext({ canNavigateCollection: false }));
      expect(ids).not.toContain('toggle-filmstrip');
      expect(ids).not.toContain('play-slideshow');
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
