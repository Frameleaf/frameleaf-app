import { LibraryScope, type AlbumResponseDto, type BookmarkResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { fileUploadHandler } from '$lib/utils/file-uploader';
import SaveLinkDialog from './SaveLinkDialog.svelte';

vi.mock('$lib/utils/file-uploader', () => ({ fileUploadHandler: vi.fn() }));

describe('SaveLinkDialog', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getAllAlbums.mockResolvedValue([]);
    sdkMock.createBookmark.mockResolvedValue({ id: 'b1' } as BookmarkResponseDto);
    sdkMock.addBookmarksToAlbum.mockResolvedValue([]);
    sdkMock.previewBookmark.mockRejectedValue(new Error('unreadable'));
  });

  it('fills the title from the page and saves its picture as the link preview', async () => {
    sdkMock.previewBookmark.mockResolvedValue({
      title: 'Spring moodboard',
      image: { contentType: 'image/png', data: btoa('png-bytes') },
    });
    vi.mocked(fileUploadHandler).mockResolvedValue(['picture-asset']);
    const onSaved = vi.fn();
    render(SaveLinkDialog, { open: true, url: 'https://example.com/board', onSaved });

    expect(await screen.findByRole('img', { name: 'frameleaf_boards_save_link_picture' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'frameleaf_bookmark_title' })).toHaveValue('Spring moodboard');
    const save = screen.getByRole('button', { name: 'save' });
    await waitFor(() => expect(save).toBeEnabled());
    await fireEvent.click(save);

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const [{ files, libraryScope }] = vi.mocked(fileUploadHandler).mock.calls[0];
    expect(libraryScope).toBe(LibraryScope.Design);
    expect(files[0].type).toBe('image/png');
    expect(sdkMock.createBookmark).toHaveBeenCalledWith({
      bookmarkCreateDto: expect.objectContaining({ title: 'Spring moodboard', previewAssetId: 'picture-asset' }),
    });
  });

  it('saves the address in Boards, titled by the site when no title is given, into the open collection', async () => {
    sdkMock.getAllAlbums.mockResolvedValue([{ id: 'c1', albumName: 'Packaging' } as AlbumResponseDto]);
    const onSaved = vi.fn();
    render(SaveLinkDialog, { open: true, url: 'https://example.com/board?x=1', albumId: 'c1', onSaved });

    const save = screen.getByRole('button', { name: 'save' });
    await waitFor(() => expect(save).toBeEnabled());
    await fireEvent.click(save);

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

  it('drops a filled-in title when the next address gives none', async () => {
    sdkMock.previewBookmark.mockResolvedValueOnce({ title: 'First page', image: null });
    render(SaveLinkDialog, { open: true, url: 'https://example.com/a', onSaved: vi.fn() });
    const field = screen.getByRole('textbox', { name: 'frameleaf_bookmark_title' });
    await waitFor(() => expect(field).toHaveValue('First page'));

    sdkMock.previewBookmark.mockResolvedValueOnce({ title: null, image: null });
    const address = screen.getByRole('textbox', { name: 'frameleaf_boards_save_link_address' });
    await fireEvent.input(address, { target: { value: 'https://example.com/b' } });
    await fireEvent.change(address);
    await waitFor(() => expect(field).toHaveValue(''));
  });

  it('waits for the page read before saving, so the link keeps its own title', async () => {
    let finish!: (value: { title: string | null; image: null }) => void;
    sdkMock.previewBookmark.mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);
    const onSaved = vi.fn();
    render(SaveLinkDialog, { open: true, url: 'https://example.com/slow', onSaved });
    const form = screen.getByRole('textbox', { name: 'frameleaf_boards_save_link_address' }).closest('form')!;

    await fireEvent.submit(form);
    expect(sdkMock.createBookmark).not.toHaveBeenCalled();
    finish({ title: 'Slow page', image: null });

    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(sdkMock.createBookmark).toHaveBeenCalledWith({
      bookmarkCreateDto: expect.objectContaining({ url: 'https://example.com/slow', title: 'Slow page' }),
    });
  });

  it('refuses an address that is not a web page', async () => {
    render(SaveLinkDialog, { open: true, url: 'javascript:alert(1)', onSaved: vi.fn() });
    const save = screen.getByRole('button', { name: 'save' });
    await waitFor(() => expect(save).toBeEnabled());
    await fireEvent.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent('frameleaf_boards_save_link_invalid');
    expect(sdkMock.createBookmark).not.toHaveBeenCalled();
  });
});
