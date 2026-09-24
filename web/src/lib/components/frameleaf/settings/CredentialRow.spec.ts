import { ConfigCredential, deleteConfigCredential, type AdminConfigDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import CredentialRow from '$lib/components/frameleaf/settings/CredentialRow.svelte';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import en from '../../../../../../i18n/en.json';

/**
 * FL-67 / section D of the Sept 24 port: a write-only credential is a compact settings row, and
 * clearing it asks through the Frameleaf confirmation, never the upstream modal.
 */
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  deleteConfigCredential: vi.fn(),
}));
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: vi.fn() }));
vi.mock(import('$lib/managers/system-config-manager.svelte'), () => ({
  systemConfigManager: {
    value: { oauth: { clientSecretConfigured: true } } as unknown as AdminConfigDto,
  } as never,
}));
vi.mock(import('$lib/managers/event-manager.svelte'), () => ({
  eventManager: { emit: vi.fn(), on: vi.fn() } as never,
}));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('CredentialRow', () => {
  it('shows the stored state and clears only after the Frameleaf confirmation', async () => {
    vi.mocked(confirmFrameleaf).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(deleteConfigCredential).mockResolvedValue({
      name: ConfigCredential.OauthClientSecret,
      configured: false,
    });
    render(CredentialRow, { name: ConfigCredential.OauthClientSecret });
    expect(screen.getAllByText(en.frameleaf_credentials_stored).length).toBeGreaterThan(0);

    const clear = screen.getByRole('button', { name: en.frameleaf_credentials_clear });
    await fireEvent.click(clear);
    await waitFor(() => expect(confirmFrameleaf).toHaveBeenCalledTimes(1));
    expect(vi.mocked(confirmFrameleaf).mock.calls[0][0]).toMatchObject({ danger: true });
    expect(deleteConfigCredential).not.toHaveBeenCalled();

    await fireEvent.click(clear);
    await waitFor(() =>
      expect(deleteConfigCredential).toHaveBeenCalledWith({ name: ConfigCredential.OauthClientSecret }),
    );
  });
});
