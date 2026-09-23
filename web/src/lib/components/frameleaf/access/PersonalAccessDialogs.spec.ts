import { Permission } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ApiKeyDialog from '$lib/components/frameleaf/access/ApiKeyDialog.svelte';
import PasswordDialog from '$lib/components/frameleaf/access/PasswordDialog.svelte';
import PinDialog from '$lib/components/frameleaf/access/PinDialog.svelte';
import SupporterKeyDialog from '$lib/components/frameleaf/access/SupporterKeyDialog.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { getActivationKey } from '$lib/utils/license-utils';

vi.mock('$lib/utils/license-utils', () => ({
  getActivationKey: vi.fn(),
}));

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { passwordLogin: true } },
}));

const pinInput = (label: string) => screen.getByLabelText<HTMLInputElement>(label);
const typeInto = (element: HTMLElement, value: string) => fireEvent.input(element, { target: { value } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getActivationKey).mockResolvedValue('activation-key');
});

describe('PasswordDialog (FL-67)', () => {
  it('changes the password and signs out other devices by default', async () => {
    sdkMock.changePassword.mockResolvedValue({} as never);
    const onClose = vi.fn();
    render(PasswordDialog, { onClose });

    await typeInto(pinInput('frameleaf_access_password_current'), 'old-password');
    await typeInto(pinInput('frameleaf_access_password_new'), 'new-password');
    await typeInto(pinInput('frameleaf_access_password_confirm'), 'new-password');
    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_access_password_change' }).at(-1)!);

    await waitFor(() =>
      expect(sdkMock.changePassword).toHaveBeenCalledWith({
        changePasswordDto: { password: 'old-password', newPassword: 'new-password', invalidateSessions: true },
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledWith({ signedOutOthers: true }));
  });

  it('clears every field after the server refuses the current password', async () => {
    sdkMock.changePassword.mockRejectedValue(new Error('Wrong password'));
    render(PasswordDialog, { onClose: vi.fn() });

    await typeInto(pinInput('frameleaf_access_password_current'), 'wrong-password');
    await typeInto(pinInput('frameleaf_access_password_new'), 'new-password');
    await typeInto(pinInput('frameleaf_access_password_confirm'), 'new-password');
    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_access_password_change' }).at(-1)!);

    expect(await screen.findByText('frameleaf_access_password_failed')).toBeInTheDocument();
    expect(pinInput('frameleaf_access_password_current').value).toBe('');
    expect(pinInput('frameleaf_access_password_new').value).toBe('');
  });
});

describe('PinDialog (FL-67)', () => {
  it('creates a PIN and tells the page', async () => {
    sdkMock.setupPinCode.mockResolvedValue(undefined as never);
    const emit = vi.spyOn(eventManager, 'emit');
    render(PinDialog, { mode: 'create', onClose: vi.fn() });

    await typeInto(pinInput('frameleaf_access_pin_new'), '123456');
    await typeInto(pinInput('frameleaf_access_pin_confirm'), '123456');
    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_access_pin_create' }).at(-1)!);

    await waitFor(() => expect(sdkMock.setupPinCode).toHaveBeenCalledWith({ pinCodeSetupDto: { pinCode: '123456' } }));
    expect(emit).toHaveBeenCalledWith('UserPinCodeCreated');
  });

  it('clears a forgotten PIN with the account password', async () => {
    sdkMock.resetPinCode.mockResolvedValue(undefined as never);
    render(PinDialog, { mode: 'reset', onClose: vi.fn() });

    await typeInto(pinInput('frameleaf_access_pin_account_password'), 'account-password');
    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_access_pin_reset' }).at(-1)!);

    await waitFor(() =>
      expect(sdkMock.resetPinCode).toHaveBeenCalledWith({ pinCodeResetDto: { password: 'account-password' } }),
    );
  });

  it('clears a rejected current PIN at once', async () => {
    sdkMock.changePinCode.mockRejectedValue(new Error('Wrong PIN code'));
    render(PinDialog, { mode: 'change', onClose: vi.fn() });

    await typeInto(pinInput('frameleaf_access_pin_current'), '111111');
    await typeInto(pinInput('frameleaf_access_pin_new'), '123456');
    await typeInto(pinInput('frameleaf_access_pin_confirm'), '123456');
    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_access_pin_change' }).at(-1)!);

    expect(await screen.findByText('frameleaf_access_pin_failed')).toBeInTheDocument();
    expect(pinInput('frameleaf_access_pin_current').value).toBe('');
  });
});

describe('ApiKeyDialog (FL-67)', () => {
  it('creates a key with the chosen permissions and shows its value once', async () => {
    sdkMock.createApiKey.mockResolvedValue({
      apiKey: { id: 'key-1', name: 'Importer', permissions: [Permission.AssetRead] },
      secret: 'shown-once',
    } as never);
    render(ApiKeyDialog, { onClose: vi.fn() });

    await typeInto(screen.getByLabelText('frameleaf_access_key_name'), 'Importer');
    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_access_key_create' }).at(-1)!);

    await waitFor(() =>
      expect(sdkMock.createApiKey).toHaveBeenCalledWith({
        apiKeyCreateDto: { name: 'Importer', permissions: [Permission.AssetRead] },
      }),
    );
    expect(await screen.findByText('shown-once')).toBeInTheDocument();
  });

  it('saves full access as all', async () => {
    sdkMock.updateApiKey.mockResolvedValue({ id: 'key-1', name: 'Script', permissions: [Permission.All] } as never);
    const apiKey = {
      id: 'key-1',
      name: 'Script',
      permissions: [Permission.AssetRead],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    render(ApiKeyDialog, { apiKey, onClose: vi.fn() });

    await fireEvent.click(screen.getByRole('checkbox', { name: 'frameleaf_access_key_full_access' }));
    expect(screen.getByText('frameleaf_access_key_delete_warning')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(sdkMock.updateApiKey).toHaveBeenCalledWith({
        id: 'key-1',
        apiKeyUpdateDto: { name: 'Script', permissions: [Permission.All] },
      }),
    );
  });
});

describe('SupporterKeyDialog (FL-67)', () => {
  it('activates a personal key for this account only', async () => {
    sdkMock.setUserLicense.mockResolvedValue({} as never);
    render(SupporterKeyDialog, { kind: 'personal', onClose: vi.fn() });

    await typeInto(screen.getByLabelText('frameleaf_access_supporter_key'), 'IMCL-AAAA-BBBB');
    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_access_supporter_activate' }).at(-1)!);

    await waitFor(() =>
      expect(sdkMock.setUserLicense).toHaveBeenCalledWith({
        licenseKeyDto: { licenseKey: 'IMCL-AAAA-BBBB', activationKey: 'activation-key' },
      }),
    );
    expect(sdkMock.setServerLicense).not.toHaveBeenCalled();
  });

  it('refuses a server key in the personal activation', async () => {
    render(SupporterKeyDialog, { kind: 'personal', onClose: vi.fn() });

    await typeInto(screen.getByLabelText('frameleaf_access_supporter_key'), 'IMSV-AAAA-BBBB');

    expect(screen.getByText('frameleaf_access_supporter_key_wrong_kind')).toBeInTheDocument();
    const submit = screen.getAllByRole('button', { name: 'frameleaf_access_supporter_activate' }).at(-1)!;
    expect(submit.hasAttribute('disabled')).toBe(true);
  });

  it('registers a server key for the server only', async () => {
    sdkMock.setServerLicense.mockResolvedValue({} as never);
    render(SupporterKeyDialog, { kind: 'server', onClose: vi.fn() });

    await typeInto(screen.getByLabelText('frameleaf_access_supporter_key'), 'IMSV-AAAA-BBBB');
    await fireEvent.click(screen.getAllByRole('button', { name: 'frameleaf_access_server_key_register' }).at(-1)!);

    await waitFor(() => expect(sdkMock.setServerLicense).toHaveBeenCalled());
    expect(sdkMock.setUserLicense).not.toHaveBeenCalled();
  });
});
