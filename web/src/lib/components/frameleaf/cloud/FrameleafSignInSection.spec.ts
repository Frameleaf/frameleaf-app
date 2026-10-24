import { CloudHeartbeatField, CloudLinkState, type CloudStatusResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import FrameleafSignInSection from './FrameleafSignInSection.svelte';

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
  regionMismatch: null,
  permissions: { allowRemoteEnable: false, allowBackupTrigger: true, allowEntitlementRefresh: true },
  revoked: null,
  lastError: null,
  heartbeatFields: Object.values(CloudHeartbeatField),
  heartbeatFailures: 0,
  cloneSuspected: false,
  relinkRequested: false,
  linkTokenConfigured: false,
  remoteAccessEnabled: false,
  manageUrl: null,
  signInClientId: null,
  signInIssuer: null,
  signInLinkedAccounts: 0,
  signInShowOnLocalLogin: false,
  signInButtonText: 'Sign in with Frameleaf',
  signInInvitedStorageQuota: null,
  allowOriginalsOverRelay: false,
  allowPasswordOverRelay: false,
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

const people = (overrides: { canRemind?: boolean; emmaLinked?: boolean } = {}) => ({
  canRemind: overrides.canRemind ?? true,
  people: [
    {
      id: 'u-emma',
      name: 'Emma',
      email: 'emma@example.com',
      linked: !!overrides.emmaLinked,
      frameleafEmail: overrides.emmaLinked ? 'emma@frameleaf.app' : null,
    },
    { id: 'u-sam', name: 'Sam', email: 'sam@example.com', linked: true, frameleafEmail: 'sam@frameleaf.app' },
  ],
});

describe('FrameleafSignInSection (FL-158, FL-541)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getLicenseStatus.mockResolvedValue({} as never);
    sdkMock.getLicenseProducts.mockResolvedValue({} as never);
    sdkMock.getCloudSignInPeople.mockResolvedValue(people());
  });

  it('says it is not available until the server is linked, keeps the home switch held, and offers to link', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status());
    render(FrameleafSignInSection);

    expect(await screen.findByRole('heading', { name: 'Sign in with Frameleaf isn’t available yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link this server' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Offer Sign in with Frameleaf at home' })).toBeDisabled();
    expect(screen.queryByText('Who has linked')).toBeNull();
    expect(sdkMock.getCloudSignInPeople).not.toHaveBeenCalled();
    // FL-177: the server's key is the only client credential; there is no secret to enter
    expect(screen.queryByText(/client secret/i)).toBeNull();
  });

  it('lists who has and hasn’t linked by name, and reminds someone who hasn’t', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.remindCloudSignIn.mockResolvedValue(undefined as never);
    render(FrameleafSignInSection);

    expect(await screen.findByRole('heading', { name: '1 of 2 people can sign in with Frameleaf' })).toBeInTheDocument();
    expect(screen.getByText(/Not yet: Emma\./)).toBeInTheDocument();
    expect(screen.getByText('Can only sign in at home')).toBeInTheDocument();
    expect(screen.getByText('sam@frameleaf.app')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Remind' }));
    await waitFor(() => expect(sdkMock.remindCloudSignIn).toHaveBeenCalledWith({ id: 'u-emma' }));
    expect(await screen.findByText(/Emailed Emma a link/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send Emma a reminder' })).toBeInTheDocument();
  });

  it('says why there is no Remind without email, and says when everyone has linked', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.getCloudSignInPeople.mockResolvedValue(people({ canRemind: false }));
    const { unmount } = render(FrameleafSignInSection);
    expect(await screen.findByText('Reminders need email and a public address for this server.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remind' })).toBeNull();
    unmount();

    sdkMock.getCloudSignInPeople.mockResolvedValue(people({ emmaLinked: true }));
    render(FrameleafSignInSection);
    expect(await screen.findByRole('heading', { name: 'Everyone can sign in with Frameleaf' })).toBeInTheDocument();
    expect(screen.getByText(/All 2 people have linked/)).toBeInTheDocument();
  });

  it('turns the home button on, and saves the button’s words on their own', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.updateCloudSignIn.mockResolvedValue(linked({ signInShowOnLocalLogin: true }));
    render(FrameleafSignInSection);

    await fireEvent.click(await screen.findByRole('switch', { name: 'Offer Sign in with Frameleaf at home' }));
    await waitFor(() =>
      expect(sdkMock.updateCloudSignIn).toHaveBeenCalledWith({ cloudSignInUpdateDto: { showOnLocalLogin: true } }),
    );

    const input = screen.getByLabelText('Words on the button');
    await waitFor(() => expect(input).toHaveValue('Sign in with Frameleaf'));
    await fireEvent.input(input, { target: { value: '  Use Frameleaf ' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sdkMock.updateCloudSignIn).toHaveBeenCalledWith({ cloudSignInUpdateDto: { buttonText: 'Use Frameleaf' } }),
    );
    // the rule for away from home lives in Remote access
    expect(screen.getByRole('link', { name: 'Change in Remote access' }).getAttribute('href')).toContain(
      'section=cloud-remote',
    );
  });
});
