import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ApiKeysSection from '$lib/components/frameleaf/access/ApiKeysSection.svelte';
import ExtensionAccessDialog from '$lib/components/frameleaf/access/ExtensionAccessDialog.svelte';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { eventManager } from '$lib/managers/event-manager.svelte';

vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: vi.fn() }));

const access = {
  id: 'access-1',
  name: 'Save to Frameleaf · Chrome',
  permissions: [],
  designPermissions: [],
  createdAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  lastUsedAt: null,
  signedInFrom: 'chrome',
};
const byHand = { ...access, id: 'key-1', name: 'Living-room frame', signedInFrom: null };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('Save to Frameleaf access in API keys (FL-655)', () => {
  it('lists the access as added by signing in, with Manage only', () => {
    render(ApiKeysSection, { keys: [access, byHand] });

    const [extension, key] = screen.getAllByRole('listitem');
    expect(extension).toHaveTextContent('Save to Frameleaf · Chrome');
    expect(extension).toHaveTextContent('frameleaf_access_key_added_by_sign_in');
    expect(extension.querySelectorAll('button')).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'frameleaf_access_key_manage Save to Frameleaf · Chrome' }),
    ).toBeVisible();
    // a key made by hand keeps Edit, Replace and Delete
    expect(key.querySelectorAll('button')).toHaveLength(3);
    expect(key).toHaveTextContent('frameleaf_access_key_made');
  });

  it('has no key to copy or replace, and Remove access asks first', async () => {
    vi.mocked(confirmFrameleaf).mockResolvedValue(true);
    sdkMock.deleteApiKey.mockResolvedValue(undefined as never);
    const removed = vi.fn();
    eventManager.on({ ApiKeyDelete: removed });
    render(ExtensionAccessDialog, { apiKey: access, onClose: vi.fn() });

    expect(screen.queryByText('frameleaf_access_key_rotate')).not.toBeInTheDocument();
    expect(screen.queryByText('frameleaf_access_key_copy')).not.toBeInTheDocument();
    expect(screen.getByText('frameleaf_access_key_extension_added_help')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_access_key_extension_remove_more' }));

    await waitFor(() => expect(sdkMock.deleteApiKey).toHaveBeenCalledWith({ id: 'access-1' }));
    expect(confirmFrameleaf).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(removed).toHaveBeenCalledWith(access);
  });

  it('keeps the access when Remove access is not confirmed', async () => {
    vi.mocked(confirmFrameleaf).mockResolvedValue(false);
    render(ExtensionAccessDialog, { apiKey: access, onClose: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_access_key_extension_remove_more' }));

    await waitFor(() => expect(confirmFrameleaf).toHaveBeenCalled());
    expect(sdkMock.deleteApiKey).not.toHaveBeenCalled();
  });
});
