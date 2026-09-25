import { CloudHeartbeatField, CloudLinkState, type CloudStatusResponseDto } from '@immich/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { CloudManager } from '$lib/managers/cloud-manager.svelte';

const status = (overrides: Partial<CloudStatusResponseDto> = {}): CloudStatusResponseDto => ({
  state: CloudLinkState.Unlinked,
  configured: true,
  cloudHost: 'frameleaf.cloud.test',
  instanceId: 'instance-1',
  keyFingerprint: 'kid',
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
  remoteAccessEnabled: false,
  signInClientId: null,
  signInIssuer: null,
  signInLinkedAccounts: 0,
  signInShowOnLocalLogin: false,
  signInButtonText: 'Sign in with Frameleaf',
  ...overrides,
});

const pending = () =>
  status({
    state: CloudLinkState.Pending,
    pending: {
      userCode: 'BCDF-GHJK',
      verificationUri: 'https://frameleaf.cloud.test/link',
      verificationUriComplete: 'https://frameleaf.cloud.test/link?code=BCDF-GHJK',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      intervalSeconds: 5,
    },
  });

describe('CloudManager (FL-155)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sdkMock.getLicenseStatus.mockResolvedValue({} as never);
    sdkMock.getLicenseProducts.mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps polling a pending code after a failed check, with backoff, and picks up the approval', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(pending());
    const manager = new CloudManager();
    const stop = manager.listen();
    await vi.waitFor(() => expect(manager.status?.state).toBe('pending'));

    sdkMock.getCloudLink.mockRejectedValueOnce(new Error('offline'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sdkMock.getCloudLink).toHaveBeenCalledTimes(1);
    expect(manager.pollError).toBeInstanceOf(Error);
    expect(manager.status?.state).toBe('pending');

    // the next check waits twice the interval
    sdkMock.getCloudLink.mockResolvedValueOnce(status({ state: CloudLinkState.Linked }));
    await vi.advanceTimersByTimeAsync(9000);
    expect(sdkMock.getCloudLink).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sdkMock.getCloudLink).toHaveBeenCalledTimes(2);
    expect(manager.status?.state).toBe('linked');
    expect(manager.pollError).toBeNull();
    stop();
  });

  it('shows a status that loaded even when the licence or prices failed', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status({ state: CloudLinkState.Linked }));
    sdkMock.getLicenseStatus.mockRejectedValue(new Error('licence down'));
    sdkMock.getLicenseProducts.mockRejectedValue(new Error('prices down'));
    const manager = new CloudManager();
    await manager.refresh();
    expect(manager.status?.state).toBe('linked');
    expect(manager.error).toBeNull();
  });

  it('drops a slow answer that lands after Cancel, so pending and polling do not come back', async () => {
    let answer: (value: CloudStatusResponseDto) => void = () => {};
    sdkMock.getCloudStatus.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    sdkMock.cancelCloudLink.mockResolvedValue(status());
    const manager = new CloudManager();
    const stop = manager.listen();

    await manager.cancelLink();
    expect(manager.status?.state).toBe('unlinked');
    answer(pending());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.status?.state).toBe('unlinked');
    expect(sdkMock.getCloudLink).not.toHaveBeenCalled();
    stop();
  });

  it('keeps polling a pending code when Cancel fails', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(pending());
    sdkMock.cancelCloudLink.mockRejectedValue(new Error('offline'));
    const manager = new CloudManager();
    const stop = manager.listen();
    await vi.waitFor(() => expect(manager.status?.state).toBe('pending'));

    await expect(manager.cancelLink()).rejects.toThrow('offline');
    sdkMock.getCloudLink.mockResolvedValue(status({ state: CloudLinkState.Linked }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(sdkMock.getCloudLink).toHaveBeenCalledTimes(1);
    expect(manager.status?.state).toBe('linked');
    stop();
  });
});
