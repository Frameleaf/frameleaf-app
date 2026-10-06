import {
  CloudHeartbeatField,
  CloudLinkState,
  RemoteAccessMode,
  RemoteAccessPublicUrl,
  RemoteAccessState,
  RemoteDirectGuidance,
  RemoteDnsRecordType,
  RemoteMappingMethod,
  RemoteHostnameStatus,
  type CloudStatusResponseDto,
  type RemoteAccessStatusResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import RemoteAccessSection from './RemoteAccessSection.svelte';

const draftRef = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/system-config-draft.svelte')>()),
  getSystemConfigDraft: () => draftRef.current,
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
  status({ state: CloudLinkState.Linked, signInClientId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55', ...overrides });

const RELAY = 'https://r.u225vlzhsdlhwh4l.frameleaf.net';

/** `GET admin/cloud/remote` (FL-165). */
const remote = (overrides: Partial<RemoteAccessStatusResponseDto> = {}): RemoteAccessStatusResponseDto => ({
  unavailableReason: null,
  enabled: false,
  mode: RemoteAccessMode.Relay,
  directPort: 2443,
  portMapping: true,
  publicUrlChoice: RemoteAccessPublicUrl.Frameleaf,
  status: RemoteAccessState.Off,
  reason: null,
  publicUrl: null,
  frameleafAddress: RELAY,
  certificateName: null,
  certificateExpiresAt: null,
  certificateError: null,
  relayConnected: false,
  relayRegion: 'eu1',
  relayLatencyMs: null,
  relayConnectedAt: null,
  relayBytesIn: 0,
  relayBytesOut: 0,
  relayLastError: null,
  relayLastErrorAt: null,
  relayRevoked: false,
  directListening: false,
  cgnatSuspected: false,
  mappingMethod: null,
  mappingError: null,
  directGuidance: null,
  directExternalIp: null,
  wanAddress: null,
  wanVerified: false,
  wanProblem: null,
  customHostname: null,
  customHostnameStatus: null,
  customHostnameCheckedAt: null,
  customHostnameProblem: null,
  customHostnameRecords: [],
  candidates: [],
  lastTestAt: null,
  lastTestOk: null,
  lastTestChecks: [],
  ...overrides,
});

describe('RemoteAccessSection who can connect (FL-161)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getLicenseStatus.mockResolvedValue({} as never);
    sdkMock.getLicenseProducts.mockResolvedValue({} as never);
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ unavailableReason: 'Link this server to a Frameleaf account first.' }),
    );
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
    // offered on the remote access card and on who can connect
    expect(screen.getAllByRole('button', { name: 'Link to Frameleaf' }).length).toBeGreaterThan(0);
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

describe('RemoteAccessSection (FL-165)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getLicenseStatus.mockResolvedValue({} as never);
    sdkMock.getLicenseProducts.mockResolvedValue({} as never);
    sdkMock.getCloudStatus.mockResolvedValue(linked());
  });

  it('explains why remote access cannot be turned on and keeps the switch off', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ unavailableReason: 'Remote access is included with a Frameleaf Cloud plan.' }),
    );
    render(RemoteAccessSection);

    const reason = 'Remote access is included with a Frameleaf Cloud plan.';
    // As in the prototype, the reason is both the page's gate banner and the switch's own explanation.
    const gate = await screen.findByRole('status', { name: '' });
    expect(gate).toHaveTextContent(reason);
    const toggle = screen.getByRole('switch', { name: 'Allow remote access' });
    expect(toggle).toHaveAccessibleDescription(expect.stringContaining(reason));
    await waitFor(() => expect(toggle).toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'See plans' })).toBeInTheDocument();
  });

  it('turns remote access on and shows the public address with its certificate', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(remote());
    sdkMock.updateRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        status: RemoteAccessState.Ready,
        publicUrl: RELAY,
        certificateName: '*.u225vlzhsdlhwh4l.frameleaf.net',
        certificateExpiresAt: '2026-11-09T16:00:00.000Z',
      }),
    );
    render(RemoteAccessSection);

    const toggle = await screen.findByRole('switch', { name: 'Allow remote access' });
    await waitFor(() => expect(toggle).toBeEnabled());
    await fireEvent.click(toggle);
    await waitFor(() =>
      expect(sdkMock.updateRemoteAccess).toHaveBeenCalledWith({ remoteAccessUpdateDto: { enabled: true } }),
    );
    expect(await screen.findByText('Remote access is on.')).toBeInTheDocument();
    expect(screen.getAllByText(RELAY).length).toBeGreaterThan(0);
    expect(screen.getByText('*.u225vlzhsdlhwh4l.frameleaf.net')).toBeInTheDocument();
    expect(screen.getByText('This server only; the private key never leaves it')).toBeInTheDocument();
  });

  it('checks a custom hostname as the prototype does: records first, then DNS, pending to verified', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true, status: RemoteAccessState.Ready }));
    const records = [
      {
        type: RemoteDnsRecordType.Cname,
        name: 'photos.example.com',
        value: 'r.u225vlzhsdlhwh4l.frameleaf.net',
        purpose: '',
      },
      {
        type: RemoteDnsRecordType.Cname,
        name: '_acme-challenge.photos.example.com',
        value: '_acme-challenge.u225vlzhsdlhwh4l.frameleaf.net',
        purpose: '',
      },
    ];
    sdkMock.setRemoteHostname.mockResolvedValue(
      remote({
        enabled: true,
        customHostname: 'photos.example.com',
        customHostnameStatus: RemoteHostnameStatus.Pending,
        customHostnameRecords: records,
      }),
    );
    sdkMock.checkRemoteHostname.mockResolvedValue(
      remote({
        enabled: true,
        customHostname: 'photos.example.com',
        customHostnameStatus: RemoteHostnameStatus.Verified,
        customHostnameRecords: records,
      }),
    );
    render(RemoteAccessSection);

    const input = await screen.findByPlaceholderText('photos.example.com');
    await fireEvent.input(input, { target: { value: 'photos.frameleaf.net' } });
    const refusal = 'Use a domain you own; Frameleaf addresses are already set up.';
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check DNS' })).toBeDisabled();

    await fireEvent.input(input, { target: { value: 'photos.example.com' } });
    expect(await screen.findByText('_acme-challenge.u225vlzhsdlhwh4l.frameleaf.net')).toBeInTheDocument();
    expect(screen.getByText('Lets this server renew its own certificate for your domain.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use my domain' })).toBeDisabled();

    await fireEvent.click(screen.getByRole('button', { name: 'Check DNS' }));
    await waitFor(() =>
      expect(sdkMock.setRemoteHostname).toHaveBeenCalledWith({
        remoteHostnameUpdateDto: { hostname: 'photos.example.com' },
      }),
    );
    expect(await screen.findByText('Waiting for DNS')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Check DNS' }));
    await waitFor(() => expect(sdkMock.checkRemoteHostname).toHaveBeenCalled());
    expect(await screen.findByText('photos.example.com is verified.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use my domain' })).toBeEnabled());
  });

  it('runs the connection test and lists each check', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true, status: RemoteAccessState.Ready }));
    sdkMock.testRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        status: RemoteAccessState.Ready,
        lastTestAt: '2026-09-26T12:00:00.000Z',
        lastTestOk: true,
        lastTestChecks: [
          { id: 'certificate', ok: true, detail: 'Issued to this server' },
          { id: 'api', ok: true, detail: 'This server answered over HTTPS through the direct listener.' },
          { id: 'relay', ok: false, detail: 'Not connected to the Frameleaf relay yet.' },
        ],
      }),
    );
    render(RemoteAccessSection);

    const button = await screen.findByRole('button', { name: 'Test connection' });
    await waitFor(() => expect(button).toBeEnabled());
    await fireEvent.click(button);
    await waitFor(() => expect(sdkMock.testRemoteAccess).toHaveBeenCalled());
    expect(await screen.findByText('Connection test finished.')).toBeInTheDocument();
    const checks = screen.getByTestId('remote-test-checks');
    expect(within(checks).getByText('Request through the listener')).toBeInTheDocument();
    expect(within(checks).getByText('Not connected to the Frameleaf relay yet.')).toBeInTheDocument();
  });

  it('shows port forwarding only for direct connections', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true }));
    sdkMock.updateRemoteAccess.mockResolvedValue(remote({ enabled: true, mode: RemoteAccessMode.RelayAndDirect }));
    render(RemoteAccessSection);

    const select = await screen.findByRole('combobox');
    expect(screen.queryByText('Port forwarding')).not.toBeInTheDocument();
    await fireEvent.change(select, { target: { value: 'relay-and-direct' } });
    await waitFor(() =>
      expect(sdkMock.updateRemoteAccess).toHaveBeenCalledWith({
        remoteAccessUpdateDto: { mode: RemoteAccessMode.RelayAndDirect },
      }),
    );
    expect(await screen.findByText('Port forwarding')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'I forward the port myself' })).toBeInTheDocument();
  });

  it('shows how the router opened the port and that Frameleaf Cloud reached it (FL-167)', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        status: RemoteAccessState.Ready,
        mode: RemoteAccessMode.RelayAndDirect,
        directListening: true,
        mappingMethod: RemoteMappingMethod.Upnp,
        directExternalIp: '203.0.113.7',
        wanAddress: 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443',
        wanVerified: true,
      }),
    );
    render(RemoteAccessSection);
    expect(await screen.findByText('UPnP')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(
      screen.getByText('Reachable from the internet at 203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443'),
    ).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('explains bridge networking, a router that refused, and CGNAT (FL-167)', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        mode: RemoteAccessMode.RelayAndDirect,
        directGuidance: RemoteDirectGuidance.Bridge,
        mappingError: 'No router answered UPnP or NAT-PMP.',
      }),
    );
    const { unmount } = render(RemoteAccessSection);
    expect(await screen.findByText('The router can’t be reached from this container')).toBeInTheDocument();
    expect(screen.getByText(/host networking/)).toBeInTheDocument();
    unmount();

    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ enabled: true, mode: RemoteAccessMode.RelayAndDirect, mappingError: 'UPnP: not allowed' }),
    );
    const second = render(RemoteAccessSection);
    expect(await screen.findByText('The router did not open the port: UPnP: not allowed')).toBeInTheDocument();
    second.unmount();

    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ enabled: true, mode: RemoteAccessMode.RelayAndDirect, cgnatSuspected: true, wanProblem: null }),
    );
    render(RemoteAccessSection);
    expect(await screen.findByText('Your internet provider shares one public address')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('shows the connected relay, its round trip, since when and what it carried (FL-166)', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        status: RemoteAccessState.Ready,
        relayConnected: true,
        relayLatencyMs: 23,
        relayConnectedAt: '2026-09-26T12:00:00.000Z',
        relayBytesIn: 2048,
        relayBytesOut: 3_145_728,
      }),
    );
    render(RemoteAccessSection);

    expect(await screen.findByText('23 ms')).toBeInTheDocument();
    expect(screen.getByText('Connected since')).toBeInTheDocument();
    expect(screen.getByText(/2 KiB in, 3 MiB out/)).toBeInTheDocument();
    expect(screen.queryByText(/Last problem/)).not.toBeInTheDocument();
  });

  it('says why the relay is not connected, and when Frameleaf Cloud stopped it (FL-166)', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        status: RemoteAccessState.Ready,
        relayLastError: 'The relay refused the tunnel: timeout',
      }),
    );
    const { unmount } = render(RemoteAccessSection);
    expect(await screen.findByText('Last problem: The relay refused the tunnel: timeout')).toBeInTheDocument();
    unmount();

    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ enabled: true, status: RemoteAccessState.Ready, relayRevoked: true, relayLastError: 'revoked' }),
    );
    render(RemoteAccessSection);
    expect(await screen.findByText('Frameleaf Cloud stopped the relay for this server')).toBeInTheDocument();
  });
});

describe('RemoteAccessSection Public server URL (FL-168)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  const useDraft = (externalDomain = '') => {
    const config = { server: { externalDomain, name: '', loginPageMessage: '', publicUsers: true } } as never;
    const store = new SystemConfigDraftStore(
      { config, revision: 'r1' },
      { defaults: config, load: vi.fn(), save: vi.fn() },
    );
    draftRef.current = store;
    return store;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    draftRef.current = undefined;
    sdkMock.getCloudStatus.mockResolvedValue(linked({ remoteAccessEnabled: true }));
    sdkMock.getLicenseStatus.mockResolvedValue({} as never);
    sdkMock.getLicenseProducts.mockResolvedValue({} as never);
  });

  it('edits the Public server URL here, as part of the settings draft', async () => {
    const store = useDraft('https://old.example.com');
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true, publicUrl: RELAY }));
    render(RemoteAccessSection);

    const field = await screen.findByTestId('public-server-url');
    expect(field).toHaveValue('https://old.example.com');
    expect(screen.getByText('Saved with your other settings changes.')).toBeInTheDocument();
    await fireEvent.input(field, { target: { value: 'https://photos.example.org' } });
    expect(store.draft.server.externalDomain).toBe('https://photos.example.org');
    expect(sdkMock.updateRemoteAccess).not.toHaveBeenCalled();
  });

  it('fills it with the Frameleaf address or the verified domain, and publishes the same address', async () => {
    const store = useDraft('');
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        publicUrl: RELAY,
        customHostname: 'photos.example.com',
        customHostnameStatus: RemoteHostnameStatus.Verified,
      }),
    );
    sdkMock.updateRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        publicUrl: 'https://photos.example.com',
        publicUrlChoice: RemoteAccessPublicUrl.Custom,
        customHostname: 'photos.example.com',
        customHostnameStatus: RemoteHostnameStatus.Verified,
      }),
    );
    render(RemoteAccessSection);

    const frameleaf = await screen.findByRole('button', { name: 'Use the Frameleaf address' });
    await waitFor(() => expect(frameleaf).toBeEnabled());
    await fireEvent.click(frameleaf);
    expect(store.draft.server.externalDomain).toBe(RELAY);
    // already published: nothing to change on the server
    expect(sdkMock.updateRemoteAccess).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Use my domain' }));
    expect(store.draft.server.externalDomain).toBe('https://photos.example.com');
    await waitFor(() =>
      expect(sdkMock.updateRemoteAccess).toHaveBeenCalledWith({
        remoteAccessUpdateDto: { publicUrl: RemoteAccessPublicUrl.Custom },
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use my domain' })).toBeDisabled());
  });

  it('keeps Use my domain off until Frameleaf Cloud verified the domain', async () => {
    useDraft('');
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        customHostname: 'photos.example.com',
        customHostnameStatus: RemoteHostnameStatus.Pending,
      }),
    );
    render(RemoteAccessSection);

    const domain = await screen.findByRole('button', { name: 'Use my domain' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use the Frameleaf address' })).toBeEnabled());
    expect(domain).toBeDisabled();
  });
});

describe('RemoteAccessSection relay use this month (FL-166)', () => {
  const usage = (overrides: Record<string, unknown> = {}) => ({
    period: '2026-09',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-10-01T00:00:00.000Z',
    bytes: 171_798_691_840,
    limitBytes: 214_748_364_800,
    throttled: false,
    throttleBps: null,
    throttleUntil: null,
    ...overrides,
  });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getLicenseStatus.mockResolvedValue({} as never);
    sdkMock.getLicenseProducts.mockResolvedValue({} as never);
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true, relayConnected: true }));
    sdkMock.getRemoteAccessUsage.mockResolvedValue(usage());
  });

  it('shows this month’s relay use against the plan’s allowance', async () => {
    render(RemoteAccessSection);

    const meter = await screen.findByRole('meter', { name: 'Relay use this month' });
    expect(meter).toHaveAttribute('aria-valuenow', '171798691840');
    expect(meter).toHaveAttribute('aria-valuemax', '214748364800');
    expect(meter.className).toContain('is-high');
    expect(screen.getByText('160 GiB of 200 GiB')).toBeInTheDocument();
  });

  it('says the relay is slowed down, not cut off, once the allowance is used up', async () => {
    sdkMock.getRemoteAccessUsage.mockResolvedValue(
      usage({
        bytes: 214_748_364_800,
        throttled: true,
        throttleBps: 1_000_000,
        throttleUntil: '2026-10-01T00:00:00.000Z',
      }),
    );
    render(RemoteAccessSection);

    expect(await screen.findByText(/slowed to 1 Mbit\/s until/)).toBeInTheDocument();
    expect(screen.getByText(/Remote access keeps working/)).toBeInTheDocument();
  });

  it('asks Frameleaf Cloud for nothing while remote access is unavailable', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status());
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ unavailableReason: 'Link this server to a Frameleaf account first.' }),
    );
    render(RemoteAccessSection);

    await screen.findByText('Who can connect');
    expect(sdkMock.getRemoteAccessUsage).not.toHaveBeenCalled();
    expect(screen.queryByRole('meter', { name: 'Relay use this month' })).toBeNull();
  });
});
