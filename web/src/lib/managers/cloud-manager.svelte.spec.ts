import {
  CloudHeartbeatField,
  CloudLinkState,
  type CloudStatusResponseDto,
  type LicenseStatusResponseDto,
  type CloudBackupLicenceCoverageResponseDto,
} from '@frameleaf/sdk';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { CloudManager } from '$lib/managers/cloud-manager.svelte';
import { deferredPromise } from '@test-data/deferred';

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
    sdkMock.getCloudBackupLicenceCoverage.mockResolvedValue({ scope: 'unknown', accounts: [] } as never);
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

  it('clears account coverage on an offline refresh instead of keeping a stale licence claim', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status({ state: CloudLinkState.Linked }));
    sdkMock.getCloudBackupLicenceCoverage.mockResolvedValueOnce({ scope: 'all', accounts: [] } as never);
    const manager = new CloudManager();
    await manager.refresh();
    expect(manager.backupCoverage?.scope).toBe('all');
    sdkMock.getCloudBackupLicenceCoverage.mockRejectedValueOnce(new Error('offline'));
    await manager.refresh();
    expect(manager.backupCoverage).toBeNull();
  });

  it('reactively loads coverage from its initial unknown state and clears it on account change', async () => {
    authManager.setUser({ id: 'admin-1' } as never);
    sdkMock.getCloudStatus.mockResolvedValue(status({ state: CloudLinkState.Linked }));
    sdkMock.getCloudBackupLicenceCoverage.mockResolvedValueOnce({ scope: 'all', accounts: [] } as never);
    const manager = new CloudManager();
    let rendered: string | undefined;
    const cleanup = $effect.root(() => {
      const scope = $derived(manager.backupCoverage?.scope);
      $effect(() => {
        rendered = scope;
      });
    });
    try {
      flushSync();
      expect(rendered).toBeUndefined();
      await manager.refresh();
      flushSync();
      expect(rendered).toBe('all');
      authManager.setUser({ id: 'admin-2' } as never);
      flushSync();
      expect(rendered).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('does not expose covered account names to the next signed-in session', async () => {
    authManager.setUser({ id: 'admin-1' } as never);
    sdkMock.getCloudStatus.mockResolvedValue(status({ state: CloudLinkState.Linked }));
    sdkMock.getCloudBackupLicenceCoverage.mockResolvedValueOnce({
      scope: 'users',
      accounts: [{ userId: 'member', name: 'Private member name' }],
    } as never);
    const manager = new CloudManager();
    await manager.refresh();
    expect(manager.backupCoverage?.accounts).toHaveLength(1);
    authManager.setUser({ id: 'admin-2' } as never);
    expect(manager.backupCoverage).toBeNull();
  });

  it('keeps a pending link polling when the licence refreshes during a slow poll', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(pending());
    sdkMock.refreshLicense.mockResolvedValue({} as never);
    sdkMock.getCloudBackupLicenceCoverage.mockResolvedValue({ scope: 'unknown', accounts: [] } as never);
    const manager = new CloudManager();
    const stop = manager.listen();
    await vi.waitFor(() => expect(manager.status?.state).toBe('pending'));
    let answer: (value: CloudStatusResponseDto) => void = () => {};
    sdkMock.getCloudLink.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
    await vi.advanceTimersByTimeAsync(5000);
    await manager.refreshLicense();
    answer(pending());
    await vi.advanceTimersByTimeAsync(5000);
    expect(sdkMock.getCloudLink).toHaveBeenCalledTimes(2);
    stop();
  });

  describe('licence actions and background coverage', () => {
    const oldLicense = { keyHint: 'old' } as LicenseStatusResponseDto;
    const newLicense = { keyHint: 'new' } as LicenseStatusResponseDto;
    const linked = () =>
      status({
        state: CloudLinkState.Linked,
        account: { id: 'account-1', label: 'Account' },
        linkedAt: '2026-11-01T00:00:00Z',
      });
    const all = { scope: 'all', accounts: [] } as CloudBackupLicenceCoverageResponseDto;
    const none = { scope: 'none', accounts: [] } as CloudBackupLicenceCoverageResponseDto;
    const ready = async () => {
      sdkMock.getCloudStatus.mockResolvedValue(linked());
      sdkMock.getLicenseStatus.mockResolvedValue(oldLicense);
      sdkMock.getCloudBackupLicenceCoverage.mockResolvedValue(all);
      const manager = new CloudManager();
      await manager.refresh();
      return manager;
    };

    it.each(['before', 'after'])('keeps the action result when a concurrent read completes %s it', async (order) => {
      const manager = await ready();
      const mutation = deferredPromise<LicenseStatusResponseDto>();
      const read = deferredPromise<LicenseStatusResponseDto>();
      sdkMock.refreshLicense.mockReturnValueOnce(mutation.promise);
      sdkMock.getLicenseStatus.mockReturnValueOnce(read.promise);
      sdkMock.getCloudStatus.mockResolvedValue({ ...linked(), lastContactAt: '2026-11-02T00:00:00Z' });
      const action = manager.refreshLicense();
      const refresh = manager.refresh();
      if (order === 'before') {
        read.resolve(oldLicense);
        await refresh;
      }
      mutation.resolve(newLicense);
      await action;
      expect(manager.license).toEqual(newLicense);
      if (order === 'after') {
        read.resolve(oldLicense);
        await refresh;
      }
      expect(manager.license).toEqual(newLicense);
    });

    it('finishes a licence action while the coverage request is still pending', async () => {
      const manager = await ready();
      const coverage = deferredPromise<CloudBackupLicenceCoverageResponseDto>();
      sdkMock.refreshLicense.mockResolvedValueOnce(newLicense);
      sdkMock.getCloudBackupLicenceCoverage.mockReturnValueOnce(coverage.promise);
      await expect(manager.refreshLicense()).resolves.toEqual(newLicense);
      expect(manager.license).toEqual(newLicense);
      expect(manager.backupCoverage).toBeNull();
      coverage.resolve(none);
      await Promise.resolve();
      expect(manager.backupCoverage).toEqual(none);
    });

    it.each(['license', 'link'])('rechecks fresh coverage after a failed %s action', async (kind) => {
      const manager = await ready();
      const coverage = deferredPromise<CloudBackupLicenceCoverageResponseDto>();
      sdkMock.getCloudBackupLicenceCoverage.mockReturnValueOnce(coverage.promise);
      if (kind === 'license') {
        sdkMock.refreshLicense.mockRejectedValueOnce(new Error('refused'));
      } else {
        sdkMock.unlinkCloud.mockRejectedValueOnce(new Error('refused'));
      }
      await expect(kind === 'license' ? manager.refreshLicense() : manager.unlink()).rejects.toThrow('refused');
      expect(manager.backupCoverage).toBeNull();
      coverage.resolve(none);
      await Promise.resolve();
      expect(manager.backupCoverage).toEqual(none);
    });

    it.each(['session', 'link', 'newer action'])('drops an action response after a changed %s', async (change) => {
      const manager = await ready();
      const mutation = deferredPromise<LicenseStatusResponseDto>();
      sdkMock.refreshLicense.mockReturnValueOnce(mutation.promise);
      const action = manager.refreshLicense();
      if (change === 'session') {
        authManager.reset();
      } else if (change === 'link') {
        sdkMock.checkInCloud.mockResolvedValueOnce({ ...linked(), account: { id: 'account-2', label: 'New' } });
        await manager.checkIn();
      } else {
        sdkMock.refreshLicense.mockResolvedValueOnce(newLicense);
        await manager.refreshLicense();
      }
      const checks = sdkMock.getCloudBackupLicenceCoverage.mock.calls.length;
      mutation.resolve({ keyHint: 'retired' } as LicenseStatusResponseDto);
      await action;
      expect(manager.license).toEqual(change === 'newer action' ? newLicense : oldLicense);
      expect(sdkMock.getCloudBackupLicenceCoverage).toHaveBeenCalledTimes(checks);
    });

    it.each(['session', 'unlink', 'relink', 'newer action'])('drops background coverage after %s', async (change) => {
      const manager = await ready();
      const coverage = deferredPromise<CloudBackupLicenceCoverageResponseDto>();
      sdkMock.getCloudBackupLicenceCoverage.mockReturnValueOnce(coverage.promise);
      sdkMock.refreshLicense.mockResolvedValue(newLicense);
      await manager.refreshLicense();
      switch (change) {
        case 'session': {
          authManager.reset();
          break;
        }
        case 'unlink': {
          sdkMock.unlinkCloud.mockResolvedValueOnce(status());
          await manager.unlink();
          break;
        }
        case 'relink': {
          sdkMock.checkInCloud.mockResolvedValueOnce({ ...linked(), linkedAt: '2026-11-02T00:00:00Z' });
          await manager.checkIn();
          break;
        }
        default: {
          await manager.refreshLicense();
        }
      }
      coverage.resolve(none);
      await Promise.resolve();
      expect(manager.backupCoverage).toEqual(change === 'session' || change === 'unlink' ? null : all);
    });
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
