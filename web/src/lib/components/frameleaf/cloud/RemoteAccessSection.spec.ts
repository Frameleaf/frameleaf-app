import {
  CloudHeartbeatField,
  CloudLinkState,
  RemoteAccessMode,
  RemoteAccessPublicUrl,
  RemoteAccessState,
  RemoteDnsRecordType,
  RemoteHostnameStatus,
  type CloudStatusResponseDto,
  type RemoteAccessStatusResponseDto,
} from '@immich/sdk';
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
  directListening: false,
  cgnatSuspected: false,
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
});
