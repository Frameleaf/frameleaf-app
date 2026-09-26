import { CloudHeartbeatField, CloudLinkState, type CloudStatusResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RemoteAccessSection from './RemoteAccessSection.svelte';

const status = (overrides: Partial<CloudStatusResponseDto> = {}): CloudStatusResponseDto => ({
  state: CloudLinkState.Unlinked,
  configured: true,
  cloudHost: 'frameleaf.cloud.test',
  instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55',
  keyFingerprint: 'q7Lk',
  account: null,
  dataRegion: null,
  linkedAt: null,
  lastContactAt: null,
  pending: null,
  linkResult: null,
  linkRefusal: null,
  permissions: { allowRemoteEnable: false, allowBackupTrigger: true, allowEntitlementRefresh: true },
  revoked: null,
  lastError: null,
  heartbeatFields: Object.values(CloudHeartbeatField),
  heartbeatFailures: 0,
  cloneSuspected: false,
  relinkRequested: false,
  linkTokenConfigured: false,
  remoteAccessEnabled: false,
  signInClientId: null,
  signInIssuer: null,
  signInLinkedAccounts: 0,
  signInShowOnLocalLogin: false,
  signInButtonText: 'Sign in with Frameleaf',
  allowOriginalsOverRelay: false,
  allowPasswordOverRelay: false,
  ...overrides,
});

const linked = (overrides: Partial<CloudStatusResponseDto> = {}) =>
  status({ state: CloudLinkState.Linked, signInClientId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55', ...overrides });

describe('RemoteAccessSection (FL-161)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getLicenseStatus.mockResolvedValue({} as never);
    sdkMock.getLicenseProducts.mockResolvedValue({} as never);
  });

  it('keeps both settings off and disabled until the server is linked, and offers to link', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status());
    render(RemoteAccessSection);

    expect(await screen.findByText('Who can connect')).toBeInTheDocument();
    const originals = screen.getByRole('switch', { name: 'Allow original downloads over the relay' });
    const password = screen.getByRole('switch', { name: 'Allow password sign-in over the relay' });
    await waitFor(() => expect(originals).toBeDisabled());
    expect(password).toBeDisabled();
    expect(originals).not.toBeChecked();
    expect(password).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Require Frameleaf sign-in for remote visitors' })).toBeDisabled();
    expect(screen.getByText('Always on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link to Frameleaf' })).toBeInTheDocument();
    expect(sdkMock.updateCloudRemoteAccess).not.toHaveBeenCalled();
  });

  it('asks before allowing originals over the relay, and saves nothing when kept off', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    render(RemoteAccessSection);

    const originals = await screen.findByRole('switch', { name: 'Allow original downloads over the relay' });
    await waitFor(() => expect(originals).toBeEnabled());
    await fireEvent.click(originals);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/including embedded location data/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Keep off' }));
    expect(sdkMock.updateCloudRemoteAccess).not.toHaveBeenCalled();
  });

  it('turns password sign-in over the relay on after confirming, and off at once', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.updateCloudRemoteAccess.mockResolvedValueOnce(linked({ allowPasswordOverRelay: true }));
    render(RemoteAccessSection);

    const password = await screen.findByRole('switch', { name: 'Allow password sign-in over the relay' });
    await waitFor(() => expect(password).toBeEnabled());
    await fireEvent.click(password);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Leaked or reused passwords become a direct way in/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(sdkMock.updateCloudRemoteAccess).toHaveBeenCalledWith({
        cloudRemoteAccessUpdateDto: { allowPasswordOverRelay: true },
      }),
    );
    expect(await screen.findByText('Password sign-in over the relay is on.')).toBeInTheDocument();

    sdkMock.updateCloudRemoteAccess.mockResolvedValueOnce(linked({ allowPasswordOverRelay: false }));
    await waitFor(() => expect(password).toBeChecked());
    await fireEvent.click(password);
    await waitFor(() =>
      expect(sdkMock.updateCloudRemoteAccess).toHaveBeenLastCalledWith({
        cloudRemoteAccessUpdateDto: { allowPasswordOverRelay: false },
      }),
    );
  });

  it('shows the server’s refusal', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked({ allowOriginalsOverRelay: true }));
    sdkMock.updateCloudRemoteAccess.mockRejectedValue(new Error('Link this server first.'));
    render(RemoteAccessSection);

    const originals = await screen.findByRole('switch', { name: 'Allow original downloads over the relay' });
    await waitFor(() => expect(originals).toBeChecked());
    await fireEvent.click(originals);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
