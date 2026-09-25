import { ConfigCredential, updateConfigCredential, type AdminConfigDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import CredentialDialog from '$lib/components/frameleaf/settings/CredentialDialog.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import en from '../../../../../../i18n/en.json';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updateConfigCredential: vi.fn(),
}));

vi.mock(import('$lib/managers/system-config-manager.svelte'), () => ({
  systemConfigManager: {
    value: {
      oauth: { clientId: 'frameleaf', clientSecret: '', clientSecretConfigured: false },
      notifications: { smtp: { transport: { password: '', passwordConfigured: false } } },
    } as unknown as AdminConfigDto,
  } as never,
}));

vi.mock(import('$lib/managers/event-manager.svelte'), () => ({
  eventManager: { emit: vi.fn(), on: vi.fn() } as never,
}));

const valueInput = () => screen.getByLabelText<HTMLInputElement>(en.frameleaf_credentials_new_value);
const saveButton = () => screen.getByRole('button', { name: en.frameleaf_credentials_save });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('CredentialDialog (FL-67)', () => {
  it('sends the typed value once and keeps only the stored flag in the shared settings', async () => {
    vi.mocked(updateConfigCredential).mockResolvedValue({ name: ConfigCredential.OauthClientSecret, configured: true });
    const onClose = vi.fn();
    render(CredentialDialog, { name: ConfigCredential.OauthClientSecret, onClose });

    await fireEvent.input(valueInput(), { target: { value: 'provider-secret' } });
    await fireEvent.click(saveButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(updateConfigCredential).toHaveBeenCalledWith({
      name: ConfigCredential.OauthClientSecret,
      configCredentialUpdateDto: { value: 'provider-secret' },
    });
    const [event, config] = vi.mocked(eventManager.emit).mock.calls[0] as unknown as [string, AdminConfigDto];
    expect(event).toBe('SystemConfigUpdate');
    expect(config.oauth).toMatchObject({ clientSecret: '', clientSecretConfigured: true });
    expect(JSON.stringify(config)).not.toContain('provider-secret');
  });

  it('refuses a blank value', async () => {
    render(CredentialDialog, { name: ConfigCredential.SmtpPassword, onClose: vi.fn() });

    await fireEvent.input(valueInput(), { target: { value: ' '.repeat(3) } });

    expect(saveButton().hasAttribute('disabled')).toBe(true);
    expect(updateConfigCredential).not.toHaveBeenCalled();
  });

  it('shows why a value was refused and changes nothing', async () => {
    vi.mocked(updateConfigCredential).mockRejectedValue(new Error('Failed to verify SMTP configuration'));
    const onClose = vi.fn();
    render(CredentialDialog, { name: ConfigCredential.SmtpPassword, onClose });

    await fireEvent.input(valueInput(), { target: { value: 'wrong' } });
    await fireEvent.click(saveButton());

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(eventManager.emit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('drops the typed value when the dialog is dismissed', async () => {
    const onClose = vi.fn();
    render(CredentialDialog, { name: ConfigCredential.OauthClientSecret, onClose });

    const input = valueInput();
    await fireEvent.input(input, { target: { value: 'typed-secret' } });
    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));

    expect(input.value).toBe('');
    expect(onClose).toHaveBeenCalledWith(false);
    expect(updateConfigCredential).not.toHaveBeenCalled();
  });
});
