import { LibraryScope, type AlbumResponseDto, type BookmarkResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import SaveLinkDialog from './SaveLinkDialog.svelte';

describe('SaveLinkDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getAllAlbums.mockResolvedValue([]);
    sdkMock.createBookmark.mockResolvedValue({ id: 'b1' } as BookmarkResponseDto);
    sdkMock.addBookmarksToAlbum.mockResolvedValue([]);
  });

  it('saves the address in Boards, titled by the site when no title is given, into the open collection', async () => {
    sdkMock.getAllAlbums.mockResolvedValue([{ id: 'c1', albumName: 'Packaging' } as AlbumResponseDto]);
    const onSaved = vi.fn();
    render(SaveLinkDialog, { open: true, url: 'https://example.com/board?x=1', albumId: 'c1', onSaved });

    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(sdkMock.createBookmark).toHaveBeenCalledWith({
      bookmarkCreateDto: {
        url: 'https://example.com/board?x=1',
        title: 'example.com',
        note: null,
        libraryScope: LibraryScope.Design,
      },
    });
    expect(sdkMock.addBookmarksToAlbum).toHaveBeenCalledWith({ id: 'c1', bookmarkIdsDto: { ids: ['b1'] } });
  });

  it('refuses an address that is not a web page', async () => {
    render(SaveLinkDialog, { open: true, url: 'javascript:alert(1)', onSaved: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('frameleaf_boards_save_link_invalid');
    expect(sdkMock.createBookmark).not.toHaveBeenCalled();
  });
});
