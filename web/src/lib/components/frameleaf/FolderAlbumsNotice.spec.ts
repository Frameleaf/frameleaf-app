import { FolderAlbumNaming, FolderAlbumShape } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FolderAlbumsNotice from '$lib/components/frameleaf/FolderAlbumsNotice.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import en from '../../../../../i18n/en.json';

const options = {
  shape: FolderAlbumShape.Every,
  level: 1,
  collectionsAbove: true,
  subfolders: {},
  skipEmpty: true,
  naming: FolderAlbumNaming.Folder,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  addMessages('dev', en);
  vi.spyOn(authManager, 'user', 'get').mockReturnValue({ isAdmin: true } as never);
  sdkMock.getFolderAlbumSuggestions.mockResolvedValue([
    { libraryId: 'library-1', name: 'Family photos', albums: 1852, empty: 651, suggestedAlbums: 841, options },
  ]);
  sdkMock.updateLibrary.mockResolvedValue({} as never);
});

describe('FolderAlbumsNotice (FL-1837)', () => {
  it('offers one album for each event, and Undo puts the rules back', async () => {
    const onChanged = vi.fn();
    render(FolderAlbumsNotice, { onChanged });

    expect(
      await screen.findByText('Family photos made 1,852 albums from its folders, and 651 are empty'),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_folder_albums_notice_events }));
    expect(sdkMock.updateLibrary).toHaveBeenCalledWith({
      id: 'library-1',
      updateLibraryDto: {
        folderAlbumOptions: expect.objectContaining({ shape: 'events' }),
        folderAlbumExisting: 'match',
      },
    });
    expect(onChanged).toHaveBeenCalled();

    await fireEvent.click(await screen.findByRole('button', { name: en.undo }));
    expect(sdkMock.updateLibrary).toHaveBeenLastCalledWith({
      id: 'library-1',
      updateLibraryDto: { folderAlbumOptions: options, folderAlbumExisting: 'match' },
    });
  });

  it('Not now hides the offer for that folder', async () => {
    render(FolderAlbumsNotice, {});
    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_folder_albums_notice_later }));
    expect(screen.queryByTestId('folder-albums-notice')).toBeNull();
    expect(localStorage.getItem('frameleaf.folderAlbumsNotice.library-1')).toBe('1');
  });

  it('is not offered to someone who cannot change folders', async () => {
    vi.spyOn(authManager, 'user', 'get').mockReturnValue({ isAdmin: false } as never);
    render(FolderAlbumsNotice, {});
    await Promise.resolve();
    expect(sdkMock.getFolderAlbumSuggestions).not.toHaveBeenCalled();
  });
});
