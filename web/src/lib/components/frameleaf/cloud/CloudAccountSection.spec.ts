import { CloudHeartbeatField, CloudLinkRefusal, CloudLinkState, type CloudStatusResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import CloudAccountSection from './CloudAccountSection.svelte';

const status = (overrides: Partial<CloudStatusResponseDto> = {}): CloudStatusResponseDto => ({
  state: CloudLinkState.Unlinked,
  configured: true,
  cloudHost: 'frameleaf.cloud.test',
  instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55',
  keyFingerprint: 'q7LkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9vXe',
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

const pending = () =>
  status({
    state: CloudLinkState.Pending,
    linkResult: 'pending' as never,
    pending: {
      userCode: 'BCDF-GHJK',
      verificationUri: 'https://frameleaf.cloud.test/link',
      verificationUriComplete: 'https://frameleaf.cloud.test/link?code=BCDF-GHJK',
      expiresAt: new Date(Date.now() + 9 * 60 * 1000 + 30_000).toISOString(),
      intervalSeconds: 5,
    },
  });

const linked = () =>
  status({
    state: CloudLinkState.Linked,
    account: { id: 'account-1', label: 'owner@example.test' },
    linkedAt: '2026-09-25T09:00:00.000Z',
    lastContactAt: '2026-09-25T09:05:00.000Z',
    dataRegion: 'eu',
    signInClientId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55',
    manageUrl: 'https://frameleaf.cloud.test/servers/018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55',
  });

describe('CloudAccountSection (FL-154, FL-155)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says Frameleaf Cloud is not set up when the server has no address, and offers no link', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status({ state: CloudLinkState.NotConfigured, configured: false }));
    render(CloudAccountSection);

    expect(await screen.findByText('Frameleaf Cloud is turned off for this server')).toBeInTheDocument();
    expect(screen.getByText(/sets the Frameleaf Cloud address in its configuration/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Link to Frameleaf/ })).not.toBeInTheDocument();
  });

  it.each([
    [CloudLinkRefusal.InstanceLimit, 'Your plan has no room for another server'],
    [CloudLinkRefusal.ServerRefused, 'Frameleaf Cloud refused this server'],
    [CloudLinkRefusal.InstanceIdTaken, 'This server’s ID is still registered'],
    [CloudLinkRefusal.KeyAlreadyLinked, 'This server’s key is already linked'],
  ])('explains a refused link (%s) in words an administrator can act on (FL-177)', async (linkRefusal, title) => {
    sdkMock.getCloudStatus.mockResolvedValue(
      status({ linkRefusal, lastError: 'Linking did not finish: raw cloud message' }),
    );
    render(CloudAccountSection);

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getAllByText(/Servers in your Frameleaf account|identity directory/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Linking did not finish: raw cloud message')).toBeNull();
    expect(screen.getByRole('button', { name: /Link this server/ })).toBeInTheDocument();
  });

  describe('region-mismatch (FC-18)', () => {
    const REGION_MESSAGE =
      "This Frameleaf account keeps its data in the EU, not North America. Link this server to an account in that region, or change the server's region setting to the EU and link again.";
    const refusedRegion = (canContinue: boolean, overrides: Partial<CloudStatusResponseDto> = {}) =>
      status({
        linkRefusal: CloudLinkRefusal.RegionMismatch,
        lastError: REGION_MESSAGE,
        regionMismatch: { accountRegion: 'eu', requestedRegion: 'na', canContinue },
        ...overrides,
      });

    it('shows Frameleaf Cloud’s message naming both regions and links in the account’s region', async () => {
      sdkMock.getCloudStatus.mockResolvedValue(refusedRegion(true));
      sdkMock.continueCloudLink.mockResolvedValue(linked());
      render(CloudAccountSection);

      expect(await screen.findByText('Your Frameleaf account keeps its data in another region')).toBeInTheDocument();
      expect(screen.getByText(REGION_MESSAGE)).toBeInTheDocument();
      // the kept approval means no new code: one click links in the account's region
      await fireEvent.click(screen.getByRole('button', { name: 'Link in the EU' }));
      await waitFor(() => expect(sdkMock.continueCloudLink).toHaveBeenCalled());
      expect(sdkMock.startCloudLink).not.toHaveBeenCalled();
      expect(await screen.findByText('Linked in the EU.')).toBeInTheDocument();
    });

    it('cancels the kept approval', async () => {
      sdkMock.getCloudStatus.mockResolvedValue(refusedRegion(true));
      sdkMock.cancelCloudLink.mockResolvedValue(status());
      render(CloudAccountSection);

      const actions = await screen.findByTestId('cloud-region-mismatch-actions');
      await fireEvent.click(within(actions).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(sdkMock.cancelCloudLink).toHaveBeenCalled());
      expect(sdkMock.continueCloudLink).not.toHaveBeenCalled();
    });

    it('shows the message for a headless link token, which was not used up, without a continue action', async () => {
      sdkMock.getCloudStatus.mockResolvedValue(refusedRegion(false, { linkTokenConfigured: true }));
      render(CloudAccountSection);

      expect(await screen.findByText((text) => text.includes(REGION_MESSAGE))).toBeInTheDocument();
      expect(screen.getByText(/The link token was not used up/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Link in/ })).toBeNull();
      expect(screen.getByRole('button', { name: /Link this server/ })).toBeInTheDocument();
    });
  });

  it('leads the unlinked page with the mobile apps and starts the device flow', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status());
    sdkMock.startCloudLink.mockResolvedValue(pending());
    render(CloudAccountSection);

    // The prototype's Account & link, not linked: what linking leads to, the apps first.
    const leads = await screen.findByRole('region', { name: 'What linking leads to' });
    const [first] = within(leads).getAllByRole('listitem');
    expect(first).toHaveTextContent('This server appears in the Frameleaf apps by itself');
    expect(first).toHaveTextContent('Free with an account');
    expect(screen.getByText('This server isn’t linked to a Frameleaf account')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: /Link this server/ }));
    await waitFor(() => expect(sdkMock.startCloudLink).toHaveBeenCalled());
    expect(await screen.findByText('BCDF-GHJK')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Link this server/ })).toBeInTheDocument();
    expect(screen.getByText(/^9:[23]\d$/)).toBeInTheDocument();
    expect(screen.getByText(/SHA256:q7Lk…9vXe/)).toBeInTheDocument();
  });

  it('shows an expired code crossed out with a new-code action', async () => {
    const expired = pending();
    expired.pending!.expiresAt = new Date(Date.now() - 1000).toISOString();
    sdkMock.getCloudStatus.mockResolvedValue(expired);
    render(CloudAccountSection);

    expect(await screen.findByText('Code expired')).toBeInTheDocument();
    expect(screen.getByText('BCDF-GHJK')).toHaveClass('is-expired');
    expect(screen.getByRole('button', { name: /Get a new code/ })).toBeInTheDocument();
  });

  it('cancels a pending code', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(pending());
    sdkMock.cancelCloudLink.mockResolvedValue(status());
    render(CloudAccountSection);

    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(sdkMock.cancelCloudLink).toHaveBeenCalled());
    expect(await screen.findByText('This server isn’t linked to a Frameleaf account')).toBeInTheDocument();
  });

  it('shows the linked account, where the apps work, the permission toggles and exactly what is sent', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.updateCloudPermissions.mockResolvedValue({
      ...linked(),
      permissions: { ...linked().permissions, allowRemoteEnable: true },
    });
    render(CloudAccountSection);

    expect(await screen.findByText('Linked to owner@example.test')).toBeInTheDocument();
    // FL-177 review (#32): a role changed in the Frameleaf account applies at the next sign-in
    expect(screen.getByText(/applies here at that person’s next Sign in with Frameleaf/)).toBeInTheDocument();
    expect(screen.getByText('At home only')).toBeInTheDocument();

    const sends = screen.getByTestId('cloud-heartbeat-fields');
    expect(
      within(sends)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual([
      'Frameleaf version',
      'Start marker',
      'Uptime',
      'Health',
      'Endpoints',
      'Remote access',
      'Permissions',
      'Licence',
      'Capabilities',
      'Remote access settings',
      'Cloud processing settings',
      'Cloud backup settings',
      'Licence state',
      'Never sent',
    ]);

    const remote = screen.getByRole('switch', { name: 'Turn remote access on or off' });
    expect(remote).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(remote);
    await waitFor(() =>
      expect(sdkMock.updateCloudPermissions).toHaveBeenCalledWith({
        cloudPermissionsUpdateDto: { allowRemoteEnable: true },
      }),
    );
  });

  it('opens this server on the account site in a new tab, and only while linked', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    render(CloudAccountSection);
    const manage = await screen.findByRole('link', { name: /Manage on frameleaf\.cloud/ });
    expect(manage).toHaveAttribute('href', 'https://frameleaf.cloud.test/servers/018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55');
    expect(manage).toHaveAttribute('target', '_blank');
    expect(manage).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('offers no manage link when the server has no account-site page', async () => {
    sdkMock.getCloudStatus.mockResolvedValue({ ...linked(), manageUrl: null });
    render(CloudAccountSection);
    await screen.findByText('Linked to owner@example.test');
    expect(screen.queryByRole('link', { name: /Manage on frameleaf\.cloud/ })).toBeNull();
  });

  it('leads from the apps notice to remote access setup while remote access is off', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    render(CloudAccountSection);
    const setup = await screen.findByRole('link', { name: 'Set up remote access' });
    expect(setup.getAttribute('href')).toContain('section=cloud-remote');
  });

  it('says the apps are available anywhere once remote access is on', async () => {
    sdkMock.getCloudStatus.mockResolvedValue({ ...linked(), remoteAccessEnabled: true });
    render(CloudAccountSection);
    expect(await screen.findByText('Available anywhere')).toBeInTheDocument();
    expect(screen.getByText(/through the Frameleaf relay otherwise/)).toBeInTheDocument();
    expect(screen.queryByText('At home only')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Set up remote access' })).toBeNull();
  });

  it('asks for confirmation before unlinking and lists what stops', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.unlinkCloud.mockResolvedValue(status());
    render(CloudAccountSection);

    await fireEvent.click(await screen.findByRole('button', { name: /Unlink…/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Local photos, albums, accounts and sign-in keep working/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: /Unlink server/ });
    expect(confirm).toBeDisabled();
    await fireEvent.click(within(dialog).getByRole('checkbox'));
    await fireEvent.click(confirm);
    await waitFor(() => expect(sdkMock.unlinkCloud).toHaveBeenCalled());
  });

  it('shows why Frameleaf Cloud ended the link', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(
      status({
        state: CloudLinkState.Revoked,
        revoked: { at: '2026-09-25T09:00:00.000Z', reason: 'Frameleaf Cloud no longer recognises this server.' },
      }),
    );
    render(CloudAccountSection);

    expect(await screen.findByText('Frameleaf Cloud ended this link')).toBeInTheDocument();
    expect(screen.getByText(/no longer recognises this server/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link again' })).toBeInTheDocument();
  });
});
