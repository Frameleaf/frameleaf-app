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

  it('lists the libraries on the server, checks one there and starts the import on the server', async () => {
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
    sdkMock.getEagleLibraries.mockResolvedValue({
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
