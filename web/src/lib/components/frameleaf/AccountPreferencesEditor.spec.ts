import type { UserPreferencesResponseDto, UserPreferencesUpdateDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import AccountPreferencesEditor from '$lib/components/frameleaf/AccountPreferencesEditor.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import en from '../../../../../i18n/en.json';

vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn(), goto: vi.fn() }));

vi.mock('@immich/sdk', async (originalImport) => ({
  ...(await originalImport<typeof import('@immich/sdk')>()),
  isHttpError: (error: unknown) => typeof error === 'object' && error !== null && 'status' in error,
}));

vi.mock('$lib/utils/handle-error', () => ({
  getServerErrorMessage: (error: { data?: { message?: string } }) => error?.data?.message,
}));

const loaded = preferencesFactory.build({
  folders: { enabled: true, sidebarWeb: true },
  people: { enabled: true, sidebarWeb: false, minimumFaces: 3 },
  emailNotifications: { enabled: true, albumInvite: true, albumUpdate: true },
  download: { archiveSize: 1_234_567, includeEmbeddedVideos: false },
  revision: 'revision-1',
});

let save: ReturnType<typeof vi.fn<(update: UserPreferencesUpdateDto) => Promise<UserPreferencesResponseDto>>>;
let load: ReturnType<typeof vi.fn<() => Promise<UserPreferencesResponseDto>>>;

const renderEditor = (props: Partial<{ preferences: UserPreferencesResponseDto; editable: boolean }> = {}) =>
  render(AccountPreferencesEditor, { preferences: loaded, accountName: 'Grace Hopper', save, load, ...props });

const tab = (name: string) => screen.getByRole('button', { name });
const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const setChecked = (element: HTMLInputElement, checked: boolean) => fireEvent.change(element, { target: { checked } });
const saveButton = () => screen.getByRole('button', { name: en.frameleaf_account_prefs_save });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  save = vi.fn();
  load = vi.fn();
});

describe('AccountPreferencesEditor (FL-77)', () => {
  it('keeps one draft across the tabs and saves only the changes with the loaded revision', async () => {
    save.mockResolvedValue(preferencesFactory.build({ ...loaded, revision: 'revision-2' }));
    renderEditor();

    await setChecked(checkbox(en.frameleaf_account_prefs_feature_tags), true);
    await fireEvent.click(tab(en.frameleaf_account_prefs_tab_notifications));
    await setChecked(checkbox(en.frameleaf_account_prefs_email), false);
    await fireEvent.click(tab(en.frameleaf_account_prefs_tab_features));

    expect(checkbox(en.frameleaf_account_prefs_feature_tags).checked).toBe(true);
    expect(screen.getByText(en.frameleaf_account_prefs_status_dirty)).toBeInTheDocument();

    await fireEvent.click(saveButton());

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        tags: { enabled: true },
        emailNotifications: { enabled: false, albumInvite: false, albumUpdate: false },
        expectedRevision: 'revision-1',
      }),
    );
    await waitFor(() => expect(screen.getByText(en.frameleaf_account_prefs_notice_saved)).toBeInTheDocument());
  });

  it('keeps a navigation choice visible and unavailable while its feature is off', async () => {
    renderEditor();
    const navigation = () => checkbox('Show folders in library navigation');

    expect(navigation().checked).toBe(true);
    await setChecked(checkbox(en.frameleaf_account_prefs_feature_folders), false);

    expect(navigation().checked).toBe(true);
    expect(navigation().disabled).toBe(true);
  });

  it('shows the stale-save banner, keeps the draft, and loads the latest values on request', async () => {
    save.mockRejectedValue({ status: 409, data: { message: 'changed' } });
    load.mockResolvedValue(preferencesFactory.build({ ...loaded, ratings: { enabled: true }, revision: 'revision-3' }));
    renderEditor();

    await setChecked(checkbox(en.frameleaf_account_prefs_feature_tags), true);
    await fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText(en.frameleaf_account_prefs_conflict)).toBeInTheDocument());
    expect(checkbox(en.frameleaf_account_prefs_feature_tags).checked).toBe(true);

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_account_prefs_load_latest }));

    await waitFor(() => expect(screen.queryByText(en.frameleaf_account_prefs_conflict)).not.toBeInTheDocument());
    expect(load).toHaveBeenCalled();
    expect(checkbox(en.frameleaf_account_prefs_feature_tags).checked).toBe(false);
    expect(checkbox(en.frameleaf_account_prefs_feature_ratings).checked).toBe(true);
    expect(screen.getByText(en.frameleaf_account_prefs_notice_latest)).toBeInTheDocument();
  });

  it('keeps the draft and says so when a save fails', async () => {
    save.mockRejectedValue(new Error('offline'));
    renderEditor();

    await setChecked(checkbox(en.frameleaf_account_prefs_feature_ratings), true);
    await fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_account_prefs_error_save));
    expect(checkbox(en.frameleaf_account_prefs_feature_ratings).checked).toBe(true);
  });

  it('cancels back to the loaded values', async () => {
    renderEditor();

    await setChecked(checkbox(en.frameleaf_account_prefs_feature_tags), true);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_account_prefs_cancel }));

    expect(checkbox(en.frameleaf_account_prefs_feature_tags).checked).toBe(false);
    expect(screen.getByText(en.frameleaf_account_prefs_status_clean)).toBeInTheDocument();
  });

  it("turns casting off through the draft without sending the account's own casting choice", async () => {
    save.mockResolvedValue(
      preferencesFactory.build({ ...loaded, cast: { adminDisabled: true, gCastEnabled: false }, revision: 'r2' }),
    );
    renderEditor();

    await setChecked(checkbox(en.frameleaf_users_cast_allow), false);
    expect(checkbox(en.frameleaf_account_prefs_feature_cast).disabled).toBe(true);
    await fireEvent.click(saveButton());

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ cast: { adminDisabled: true }, expectedRevision: 'revision-1' }),
    );
  });

  it('turns album invitations and updates off with email and makes them unavailable', async () => {
    renderEditor();
    await fireEvent.click(tab(en.frameleaf_account_prefs_tab_notifications));

    await setChecked(checkbox(en.frameleaf_account_prefs_email), false);

    expect(checkbox(en.frameleaf_account_prefs_album_invites).checked).toBe(false);
    expect(checkbox(en.frameleaf_account_prefs_album_invites).disabled).toBe(true);
    expect(checkbox(en.frameleaf_account_prefs_album_updates).checked).toBe(false);
  });

  it('refuses a minimum faces value below 1 without calling the server', async () => {
    renderEditor();

    const minimumFaces = screen.getByRole('spinbutton', {
      name: new RegExp(`^${en.frameleaf_account_prefs_minimum_faces}`),
    });
    await fireEvent.input(minimumFaces, { target: { value: '0' } });
    await fireEvent.submit(screen.getByRole('form'));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_account_prefs_error_minimum_faces),
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('never shows or sends Locked choices, and cannot be changed for a deleted account', async () => {
    renderEditor({ editable: false });
    await fireEvent.click(tab(en.frameleaf_account_prefs_tab_preferences));

    expect(screen.getByText(en.frameleaf_account_prefs_locked_description)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_account_prefs_open_locked })).not.toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_account_prefs_status_restore)).toBeInTheDocument();
    expect(checkbox(en.frameleaf_account_prefs_motion_videos).closest('fieldset')?.disabled).toBe(true);
    expect(saveButton()).toBeDisabled();
  });
});
