import { UserStatus } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AddFolderPage from '$lib/components/frameleaf/AddFolderPage.svelte';
import en from '../../../../../i18n/en.json';

const owners = [{ id: 'owner-1', name: 'Taylor', status: UserStatus.Active, deletedAt: null }] as never[];
const props = { owners, onAdded: vi.fn(), onCancel: vi.fn(), onOpenChecks: vi.fn() };
const listing = (folders: { name: string; path: string }[], nothingConnected = folders.length === 0) => ({
  path: '/mnt',
  parent: '/',
  folders,
  truncated: false,
  readable: true,
  nothingConnected,
  defaultExclusionPatterns: [],
});
const open = () => fireEvent.click(screen.getByRole('button', { name: en.frameleaf_libraries_choose_folder }));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('AddFolderPage folder list (FL-1495), in the shared folder chooser (FL-1814)', () => {
  it('explains Manager and links to it when a folder has nothing inside on a Manager install', async () => {
    sdkMock.getManagerAccess.mockResolvedValue({ url: 'http://nas:2284' } as never);
    sdkMock.browseLibraryFolders.mockResolvedValue(listing([]));
    render(AddFolderPage, props);
    await open();

    expect(await screen.findByText(en.frameleaf_libraries_browse_none_title)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.frameleaf_move_open_manager })).toHaveAttribute(
      'href',
      'http://nas:2284/#services',
    );
    expect(screen.queryByText(en.frameleaf_takeout_folder_none)).not.toBeInTheDocument();
  });

  it('says only connected folders are listed when there are some', async () => {
    sdkMock.getManagerAccess.mockResolvedValue({ url: 'http://nas:2284' } as never);
    sdkMock.browseLibraryFolders.mockResolvedValue(listing([{ name: 'user', path: '/mnt/user' }]));
    render(AddFolderPage, props);
    await open();

    expect(await screen.findByText(en.frameleaf_libraries_browse_connected_only)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_libraries_browse_none_title)).not.toBeInTheDocument();
  });

  it('keeps the plain empty line for a connected folder with no folders inside, empty or not', async () => {
    sdkMock.getManagerAccess.mockResolvedValue({ url: 'http://nas:2284' } as never);
    sdkMock.browseLibraryFolders.mockResolvedValue(listing([], false));
    render(AddFolderPage, props);
    await open();

    expect(await screen.findByText(en.frameleaf_takeout_folder_none)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_libraries_browse_none_title)).not.toBeInTheDocument();
  });

  it('looks again on coming back from Manager, so a folder connected there shows', async () => {
    sdkMock.getManagerAccess.mockResolvedValue({ url: 'http://nas:2284' } as never);
    sdkMock.browseLibraryFolders.mockResolvedValue(listing([]));
    render(AddFolderPage, props);
    await open();
    await screen.findByText(en.frameleaf_libraries_browse_none_title);

    sdkMock.browseLibraryFolders.mockResolvedValue(listing([{ name: 'user', path: '/mnt/user' }]));
    await fireEvent.focus(document.defaultView!);

    expect(await screen.findByRole('button', { name: 'user' })).toBeInTheDocument();
    expect(sdkMock.browseLibraryFolders).toHaveBeenCalledTimes(2);
  });

  it('keeps the plain empty line on an install without Manager', async () => {
    sdkMock.getManagerAccess.mockResolvedValue({ url: null } as never);
    sdkMock.browseLibraryFolders.mockResolvedValue(listing([]));
    render(AddFolderPage, props);
    await open();

    expect(await screen.findByText(en.frameleaf_takeout_folder_none)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_libraries_browse_none_title)).not.toBeInTheDocument();
  });
});

describe('AddFolderPage folder albums (FL-838)', () => {
  it('is off by default, and adds the folder with folder albums once switched on', async () => {
    sdkMock.getManagerAccess.mockResolvedValue({ url: null } as never);
    sdkMock.estimateLibraryFolder.mockResolvedValue({
      readable: true,
      found: true,
      count: 2,
      bytes: 10,
      complete: true,
      folders: [{ path: '/mnt/photos/trip', count: 2 }],
    });
    sdkMock.createLibrary.mockResolvedValue({ id: 'library-1' } as never);
    sdkMock.scanLibrary.mockResolvedValue(undefined as never);
    render(AddFolderPage, props);

    await fireEvent.input(screen.getByRole('textbox', { name: en.frameleaf_addfolder_path }), {
      target: { value: '/mnt/photos' },
    });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_addfolder_use_path }));
    const albums = screen.getByRole('switch', { name: en.frameleaf_folder_albums_switch });
    expect(albums).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(albums);
    expect(await screen.findByText(/Frameleaf will keep 1 album from/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_addfolder_add }));
    expect(sdkMock.createLibrary).toHaveBeenCalledWith({
      createLibraryDto: expect.objectContaining({ importPaths: ['/mnt/photos'], folderAlbums: true }),
    });
  });
});
