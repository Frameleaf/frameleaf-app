import { moveAlbumToCollection, removeUserFromAlbum, updateAlbumInfo } from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleEditAlbumDetails, handleLeaveAlbum, leftLocally } from '$lib/services/album.service';
import { handleError } from '$lib/utils/handle-error';
import { albumFactory } from '@test-data/factories/album-factory';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updateAlbumInfo: vi.fn(),
  moveAlbumToCollection: vi.fn(),
  removeUserFromAlbum: vi.fn(),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'me' }, params: {} } }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

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
