import {
  addAssetsToAlbum,
  BulkIdErrorReason,
  moveAlbumToCollection,
  removeUserFromAlbum,
  updateAlbumInfo,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { addAssetsToAlbums, handleEditAlbumDetails, handleLeaveAlbum, leftLocally } from '$lib/services/album.service';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';
import { albumFactory } from '@test-data/factories/album-factory';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  updateAlbumInfo: vi.fn(),
  moveAlbumToCollection: vi.fn(),
  removeUserFromAlbum: vi.fn(),
  addAssetsToAlbum: vi.fn(),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'me' }, params: {} } }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

describe('album addition notifications', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])(
    'keeps success and duplicate counts when every result is duplicated=%s',
    async (allDuplicates) => {
      const toast = vi.spyOn(toastManager, 'primary').mockImplementation(vi.fn());
      vi.mocked(addAssetsToAlbum).mockResolvedValue([
        { id: 'one', success: !allDuplicates, ...(allDuplicates && { error: BulkIdErrorReason.Duplicate }) },
        { id: 'two', success: false, error: BulkIdErrorReason.Duplicate },
      ]);
      const $t = await getFormatter();
      await expect(addAssetsToAlbums(['album'], ['one', 'two'], { notify: true })).resolves.toBe(true);
      const description = allDuplicates
        ? $t('assets_were_part_of_album_count', { values: { count: 2 } })
        : $t('assets_added_to_album_partial_count', { values: { successCount: 1, totalCount: 2 } });
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description }), { timeout: 5000 });
    },
  );
});

describe('handleEditAlbumDetails', () => {
  const album = albumFactory.build({ id: 'rockies', albumName: 'Rockies', parentId: null });
  const draft = { albumName: 'Rockies 2026', description: null, icon: 'mdiImageAlbum' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves the details and moves the album when the collection changed', async () => {
    const renamed = { ...album, albumName: 'Rockies 2026' };
    const moved = { ...renamed, parentId: 'family' };
    vi.mocked(updateAlbumInfo).mockResolvedValue(renamed);
    vi.mocked(moveAlbumToCollection).mockResolvedValue(moved);
    const emit = vi.spyOn(eventManager, 'emit');

    await expect(handleEditAlbumDetails(album, { ...draft, parentId: 'family' })).resolves.toEqual(moved);
    expect(emit).toHaveBeenCalledWith('AlbumUpdate', moved);
  });

  it('announces the saved rename and reports the move error when only the move fails', async () => {
    const renamed = { ...album, albumName: 'Rockies 2026' };
    vi.mocked(updateAlbumInfo).mockResolvedValue(renamed);
    vi.mocked(moveAlbumToCollection).mockRejectedValue(new Error('forbidden'));
    const emit = vi.spyOn(eventManager, 'emit');

    await expect(handleEditAlbumDetails(album, { ...draft, parentId: 'family' })).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledWith('AlbumUpdate', renamed);
    expect(handleError).toHaveBeenCalledTimes(1);
  });

  it('never moves when the dialog did not offer the collection field', async () => {
    vi.mocked(updateAlbumInfo).mockResolvedValue({ ...album, albumName: 'Rockies 2026' });

    await handleEditAlbumDetails(album, draft);
    expect(moveAlbumToCollection).not.toHaveBeenCalled();
  });
});

describe('handleLeaveAlbum (FL-53)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('remembers the album this tab left, so the removal it caused is not handled as being removed', async () => {
    vi.mocked(removeUserFromAlbum).mockResolvedValue(undefined as never);
    const album = albumFactory.build({ id: 'left-album' });

    expect(leftLocally('left-album')).toBe(false);
    await expect(handleLeaveAlbum(album)).resolves.toBe(true);
    expect(removeUserFromAlbum).toHaveBeenCalledWith({ id: 'left-album', userId: 'me' });
    expect(leftLocally('left-album')).toBe(true);
    // Only for a short while: a later removal is handled normally again.
    expect(leftLocally('left-album', Date.now() + 120_000)).toBe(false);
  });

  it('forgets a leave that failed', async () => {
    vi.mocked(removeUserFromAlbum).mockRejectedValue(new Error('offline'));
    const album = albumFactory.build({ id: 'stayed-album' });

    await expect(handleLeaveAlbum(album)).resolves.toBe(false);
    expect(leftLocally('stayed-album')).toBe(false);
  });
});

it.each([null, 'previous-parent'])(
  'edits collection membership against the parent shown in the dialog (%s)',
  async (parentId) => {
    vi.clearAllMocks();
    const album = albumFactory.build({ id: 'album', parentId });
    vi.mocked(updateAlbumInfo).mockResolvedValue(album);
    vi.mocked(moveAlbumToCollection).mockResolvedValue({ ...album, parentId: 'target' });
    await handleEditAlbumDetails(album, {
      albumName: 'Updated',
      description: null,
      icon: 'mdiImageAlbum',
      parentId: 'target',
    });
    expect(moveAlbumToCollection).toHaveBeenCalledWith({
      id: 'album',
      moveAlbumDto: { collectionId: 'target', expectedParentId: parentId },
    });
  },
);
