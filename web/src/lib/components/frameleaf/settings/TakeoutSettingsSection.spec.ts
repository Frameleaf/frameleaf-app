import { TakeoutPhase, TakeoutState, type TakeoutResponseDto } from '@frameleaf/sdk';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import TakeoutSettingsSection from '$lib/components/frameleaf/settings/TakeoutSettingsSection.svelte';
import en from '../../../../../../i18n/en.json';

/**
 * FL-83: Command Center → Backup & import → "Google Photos & server imports". As in the prototype,
 * "Import from Google Photos…" opens the import flow in place, as a wide dialog;
 * the address says it is open (and on which import), so links and reloads land in it.
 */

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/user-settings?area=backup&section=takeout'),
  goto: vi.fn(),
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: state.goto }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', isAdmin: false }, params: {} },
}));

const at = (query: string) => (state.url = new URL(`http://localhost/user-settings?${query}`));

const takeout = (id: string, name: string) =>
  ({
    id,
    name,
    phase: TakeoutPhase.Sources,
    state: TakeoutState.Sources,
    action: null,
    albums: [],
    sources: [],
    options: { sidecarReview: true },
    counts: { imported: 0, matched: 0, items: 0, review: 0, ready: 0, failed: 0, importing: 0, hiddenLocked: 0 },
    updatedAt: '2026-09-20T10:00:00.000Z',
  }) as unknown as TakeoutResponseDto;

describe('TakeoutSettingsSection', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    at('area=backup&section=takeout');
    sdkMock.listTakeoutImports.mockResolvedValue([takeout('import-1', 'Family export')]);
  });

  it('opens the import workflow in place from the status answer when nothing was imported yet', async () => {
    sdkMock.listTakeoutImports.mockResolvedValue([]);
    render(TakeoutSettingsSection);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const status = await screen.findByRole('region', { name: en.frameleaf_takeout_settings_title });
    expect(within(status).getByRole('heading')).toHaveTextContent(en.frameleaf_takeout_page_none_title);
    await userEvent.click(within(status).getByRole('button', { name: en.frameleaf_takeout_settings_action }));
    expect(state.goto).toHaveBeenCalledWith(
      '/user-settings?area=backup&section=takeout&workflow=import',
      expect.objectContaining({ reset: false }),
    );
  });

  it('ACCOUNT-P6: lists the imports on the page with Open, and keeps the start dialog to the steps', async () => {
    render(TakeoutSettingsSection);
    expect(await screen.findByText('Family export')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: en.frameleaf_takeout_page_before })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Family export' }));
    expect(state.goto).toHaveBeenCalledWith(
      '/user-settings?area=backup&section=takeout&workflow=import&import=import-1',
      expect.objectContaining({ reset: false }),
    );

    at('area=backup&section=takeout&workflow=import');
    const { unmount } = render(TakeoutSettingsSection);
    const dialog = screen.getByRole('dialog', { name: en.frameleaf_takeout_title });
    expect(await within(dialog).findByText(en.frameleaf_takeout_all_files_title)).toBeInTheDocument();
    // no imports list or folder import in the start dialog any more
    expect(within(dialog).queryByRole('heading', { name: en.frameleaf_takeout_previous_heading })).toBeNull();
    expect(sdkMock.getTakeoutImport).not.toHaveBeenCalled();
    unmount();
  });

  const roots = [
    { id: 'imports', path: '/data/imports', builtIn: true, hostPath: '/mnt/user/appdata/frameleaf/imports' },
    { id: '0', path: '/mnt/exports', builtIn: false, hostPath: null },
  ];

  it('FL-1477: shows the built-in Imports folder, where it is on the computer, and the other allowed folders', async () => {
    sdkMock.getTakeoutRoots.mockResolvedValue({ roots });
    render(TakeoutSettingsSection, { showRoots: true });

    await userEvent.click(await screen.findByText(en.frameleaf_takeout_page_advanced));
    expect(await screen.findByText('/mnt/user/appdata/frameleaf/imports')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_takeout_imports_copy })).toBeInTheDocument();
    expect(screen.getByText('Also allowed: /mnt/exports.')).toBeInTheDocument();
  });

  it('FL-1477: the start dialog offers an export already on this server to an administrator', async () => {
    sdkMock.getTakeoutRoots.mockResolvedValue({ roots });
    sdkMock.getTakeoutFolders.mockResolvedValue({
      here: { zip: 0, tgz: 0, bytes: 0, unpacked: false },
      folders: [],
    } as never);
    at('area=backup&section=takeout&workflow=import');
    render(TakeoutSettingsSection, { showRoots: true });
    const start = screen.getByRole('dialog', { name: en.frameleaf_takeout_title });
    expect(await within(start).findByText(en.frameleaf_takeout_from_folder_title)).toBeInTheDocument();
    await userEvent.click(within(start).getByRole('button', { name: en.frameleaf_takeout_folder_choose }));

    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=backup&section=takeout', expect.anything());
    const chooser = screen.getByRole('dialog', { name: en.frameleaf_takeout_folder_chooser_title });
    await userEvent.click(
      within(chooser).getByRole('button', {
        name: `${en.frameleaf_takeout_imports_name} ${en.frameleaf_takeout_imports_built_in}`,
      }),
    );
    await userEvent.click(
      await within(chooser).findByRole('button', { name: en.frameleaf_takeout_folder_choose_this }),
    );
    // the chosen folder shows straight away: Advanced opens instead of staying collapsed
    expect(screen.getByLabelText(en.frameleaf_takeout_imports_name)).toBeVisible();
    const advanced = screen.getByText(en.frameleaf_takeout_page_advanced).closest('details')!;
    expect(advanced).toHaveAttribute('open');

    // closed by hand, then another folder is chosen: it opens again
    await userEvent.click(screen.getByText(en.frameleaf_takeout_page_advanced));
    await waitFor(() => expect(advanced).not.toHaveAttribute('open'));
    await userEvent.click(screen.getByRole('button', { name: en.change }));
    const again = screen.getByRole('dialog', { name: en.frameleaf_takeout_folder_chooser_title });
    await userEvent.click(
      within(again).getByRole('button', {
        name: `${en.frameleaf_takeout_imports_name} ${en.frameleaf_takeout_imports_built_in}`,
      }),
    );
    await userEvent.click(await within(again).findByRole('button', { name: en.frameleaf_takeout_folder_choose_this }));
    await waitFor(() => expect(advanced).toHaveAttribute('open'));
  });

  it('keeps the start dialog to uploading for everyone else', async () => {
    at('area=backup&section=takeout&workflow=import');
    render(TakeoutSettingsSection);
    const start = screen.getByRole('dialog', { name: en.frameleaf_takeout_title });
    expect(await within(start).findByText(en.frameleaf_takeout_all_files_title)).toBeInTheDocument();
    expect(within(start).queryByText(en.frameleaf_takeout_from_folder_title)).toBeNull();
    expect(sdkMock.getTakeoutRoots).not.toHaveBeenCalled();
  });

  it('lets an administrator choose a server folder in the chooser and import from it', async () => {
    const empty = { zip: 0, tgz: 0, bytes: 0, unpacked: false };
    sdkMock.getTakeoutRoots.mockResolvedValue({ roots });
    sdkMock.getTakeoutFolders.mockImplementation(
      ({ path }) =>
        Promise.resolve(
          path
            ? { here: { ...empty, tgz: 3 }, folders: [] }
            : {
                here: empty,
                folders: [
                  { name: 'Old phone', ...empty },
                  { name: 'Takeout 2024', ...empty, tgz: 3 },
                ],
              },
        ) as never,
    );
    sdkMock.createTakeoutImport.mockResolvedValue(takeout('import-2', 'Server export'));
    sdkMock.scanTakeoutImport.mockResolvedValue(takeout('import-2', 'Server export'));
    render(TakeoutSettingsSection, { showRoots: true });

    await userEvent.click(await screen.findByText(en.frameleaf_takeout_page_advanced));
    expect(screen.queryByRole('button', { name: en.frameleaf_takeout_import_folder })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: en.frameleaf_takeout_folder_choose }));
    const dialog = screen.getByRole('dialog', { name: en.frameleaf_takeout_folder_chooser_title });
    expect(within(dialog).getByRole('button', { name: en.frameleaf_takeout_folder_choose_this })).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole('button', {
        name: `${en.frameleaf_takeout_imports_name} ${en.frameleaf_takeout_imports_built_in}`,
      }),
    );
    expect(
      await within(dialog).findByRole('button', { name: `Old phone ${en.frameleaf_takeout_folder_no_export}` }),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /Takeout 2024/ }));
    await waitFor(() =>
      expect(sdkMock.getTakeoutFolders).toHaveBeenLastCalledWith({ rootId: 'imports', path: 'Takeout 2024' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: en.frameleaf_takeout_folder_choose_this }));

    expect(screen.getByLabelText('Imports, Takeout 2024')).toBeInTheDocument();
    expect(screen.getByText(/3 \.tgz files · .*\. Ready to check\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: en.frameleaf_takeout_import_folder }));
    await waitFor(() =>
      expect(sdkMock.createTakeoutImport).toHaveBeenCalledWith({
        takeoutCreateDto: expect.objectContaining({ rootId: 'imports', directory: 'Takeout 2024' }),
      }),
    );
    expect(sdkMock.scanTakeoutImport).toHaveBeenCalledWith({ id: 'import-2' });
  });

  it('opens one import from a deep link', async () => {
    sdkMock.getTakeoutImport.mockResolvedValue(takeout('import-1', 'Family export'));
    at('area=backup&section=takeout&workflow=import&import=import-1');
    render(TakeoutSettingsSection);
    const dialog = screen.getByRole('dialog', { name: en.frameleaf_takeout_title });
    expect(await within(dialog).findByText(en.frameleaf_takeout_archives_help)).toBeInTheDocument();
    expect(sdkMock.getTakeoutImport).toHaveBeenCalledWith({ id: 'import-1' });
  });

  it('says so when an import cannot be read, instead of offering a new one', async () => {
    sdkMock.getTakeoutImport.mockRejectedValue(new Error('offline'));
    at('area=backup&section=takeout&workflow=import&import=import-1');
    render(TakeoutSettingsSection);
    const dialog = screen.getByRole('dialog', { name: en.frameleaf_takeout_title });
    expect(await within(dialog).findByText(en.frameleaf_takeout_error_generic)).toBeInTheDocument();
    expect(within(dialog).queryByText(en.frameleaf_takeout_all_files_title)).toBeNull();
  });

  it('closes back to the section, keeping the rest of the address', async () => {
    at('area=backup&section=takeout&workflow=import&scope=all');
    render(TakeoutSettingsSection);
    const dialog = screen.getByRole('dialog', { name: en.frameleaf_takeout_title });
    await waitFor(() => expect(sdkMock.listTakeoutImports).toHaveBeenCalled());
    await userEvent.click(await within(dialog).findByRole('button', { name: en.frameleaf_takeout_cancel }));
    expect(state.goto).toHaveBeenCalledWith(
      '/user-settings?area=backup&section=takeout&scope=all',
      expect.objectContaining({ reset: false }),
    );
  });
});
