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

const setup = () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  beforeEach(() => {
    vi.clearAllMocks();
    draftRef.current = undefined;
    sdkMock.getLicenseStatus.mockResolvedValue({} as never);
    sdkMock.getLicenseProducts.mockResolvedValue({} as never);
    sdkMock.getCloudStatus.mockResolvedValue(linked());
  });
};

const ALLOW = 'Let people reach this server away from home';
const ORIGINALS = 'Let people download full-size originals through Frameleaf';

describe('RemoteAccessSection: the answer and the address (FL-165, FL-541)', () => {
  setup();

  it('says why remote access is not available, with the way forward, and offers no switch', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ unavailableReason: 'Remote access needs a Server licence or a Frameleaf Cloud plan.' }),
    );
    render(RemoteAccessSection);

    expect(await screen.findByRole('heading', { name: 'Remote access is not available yet' })).toBeInTheDocument();
    expect(screen.getByText('Remote access needs a Server licence or a Frameleaf Cloud plan.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See plans' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: ALLOW })).toBeNull();
  });

  it('turns remote access on from the answer, then says it works with the address, Copy and QR code', async () => {
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

    expect(await screen.findByRole('heading', { name: 'Remote access is off' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(sdkMock.updateRemoteAccess).toHaveBeenCalledWith({ remoteAccessUpdateDto: { enabled: true } }),
    );
    expect(await screen.findByRole('heading', { name: 'Remote access is on and working' })).toBeInTheDocument();
    expect(screen.getByText(RELAY, { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Your public address' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Show QR code' }));
    expect(screen.getByRole('button', { name: 'Hide QR code' })).toBeInTheDocument();
    // the certificate sits under the closed Connection details
    const details = screen.getByText('Connection details').closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText('*.u225vlzhsdlhwh4l.frameleaf.net')).toBeInTheDocument();
  });

  it('checks it now, and opens the details of the check when one fails', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ enabled: true, status: RemoteAccessState.Ready, publicUrl: RELAY }),
    );
    sdkMock.testRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        status: RemoteAccessState.Ready,
        publicUrl: RELAY,
        lastTestAt: '2026-09-26T12:00:00.000Z',
        lastTestOk: false,
        lastTestChecks: [
          { id: 'certificate', ok: true, detail: 'Issued to this server' },
          { id: 'api', ok: false, detail: 'Frameleaf asked this server for a page and got no answer.' },
        ],
      }),
    );
    render(RemoteAccessSection);

    await fireEvent.click(await screen.findByRole('button', { name: 'Check it now' }));
    await waitFor(() => expect(sdkMock.testRemoteAccess).toHaveBeenCalled());
    expect(
      await screen.findByRole('heading', { name: 'This server can’t be reached from outside your home' }),
    ).toBeInTheDocument();
    const details = screen.getByText('Details of the check').closest('details')!;
    expect(details.open).toBe(true);
    expect(within(details).getByText('A test request got through')).toBeInTheDocument();
    expect(within(details).getByText('Frameleaf asked this server for a page and got no answer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });
});

describe('RemoteAccessSection: how devices connect (FL-166, FL-167, FL-541)', () => {
  setup();

  it('chooses an outcome, says what happens right now, and keeps router detail closed', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true, status: RemoteAccessState.Ready }));
    sdkMock.updateRemoteAccess.mockResolvedValue(
      remote({ enabled: true, status: RemoteAccessState.Ready, mode: RemoteAccessMode.RelayAndDirect }),
    );
    render(RemoteAccessSection);

    const group = await screen.findByRole('radiogroup', { name: 'How devices connect' });
    expect(within(group).getByRole('radio', { name: /Always through Frameleaf/ })).toBeChecked();
    expect(screen.getByText('everything goes through Frameleaf.')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'I set up my router myself' })).toBeNull();

    await fireEvent.click(within(group).getByRole('radio', { name: /Straight to your home when possible/ }));
    await waitFor(() =>
      expect(sdkMock.updateRemoteAccess).toHaveBeenCalledWith({
        remoteAccessUpdateDto: { mode: RemoteAccessMode.RelayAndDirect },
      }),
    );
    expect(await screen.findByRole('switch', { name: 'I set up my router myself' })).toBeInTheDocument();
    expect(
      screen.getByText(/Frameleaf is checking whether devices can connect straight to your home/),
    ).toBeInTheDocument();
  });

  it('serves the direct address with a Server licence and no plan: Through Frameleaf and your own domain need one (FL-437)', async () => {
    const wan = 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443';
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        status: RemoteAccessState.Ready,
        relayNeedsPlan: true,
        mode: RemoteAccessMode.Relay,
        publicUrl: wan,
        frameleafAddress: wan,
        wanAddress: wan,
        wanVerified: true,
        directListening: true,
      }),
    );
    render(RemoteAccessSection);

    const group = await screen.findByRole('radiogroup', { name: 'How devices connect' });
    expect(within(group).getByRole('radio', { name: /Straight to your home/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /Always through Frameleaf/ })).toBeDisabled();
    expect(screen.getByText('devices connect straight to your home.')).toBeInTheDocument();
    expect(screen.getByText('Needs a plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See plans' })).toBeInTheDocument();
    expect(sdkMock.getRemoteAccessUsage).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('photos.example.com')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check my domain' })).toBeDisabled();
  });

  it('shows the router, the region and what went through Frameleaf under Connection details', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        status: RemoteAccessState.Ready,
        mode: RemoteAccessMode.RelayAndDirect,
        relayConnected: true,
        relayLatencyMs: 23,
        relayConnectedAt: '2026-09-26T12:00:00.000Z',
        relayBytesIn: 2000,
        relayBytesOut: 3_000_000,
        mappingMethod: RemoteMappingMethod.Upnp,
        directExternalIp: '203.0.113.7',
        wanAddress: 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443',
        wanVerified: true,
      }),
    );
    render(RemoteAccessSection);

    const details = (await screen.findByText('Connection details')).closest('details')!;
    expect(within(details).getByText('Response time 23 ms')).toBeInTheDocument();
    expect(within(details).getByText(/2 KB in, 3 MB out/)).toBeInTheDocument();
    expect(within(details).getByText(/Connected since/)).toBeInTheDocument();
    expect(within(details).getByText('UPnP · 203.0.113.7')).toBeInTheDocument();
    expect(
      within(details).getByText('Reachable from the internet at 203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443'),
    ).toBeInTheDocument();
  });

  it('explains bridge networking, a router that refused, and a provider that blocks direct connections', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ enabled: true, mode: RemoteAccessMode.RelayAndDirect, directGuidance: RemoteDirectGuidance.Bridge }),
    );
    const first = render(RemoteAccessSection);
    expect(await screen.findByText('The router can’t be reached from this container')).toBeInTheDocument();
    first.unmount();

    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ enabled: true, mode: RemoteAccessMode.RelayAndDirect, mappingError: 'UPnP: not allowed' }),
    );
    const second = render(RemoteAccessSection);
    expect(await screen.findByText('The router did not open the port: UPnP: not allowed')).toBeInTheDocument();
    second.unmount();

    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ enabled: true, mode: RemoteAccessMode.RelayAndDirect, cgnatSuspected: true }),
    );
    render(RemoteAccessSection);
    expect(await screen.findByText('Your internet provider shares one public address')).toBeInTheDocument();
    expect(
      screen.getByText(/doesn’t allow direct connections, so everything goes through Frameleaf/),
    ).toBeInTheDocument();
  });

  it('says why nothing goes through Frameleaf, and when Frameleaf Cloud stopped it', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({
        enabled: true,
        status: RemoteAccessState.Ready,
        relayLastError: 'The relay refused the tunnel: timeout',
      }),
    );
    const first = render(RemoteAccessSection);
    expect(await screen.findByText('Last problem: The relay refused the tunnel: timeout')).toBeInTheDocument();
    first.unmount();

    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ enabled: true, status: RemoteAccessState.Ready, relayRevoked: true }),
    );
    render(RemoteAccessSection);
    expect(
      await screen.findByText('Frameleaf Cloud stopped connections through Frameleaf for this server'),
    ).toBeInTheDocument();
  });
});

describe('RemoteAccessSection: the monthly allowance (FL-166)', () => {
  setup();
  const usage = (overrides: Record<string, unknown> = {}) => ({
    period: '2026-09',
    periodStart: '2026-09-01T00:00:00.000Z',
    periodEnd: '2026-10-01T00:00:00.000Z',
    bytes: 160_000_000_000,
    limitBytes: 200_000_000_000,
    throttled: false,
    throttleBps: null,
    throttleUntil: null,
    ...overrides,
  });

  it('shows this month through Frameleaf against the plan’s allowance, beside how devices connect', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true, relayConnected: true }));
    sdkMock.getRemoteAccessUsage.mockResolvedValue(usage());
    render(RemoteAccessSection);

    const meter = await screen.findByRole('meter', { name: 'Sent through Frameleaf this month' });
    expect(meter).toHaveAttribute('aria-valuenow', '80');
    expect(screen.getByText('160 GB')).toBeInTheDocument();
    expect(screen.getByText('of 200 GB')).toBeInTheDocument();
    expect(screen.getByText(/Your plan includes 200 GB a month/)).toBeInTheDocument();
  });

  it('says it is slower, not stopped, once the allowance is used up', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ enabled: true, status: RemoteAccessState.Ready, relayConnected: true }),
    );
    sdkMock.getRemoteAccessUsage.mockResolvedValue(
      usage({
        bytes: 200_000_000_000,
        throttled: true,
        throttleBps: 1_000_000,
        throttleUntil: '2026-10-01T00:00:00.000Z',
      }),
    );
    render(RemoteAccessSection);

    expect(
      await screen.findByRole('heading', { name: /Remote access is working, but slower until/ }),
    ).toBeInTheDocument();
    expect(screen.getByText(/slowed to 1 Mbit\/s until/)).toBeInTheDocument();
  });

  it('asks Frameleaf Cloud for nothing while remote access is unavailable', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status());
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ unavailableReason: 'Link this server to a Frameleaf account first.' }),
    );
    render(RemoteAccessSection);

    expect(await screen.findByText('Link this server to a Frameleaf account first.')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdkMock.getRemoteAccessUsage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Link to Frameleaf' })).toBeInTheDocument();
  });
});

describe('RemoteAccessSection: the address in links you share (FL-165, FL-168, FL-541)', () => {
  setup();

  const useDraft = (externalDomain = '') => {
    const config = { server: { externalDomain, name: '', loginPageMessage: '', publicUsers: true } } as never;
    const store = new SystemConfigDraftStore(
      { config, revision: 'r1' },
      { defaults: config, load: vi.fn(), save: vi.fn() },
    );
    draftRef.current = store;
    return store;
  };

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

  it('sets up your own domain under Advanced: records first, then the check, waiting to ready', async () => {
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true, status: RemoteAccessState.Ready }));
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

    const group = await screen.findByRole('radiogroup', { name: 'The address in links you share' });
    expect(within(group).getByRole('radio', { name: /Your own domain/ })).toBeDisabled();

    const input = screen.getByPlaceholderText('photos.example.com');
    await fireEvent.input(input, { target: { value: 'photos.frameleaf.net' } });
    expect(
      await screen.findByText('Use a domain you own; Frameleaf addresses are already set up.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check my domain' })).toBeDisabled();

    await fireEvent.input(input, { target: { value: 'photos.example.com' } });
    expect(await screen.findByText('_acme-challenge.u225vlzhsdlhwh4l.frameleaf.net')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Check my domain' }));
    await waitFor(() =>
      expect(sdkMock.setRemoteHostname).toHaveBeenCalledWith({
        remoteHostnameUpdateDto: { hostname: 'photos.example.com' },
      }),
    );
    expect(await screen.findByText(/The records are not visible yet/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Check my domain' }));
    await waitFor(() => expect(sdkMock.checkRemoteHostname).toHaveBeenCalled());
    expect(await screen.findByText('photos.example.com is verified.')).toBeInTheDocument();
    await waitFor(() => expect(within(group).getByRole('radio', { name: /Your own domain/ })).toBeEnabled());
  });

  it('chooses the address links start with, and publishes the same address', async () => {
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

    const group = await screen.findByRole('radiogroup', { name: 'The address in links you share' });
    await fireEvent.click(within(group).getByRole('radio', { name: /Your own domain/ }));
    expect(store.draft.server.externalDomain).toBe('https://photos.example.com');
    await waitFor(() =>
      expect(sdkMock.updateRemoteAccess).toHaveBeenCalledWith({
        remoteAccessUpdateDto: { publicUrl: RemoteAccessPublicUrl.Custom },
      }),
    );
    expect(await screen.findByText('https://photos.example.com', { selector: 'strong' })).toBeInTheDocument();
  });

  it('types another address under Advanced, as part of the settings draft', async () => {
    const store = useDraft('https://old.example.com');
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true, publicUrl: RELAY }));
    render(RemoteAccessSection);

    const field = await screen.findByTestId('public-server-url');
    expect(field).toHaveValue('https://old.example.com');
    await fireEvent.input(field, { target: { value: 'https://photos.example.org' } });
    expect(store.draft.server.externalDomain).toBe('https://photos.example.org');
    expect(sdkMock.updateRemoteAccess).not.toHaveBeenCalled();
  });
});

describe('RemoteAccessSection: signing in away from home and originals (FL-161, FL-541)', () => {
  setup();
  beforeEach(() => {
    sdkMock.getRemoteAccess.mockResolvedValue(remote({ enabled: true, status: RemoteAccessState.Ready }));
  });

  it('keeps one sign-in choice, held until the server is linked', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status());
    sdkMock.getRemoteAccess.mockResolvedValue(
      remote({ unavailableReason: 'Link this server to a Frameleaf account first.' }),
    );
    render(RemoteAccessSection);
    expect(await screen.findByText('Link this server to a Frameleaf account first.')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Signing in away from home' })).toBeNull();
  });

  it('asks before letting passwords work away from home, and says so once they do', async () => {
    sdkMock.updateCloudRemoteAccess.mockResolvedValueOnce(linked({ allowPasswordOverRelay: true }));
    render(RemoteAccessSection);

    const group = await screen.findByRole('radiogroup', { name: 'Signing in away from home' });
    expect(within(group).getByRole('radio', { name: /Frameleaf account only/ })).toBeChecked();
    await fireEvent.click(within(group).getByRole('radio', { name: /Frameleaf account or password/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Leaked or reused passwords become a direct way in/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(sdkMock.updateCloudRemoteAccess).toHaveBeenCalledWith({
        cloudRemoteAccessUpdateDto: { allowPasswordOverRelay: true },
      }),
    );
    expect(await screen.findByText('Passwords now work from anywhere')).toBeInTheDocument();

    sdkMock.updateCloudRemoteAccess.mockResolvedValueOnce(linked({ allowPasswordOverRelay: false }));
    await fireEvent.click(within(group).getByRole('radio', { name: /Frameleaf account only/ }));
    await waitFor(() =>
      expect(sdkMock.updateCloudRemoteAccess).toHaveBeenLastCalledWith({
        cloudRemoteAccessUpdateDto: { allowPasswordOverRelay: false },
      }),
    );
  });

  it('asks before allowing full-size originals, and saves nothing when kept off', async () => {
    render(RemoteAccessSection);
    const originals = await screen.findByRole('switch', { name: ORIGINALS });
    await waitFor(() => expect(originals).toBeEnabled());
    await fireEvent.click(originals);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/including where each photo was taken/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Keep off' }));
    expect(sdkMock.updateCloudRemoteAccess).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(linked({ allowOriginalsOverRelay: true }));
    sdkMock.updateCloudRemoteAccess.mockRejectedValue(new Error('Link this server first.'));
    render(RemoteAccessSection);
    const originals = await screen.findByRole('switch', { name: ORIGINALS });
    await waitFor(() => expect(originals).toBeChecked());
    await fireEvent.click(originals);
    expect(await screen.findByText('That did not work. Try again.')).toBeInTheDocument();
  });
});
