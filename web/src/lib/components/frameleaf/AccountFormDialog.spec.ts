import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AccountFormDialog from '$lib/components/frameleaf/AccountFormDialog.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { email: false, oauth: false, passwordLogin: true } },
}));

// Edit fixtures use a whole-GiB quota: jsdom treats the factory's 1000-byte quota (9.3e-7 GiB) as badInput.
const GiB = 1024 ** 3;
const field = (label: string) => screen.getByLabelText<HTMLInputElement>(label);
const type = (element: HTMLElement, value: string) => fireEvent.input(element, { target: { value } });

describe('AccountFormDialog (FL-76)', () => {
  const admin = userAdminFactory.build({ id: 'admin-id', name: 'Admin' });

  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setUser(admin);
  });

  it('sends the quota in whole bytes, including a fractional GiB', async () => {
    sdkMock.createUserAdmin.mockResolvedValue(userAdminFactory.build());
    renderWithTooltips(AccountFormDialog, { onClose: vi.fn() });

    await type(field('frameleaf_users_field_name'), 'Jamie');
    await type(field('frameleaf_users_field_email'), 'jamie@example.com');
    await type(field('frameleaf_users_field_password'), 'password');
    await type(field('frameleaf_users_field_password_confirm'), 'password');
    await type(field('frameleaf_users_field_quota'), '1.5');
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_users_create' }));

    await waitFor(() =>
      expect(sdkMock.createUserAdmin).toHaveBeenCalledWith({
        userAdminCreateDto: expect.objectContaining({ quotaSizeInBytes: Math.round(1.5 * GiB) }),
      }),
    );
  });

  it('refuses to overwrite an account that changed since the form opened', async () => {
    const jamie = userAdminFactory.build({
      id: 'jamie',
      name: 'Jamie',
      quotaSizeInBytes: 10 * GiB,
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    sdkMock.getUserAdmin.mockResolvedValue({
      ...jamie,
      quotaSizeInBytes: 20 * GiB,
      updatedAt: '2026-09-02T00:00:00.000Z',
    });
    renderWithTooltips(AccountFormDialog, { user: jamie, onClose: vi.fn() });

    await type(field('frameleaf_users_field_name'), 'Jamie Lee');
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_users_save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('frameleaf_users_edit_stale');
    expect(sdkMock.updateUserAdmin).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'frameleaf_users_save' })).toBeDisabled();
  });

  it('saves an edit when the account is unchanged', async () => {
    const jamie = userAdminFactory.build({
      id: 'jamie',
      name: 'Jamie',
      quotaSizeInBytes: 10 * GiB,
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    sdkMock.getUserAdmin.mockResolvedValue(jamie);
    sdkMock.updateUserAdmin.mockResolvedValue({ ...jamie, name: 'Jamie Lee' });
    renderWithTooltips(AccountFormDialog, { user: jamie, onClose: vi.fn() });

    await type(field('frameleaf_users_field_name'), 'Jamie Lee');
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_users_save' }));

    await waitFor(() =>
      expect(sdkMock.updateUserAdmin).toHaveBeenCalledWith({
        id: 'jamie',
        userAdminUpdateDto: expect.objectContaining({ name: 'Jamie Lee' }),
      }),
    );
  });

  it('saves when only the account timestamp moved (uploads and usage syncs)', async () => {
    const jamie = userAdminFactory.build({
      id: 'jamie',
      name: 'Jamie',
      quotaSizeInBytes: 10 * GiB,
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    sdkMock.getUserAdmin.mockResolvedValue({
      ...jamie,
      quotaUsageInBytes: 5 * GiB,
      updatedAt: '2026-09-02T00:00:00.000Z',
    });
    sdkMock.updateUserAdmin.mockResolvedValue({ ...jamie, name: 'Jamie Lee' });
    renderWithTooltips(AccountFormDialog, { user: jamie, onClose: vi.fn() });

    await type(field('frameleaf_users_field_name'), 'Jamie Lee');
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_users_save' }));

    await waitFor(() => expect(sdkMock.updateUserAdmin).toHaveBeenCalled());
  });

  it('refuses to save when the account cannot be re-read', async () => {
    const jamie = userAdminFactory.build({ id: 'jamie', name: 'Jamie', quotaSizeInBytes: 10 * GiB });
    sdkMock.getUserAdmin.mockRejectedValue(new Error('offline'));
    renderWithTooltips(AccountFormDialog, { user: jamie, onClose: vi.fn() });

    await type(field('frameleaf_users_field_name'), 'Jamie Lee');
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_users_save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('frameleaf_users_edit_check_failed');
    expect(sdkMock.updateUserAdmin).not.toHaveBeenCalled();
  });

  it('refuses a quota too large to store instead of saving it as unlimited', async () => {
    renderWithTooltips(AccountFormDialog, { onClose: vi.fn() });

    await type(field('frameleaf_users_field_name'), 'Jamie');
    await type(field('frameleaf_users_field_email'), 'jamie@example.com');
    await type(field('frameleaf_users_field_password'), 'password');
    await type(field('frameleaf_users_field_password_confirm'), 'password');
    await type(field('frameleaf_users_field_quota'), '100000000000');

    expect(await screen.findByRole('alert')).toHaveTextContent('frameleaf_users_quota_invalid');
    expect(screen.getByRole('button', { name: 'frameleaf_users_create' })).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_users_create' }));
    expect(sdkMock.createUserAdmin).not.toHaveBeenCalled();
  });

  it('never offers an administrator a change of their own role', () => {
    renderWithTooltips(AccountFormDialog, { user: admin, onClose: vi.fn() });
    expect(screen.getByLabelText('frameleaf_users_field_role')).toBeDisabled();
  });
});
