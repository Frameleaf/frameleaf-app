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

describe('AddFolderPage folder list (FL-1495)', () => {
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
    expect(screen.queryByText(en.frameleaf_libraries_browse_empty)).not.toBeInTheDocument();
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

    expect(await screen.findByText(en.frameleaf_libraries_browse_empty)).toBeInTheDocument();
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
    expect(sdkMock.browseLibraryFolders).toHaveBeenLastCalledWith({ path: '/mnt' });
  });

  it('keeps the plain empty line on an install without Manager', async () => {
    sdkMock.getManagerAccess.mockResolvedValue({ url: null } as never);
    sdkMock.browseLibraryFolders.mockResolvedValue(listing([]));
    render(AddFolderPage, props);
    await open();

    expect(await screen.findByText(en.frameleaf_libraries_browse_empty)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_libraries_browse_none_title)).not.toBeInTheDocument();
  });
});
