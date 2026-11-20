import { EagleImportStatus, EagleImportTargetMode } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages, init, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eagleImportUi } from '$lib/frameleaf/eagle/eagle-import-status.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../../i18n/en.json';
import BoardsEagleImportDialog from './BoardsEagleImportDialog.svelte';

const library = {
  name: 'Studio References.library',
  folders: [{ id: 'F1', name: 'Web', parentId: null }],
  smartFolders: [],
  tagGroups: [],
  items: [
    {
      id: 'I1',
      name: 'hero',
      ext: 'jpg',
      size: 10,
      width: 1,
      height: 1,
      url: 'https://example.com/a',
      annotation: '',
      tags: [],
      folders: ['F1'],
      star: 0,
      isDeleted: false,
      modificationTime: 1_789_000_000_000,
      comments: [],
      present: true,
      unreadable: false,
    },
  ],
  fingerprint: 'eagle:id:L1',
  supported: ['jpg'],
  earlierImport: null,
};

describe('Import from Eagle: a library in a folder the server can open', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    addMessages('en-US', en);
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
  });
  beforeEach(() => {
    vi.resetAllMocks();
    eagleImportUi.open = true;
    eagleImportUi.run = undefined;
    sdkMock.getEagleImports.mockResolvedValue({ imports: [] });
    sdkMock.getAllAlbums.mockResolvedValue([]);
    authManager.setPreferences(preferencesFactory.build());
  });

  it('is only offered to an administrator', () => {
    authManager.setUser(userAdminFactory.build({ isAdmin: false }));
    render(BoardsEagleImportDialog);
    expect(screen.getByRole('radio', { name: /In a folder your server can open/ })).toBeDisabled();
    expect(screen.getByText('Only an administrator can import from a folder on the server.')).toBeInTheDocument();
  });

  it('says so when this server can’t import from its folders, and leaves the import from this computer as it is', async () => {
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
    sdkMock.getEagleLibraries.mockResolvedValue({ available: false, roots: 1, libraries: [] });
    render(BoardsEagleImportDialog);
    await fireEvent.click(screen.getByRole('radio', { name: /In a folder your server can open/ }));
    expect(await screen.findByText(/isn’t available on this server/)).toBeInTheDocument();
    expect(sdkMock.checkEagleLibrary).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('radio', { name: /On this computer/ }));
    expect(screen.getByRole('button', { name: /Choose the library folder/ })).toBeEnabled();
  });

  it('lets an administrator browse the server for a library the list didn’t find', async () => {
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
    sdkMock.getEagleLibraries.mockResolvedValue({ available: true, roots: 1, libraries: [] });
    sdkMock.getTakeoutRoots.mockResolvedValue({
      roots: [{ id: 'imports', path: '/data/imports', builtIn: true, hostPath: null }],
    });
    const none = { zip: 0, tgz: 0, bytes: 0, unpacked: false };
    sdkMock.getTakeoutFolders.mockImplementation(({ path }) =>
      Promise.resolve({ here: none, folders: path ? [] : [{ name: 'Refs.library', ...none }] }),
    );
    sdkMock.checkEagleLibrary.mockResolvedValue(library);
    render(BoardsEagleImportDialog);

    await fireEvent.click(screen.getByRole('radio', { name: /In a folder your server can open/ }));
    expect(await screen.findByText(/No Eagle library was found/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Choose the library folder…' }));
    await fireEvent.click(await screen.findByRole('button', { name: /Imports/ }));
    // A folder that isn't a library can be opened, not chosen.
    expect(await screen.findByRole('button', { name: 'Choose this folder' })).toBeDisabled();
    await fireEvent.click(await screen.findByRole('button', { name: /Refs\.library/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose this folder' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Choose this folder' }));
    await waitFor(() =>
      expect(sdkMock.checkEagleLibrary).toHaveBeenCalledWith(
        { eagleLibraryCheckDto: { rootId: 'imports', path: 'Refs.library' } },
        { signal: undefined },
      ),
    );
  });

  it('chooses an import folder that is itself the library', async () => {
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
    sdkMock.getEagleLibraries.mockResolvedValue({ available: true, roots: 2, libraries: [] });
    sdkMock.getTakeoutRoots.mockResolvedValue({
      roots: [{ id: '0', path: '/mnt/design/Refs.library/', builtIn: false, hostPath: null }],
    });
    sdkMock.getTakeoutFolders.mockResolvedValue({ here: { zip: 0, tgz: 0, bytes: 0, unpacked: false }, folders: [] });
    sdkMock.checkEagleLibrary.mockResolvedValue(library);
    render(BoardsEagleImportDialog);

    await fireEvent.click(screen.getByRole('radio', { name: /In a folder your server can open/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Choose the library folder…' }));
    await fireEvent.click(await screen.findByRole('button', { name: /Refs\.library/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose this folder' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Choose this folder' }));
    await waitFor(() =>
      expect(sdkMock.checkEagleLibrary).toHaveBeenCalledWith(
        { eagleLibraryCheckDto: { rootId: '0', path: '.' } },
        { signal: undefined },
      ),
    );
  });

  it('doesn’t open the server’s folders after where the library is was changed', async () => {
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
    sdkMock.getEagleLibraries.mockResolvedValue({ available: true, roots: 1, libraries: [] });
    let answer: (value: { roots: [] }) => void = () => {};
    sdkMock.getTakeoutRoots.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(BoardsEagleImportDialog);

    await fireEvent.click(screen.getByRole('radio', { name: /In a folder your server can open/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Choose the library folder…' }));
    await fireEvent.click(screen.getByRole('radio', { name: /On this computer/ }));
    // Back to the server before the answer: the earlier browse is still dropped.
    await fireEvent.click(screen.getByRole('radio', { name: /In a folder your server can open/ }));
    answer({ roots: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Choose the folder to import from')).not.toBeInTheDocument();
  });

  it('lists the libraries on the server, checks one there and starts the import on the server', async () => {
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
    sdkMock.getEagleLibraries.mockResolvedValue({
      available: true,
      roots: 1,
      libraries: [{ rootId: '0', path: 'Design/Eagle/Studio References.library', name: 'Studio References.library' }],
    });
    sdkMock.checkEagleLibrary.mockResolvedValue(library);
    sdkMock.createEagleImport.mockResolvedValue({
      id: 'import-1',
      rootId: '0',
      path: 'Design/Eagle/Studio References.library',
      libraryName: 'Studio References.library',
      fingerprint: 'eagle:id:L1',
      status: EagleImportStatus.Running,
      targetMode: EagleImportTargetMode.Inside,
      insideAlbumId: null,
      rootAlbumId: null,
      total: 1,
      done: 0,
      already: 0,
      collections: 0,
      failed: [],
      recent: [],
      error: null,
      createdAt: '2026-10-29T10:00:00.000Z',
      updatedAt: '2026-10-29T10:00:00.000Z',
    });
    render(BoardsEagleImportDialog);

    await fireEvent.click(screen.getByRole('radio', { name: /In a folder your server can open/ }));
    await waitFor(() => expect(sdkMock.getEagleLibraries).toHaveBeenCalled());
    const entry = await screen.findByRole('button', { name: /Studio References\.library/ });
    expect(entry).toHaveTextContent('Design › Eagle');
    await fireEvent.click(entry);
    await waitFor(() =>
      expect(sdkMock.checkEagleLibrary).toHaveBeenCalledWith(
        { eagleLibraryCheckDto: { rootId: '0', path: 'Design/Eagle/Studio References.library' } },
        { signal: undefined },
      ),
    );
    await fireEvent.click(await screen.findByRole('button', { name: 'Check this library' }));
    expect(
      await screen.findByText(/Files already in your library are recognised as your server reads them/),
    ).toBeInTheDocument();
    // No file is read in this browser: nothing is hashed or checked against the library here.
    expect(sdkMock.checkBulkUpload).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const importButton = await screen.findByRole('button', { name: /Import 1/ });
    // A double click starts it once: the button waits while the server starts it.
    await fireEvent.click(importButton);
    await fireEvent.click(importButton);
    await waitFor(() => expect(sdkMock.createEagleImport).toHaveBeenCalled());
    expect(sdkMock.createEagleImport).toHaveBeenCalledTimes(1);
    expect(sdkMock.createEagleImport.mock.calls[0][0].eagleImportCreateDto).toMatchObject({
      rootId: '0',
      path: 'Design/Eagle/Studio References.library',
      fingerprint: 'eagle:id:L1',
      targetMode: EagleImportTargetMode.Inside,
    });
    expect(await screen.findByText(/The import carries on on your server/)).toBeInTheDocument();
    expect(screen.getByText(/Reading files/)).toBeInTheDocument();
  });
});
