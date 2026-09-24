import type { SessionResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { userAdminFactory } from '$lib/../test-data/factories/user-factory';
import AccountSecurityPanel from '$lib/components/frameleaf/AccountSecurityPanel.svelte';
import en from '../../../../../i18n/en.json';

/**
 * FL-76: the Security tab's device list used to be permanently read-only because no admin
 * session-revoke endpoint existed. These checks cover the wiring to the endpoint that now
 * exists (`deleteUserSessionAdmin`) rather than re-testing that endpoint's own authorization,
 * which is covered server-side in `user-admin.service.spec.ts`.
 */

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'admin-id' } } }));

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return { ...sdk, deleteUserSessionAdmin: vi.fn(), getUserPinCodeStateAdmin: vi.fn() };
});

vi.mock('@immich/ui', async () => {
  const actual = await vi.importActual<typeof import('@immich/ui')>('@immich/ui');
  return {
    ...actual,
    modalManager: { showDialog: vi.fn(), show: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn() },
  };
});

const user = userAdminFactory.build({ id: 'target-id', name: 'Grace Hopper' });

const session = (overrides: Partial<SessionResponseDto> = {}): SessionResponseDto => ({
  id: 'session-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  current: false,
  deviceType: 'Web',
  deviceOS: 'macOS',
  appVersion: null,
  isPendingSyncReset: false,
  ...overrides,
});

beforeEach(async () => {
  vi.clearAllMocks();
  addMessages('dev', en);
  const { deleteUserSessionAdmin, getUserPinCodeStateAdmin } = await import('@immich/sdk');
  vi.mocked(deleteUserSessionAdmin).mockResolvedValue(undefined as never);
  vi.mocked(getUserPinCodeStateAdmin).mockResolvedValue({ pinCode: false });
});

describe('AccountSecurityPanel (FL-76)', () => {
  it('revokes a device after confirmation, through the admin session endpoint', async () => {
    const { modalManager, toastManager } = await import('@immich/ui');
    const { deleteUserSessionAdmin } = await import('@immich/sdk');
    // CC-33: the Frameleaf ConfirmDialog, opened through modalManager.show, replaces showDialog.
    vi.mocked(modalManager.show).mockResolvedValue(true as never);

    render(AccountSecurityPanel, { user, sessions: [session()] });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_users_device_revoke }));

    await waitFor(() =>
      expect(deleteUserSessionAdmin).toHaveBeenCalledWith({ id: 'target-id', sessionId: 'session-1' }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: en.frameleaf_users_device_revoke })).toBeNull());
    expect(toastManager.primary).toHaveBeenCalledWith(en.frameleaf_users_device_revoked);
  });

  it('does nothing when the confirmation is declined', async () => {
    const { modalManager } = await import('@immich/ui');
    const { deleteUserSessionAdmin } = await import('@immich/sdk');
    vi.mocked(modalManager.show).mockResolvedValue(false as never);

    render(AccountSecurityPanel, { user, sessions: [session()] });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_users_device_revoke }));

    await waitFor(() =>
      expect(modalManager.show).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ title: en.frameleaf_users_device_revoke_title, danger: true }),
      ),
    );
    expect(deleteUserSessionAdmin).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: en.frameleaf_users_device_revoke })).toBeInTheDocument();
  });

  it('shows whether a sign-in provider is connected (CC-31)', () => {
    render(AccountSecurityPanel, { user: { ...user, oauthId: 'oidc|123' }, sessions: [] });

    expect(screen.getByText(en.frameleaf_users_provider_title)).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(String.raw`^\s*${en.frameleaf_users_provider_connected} ·`)),
    ).toBeInTheDocument();
  });

  it('never offers to revoke the current device, and never asks the endpoint to', () => {
    render(AccountSecurityPanel, { user, sessions: [session({ id: 'session-current', current: true })] });

    expect(screen.getByText(en.frameleaf_users_device_current)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_users_device_revoke })).toBeNull();
  });

  describe('Locked folder PIN (CC-30, AccountsLibraries.jsx 1403-1435)', () => {
    it('offers Set PIN and no Reset PIN while the account has none', async () => {
      const { getUserPinCodeStateAdmin } = await import('@immich/sdk');
      render(AccountSecurityPanel, { user, sessions: [] });

      expect(await screen.findByText(en.frameleaf_users_pin_not_set)).toBeInTheDocument();
      expect(getUserPinCodeStateAdmin).toHaveBeenCalledWith({ id: 'target-id' });
      expect(screen.getByRole('button', { name: en.frameleaf_users_pin_set })).toBeEnabled();
      expect(screen.getByRole('button', { name: en.frameleaf_users_pin_reset })).toBeDisabled();
    });

    it('offers Change PIN and Reset PIN once a PIN is set, and rereads the state after either', async () => {
      const { modalManager } = await import('@immich/ui');
      const { getUserPinCodeStateAdmin } = await import('@immich/sdk');
      vi.mocked(getUserPinCodeStateAdmin).mockResolvedValue({ pinCode: true });
      vi.mocked(modalManager.show).mockResolvedValue(undefined as never);
      render(AccountSecurityPanel, { user, sessions: [] });

      expect(await screen.findByText(en.frameleaf_users_pin_is_set)).toBeInTheDocument();
      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_users_pin_reset }));

      expect(modalManager.show).toHaveBeenCalledWith(expect.anything(), { user, mode: 'clear', hasPin: true });
      await waitFor(() => expect(getUserPinCodeStateAdmin).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('button', { name: en.frameleaf_users_pin_change })).toBeEnabled();
    });

    it('keeps both actions when the state cannot be read', async () => {
      const { getUserPinCodeStateAdmin } = await import('@immich/sdk');
      vi.mocked(getUserPinCodeStateAdmin).mockRejectedValue(new Error('offline'));
      render(AccountSecurityPanel, { user, sessions: [] });

      await waitFor(() => expect(getUserPinCodeStateAdmin).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: en.frameleaf_users_pin_set })).toBeEnabled();
      expect(screen.getByRole('button', { name: en.frameleaf_users_pin_reset })).toBeEnabled();
      expect(screen.queryByText(en.frameleaf_users_pin_is_set)).toBeNull();
      expect(screen.queryByText(en.frameleaf_users_pin_not_set)).toBeNull();
    });
  });
});
