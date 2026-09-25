import { CloudHeartbeatField, CloudLinkState, type CloudStatusResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FrameleafSignInSection from './FrameleafSignInSection.svelte';

vi.mock(import('$lib/managers/system-config-manager.svelte'), () => ({
  systemConfigManager: { value: { frameleafCloud: { signIn: { clientSecretConfigured: false } } } } as never,
}));

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
  permissions: { allowRemoteEnable: false, allowBackupTrigger: true, allowEntitlementRefresh: true },
  revoked: null,
  lastError: null,
  heartbeatFields: Object.values(CloudHeartbeatField),
  heartbeatFailures: 0,
  cloneSuspected: false,
  relinkRequested: false,
  linkTokenConfigured: false,
  signInClientId: null,
  signInIssuer: null,
  signInLinkedAccounts: 0,
  signInShowOnLocalLogin: false,
  signInButtonText: 'Sign in with Frameleaf',
  ...overrides,
});

const linked = (overrides: Partial<CloudStatusResponseDto> = {}) =>
  status({
    state: CloudLinkState.Linked,
    signInClientId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55',
    signInIssuer: 'https://id.frameleaf.cloud.test/',
    signInLinkedAccounts: 3,
    ...overrides,
  });

describe('FrameleafSignInSection (FL-158)', () => {
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

  it('shows Not linked, keeps the home switch off with the reason, and offers to link', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status());
    render(FrameleafSignInSection);

    expect(await screen.findByText('Not linked')).toBeInTheDocument();
    expect(screen.getByText('Link this server first.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Show “Sign in with Frameleaf” at home' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Require Frameleaf sign-in for remote access' })).toBeDisabled();
    expect(screen.getByText('Always on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link to Frameleaf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Your own OpenID provider' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link your own account' })).toBeInTheDocument();
  });

  it('shows the provider, client ID and linked accounts once linked, and turns the home button on', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.updateCloudSignIn.mockResolvedValue(linked({ signInShowOnLocalLogin: true }));
    render(FrameleafSignInSection);

    expect(await screen.findByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Frameleaf · id.frameleaf.cloud.test')).toBeInTheDocument();
    expect(screen.getByText('018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55')).toBeInTheDocument();
    expect(screen.getByText('3 people')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link to Frameleaf' })).toBeNull();

    await fireEvent.click(screen.getByRole('switch', { name: 'Show “Sign in with Frameleaf” at home' }));
    await waitFor(() =>
      expect(sdkMock.updateCloudSignIn).toHaveBeenCalledWith({ cloudSignInUpdateDto: { showOnLocalLogin: true } }),
    );
  });

  it('saves the button text on its own', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.updateCloudSignIn.mockResolvedValue(linked({ signInButtonText: 'Use Frameleaf' }));
    render(FrameleafSignInSection);

    const input = await screen.findByLabelText('Button text');
    await waitFor(() => expect(input).toHaveValue('Sign in with Frameleaf'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await fireEvent.input(input, { target: { value: '  Use Frameleaf ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sdkMock.updateCloudSignIn).toHaveBeenCalledWith({ cloudSignInUpdateDto: { buttonText: 'Use Frameleaf' } }),
    );
  });
});
