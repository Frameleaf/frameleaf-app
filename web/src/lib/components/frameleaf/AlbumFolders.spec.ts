import type { AlbumFolderDisplay, AlbumFolderVersions, AlbumFoldersResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AlbumFolderStrip from './AlbumFolderStrip.svelte';
import AlbumFoldersDialog from './AlbumFoldersDialog.svelte';

const albumId = '11111111-1111-4111-8111-111111111111';
const editsAlbumId = '22222222-2222-4222-8222-222222222222';

const folders = (overrides: Partial<AlbumFoldersResponseDto> = {}): AlbumFoldersResponseDto => ({
  libraryId: '33333333-3333-4333-8333-333333333333',
  libraryName: 'Family photos',
  folderPath: '/photos/2026-11-19 - Mimi and Popi Meet Nathan',
  canEdit: true,
  usesLibraryChoice: true,
  folders: [
    { name: 'Edits', photos: 40, videos: 0, display: 'album' as AlbumFolderDisplay },
    { name: 'Original', photos: 158, videos: 0, display: 'with' as AlbumFolderDisplay },
    { name: 'RAW', photos: 158, videos: 0, display: 'hidden' as AlbumFolderDisplay },
    { name: 'Video', photos: 0, videos: 6, display: 'section' as AlbumFolderDisplay },
  ],
  versions: 'one' as AlbumFolderVersions,
  prefer: ['Edits', 'Original', 'RAW'],
  matchedByName: 150,
  matchedByTime: 8,
  shownPhotos: 158,
  shownVideos: 6,
  sections: [],
  albums: [{ albumId: editsAlbumId, name: 'Edits', count: 40, coverAssetId: null }],
  versionsChanged: false,
  ...overrides,
});

/** FL-1838 (prototype `AlbumPageV2.jsx`): Folders in this album. */
describe('Folders in this album', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('narrows the album with a chip per folder shown, says what is hidden, ', async () => {
    const onSelect = vi.fn();
    const onOpenSettings = vi.fn();
    render(AlbumFolderStrip, { folders: folders(), onSelect, onOpenSettings });

    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    // Edits is an album inside and RAW is hidden: neither gets a chip
    expect(screen.queryByRole('button', { name: /^Edits/ })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /^Original/ }));
    expect(onSelect).toHaveBeenCalledWith('Original');
    await fireEvent.click(screen.getByRole('button', { name: /^Video/ }));
    expect(onSelect).toHaveBeenCalledWith('Video');

    await fireEvent.click(screen.getByRole('button', { name: 'RAW hidden' }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('saves each folder, the show-in-front order and the library choice', async () => {
    const onSaved = vi.fn();
    sdkMock.updateAlbumFolders.mockResolvedValue(folders());
    render(AlbumFoldersDialog, { albumId, folders: folders(), open: true, onSaved });

    expect(screen.getByText(/150 by file name/)).toBeInTheDocument();
    expect(screen.getByText(/8 by the moment they were taken/)).toBeInTheDocument();
    // bring Edits back in with the others
    const edits = screen.getByRole('group', { name: 'Show Edits' });
    await fireEvent.click(edits.querySelector('button')!);
    await fireEvent.click(screen.getByRole('button', { name: 'Move Original up' }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /Use these for every album from Family photos/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(sdkMock.updateAlbumFolders).toHaveBeenCalledWith({
      id: albumId,
      albumFoldersUpdateDto: {
        folders: { Edits: 'with', Original: 'with', RAW: 'hidden', Video: 'section' },
        versions: 'one',
        prefer: ['Original', 'Edits', 'RAW', 'Video'],
        applyToLibrary: true,
      },
    });
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
