import { AssetType } from 'src/enum.js';
import { ICloudScheduledWorkerService } from 'src/services/icloud-scheduled-worker.service.js';

describe('scheduled iCloud publication descriptor settlement', () => {
  it.each([
    ['match', false],
    ['mismatch', false],
    ['match', true],
    ['mismatch', true],
  ] as const)('settles every %s descriptor before completion (release failure: %s)', async (outcome, failedRelease) => {
    vi.stubEnv('FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION', 'true');
    const expectedSha256 = Buffer.alloc(32, 1);
    const verified = { sha256: outcome === 'match' ? expectedSha256 : Buffer.alloc(32, 2) };
    const entered = Promise.withResolvers<void>();
    const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let held = 0;
    const files = releases.map((release) => ({
      release: vi.fn(() => {
        entered.resolve();
        return release.promise;
      }),
      paths: [],
      current: () => Promise.resolve(true),
      validation: {},
    }));
    const repository = {
      dispatch: vi.fn().mockResolvedValue([{ id: 'audit', result: 'pending' }]),
      stopState: vi.fn().mockResolvedValue({ live: true }),
      check: vi
        .fn()
        .mockResolvedValue({ source: { sourceAssetId: 'cpl-asset' }, request: { expectedSha256 }, private: true }),
      bindClaim: vi.fn().mockResolvedValue(true),
      allocate: vi.fn().mockResolvedValue({ id: 'resource', leaseToken: 'lease', source: { type: AssetType.Image } }),
      publishMatch: vi.fn().mockResolvedValue(true),
      settleUnavailable: vi.fn().mockResolvedValue(undefined),
    };
    const identities = {
      claim: vi.fn().mockResolvedValue([{ id: 'item-claim', holder: 'icloud-sync:audit:operation' }]),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const staging = {
      download: vi.fn().mockResolvedValue({ payload: { path: '/owned-fixture' } }),
      validate: vi.fn().mockResolvedValue({
        result: Promise.resolve({ status: 'validated', verified, validation: {} }),
        settled: Promise.resolve(),
      }),
      holdPublicationFiles: vi.fn(() => Promise.resolve(files[held++])),
      cleanupRetired: vi.fn().mockResolvedValue(undefined),
    };
    const recovery = {
      reconcile: vi.fn(async (input) => {
        await input.scheduledValidate('/owned-fixture-one');
        await input.scheduledValidate('/owned-fixture-two');
        return { outcome: 'imported' };
      }),
    };
    const operations = {
      reportProgress: vi.fn().mockResolvedValue(true),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(undefined),
    };
    const sut = new ICloudScheduledWorkerService(
      repository as never,
      identities as never,
      staging as never,
      recovery as never,
      operations as never,
      { enabled: () => true } as never,
    );
    const running = sut.run({ id: 'operation', ownerId: 'owner' } as never, 'claim-token');
    try {
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(operations.complete).not.toHaveBeenCalled();
      expect(identities.release).not.toHaveBeenCalled();
      if (outcome === 'mismatch') {
        expect(files[1].release).toHaveBeenCalledOnce();
        if (failedRelease) releases[0].reject(new Error('controlled private descriptor release failure'));
        else releases[0].resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(operations.complete).not.toHaveBeenCalled();
      }
    } finally {
      if (failedRelease) releases[0].reject(new Error('controlled private descriptor release failure'));
      for (const release of releases) release.resolve();
      await running;
      vi.unstubAllEnvs();
    }
    if (failedRelease) {
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        'operation',
        'claim-token',
        { error: 'iCloud audit did not complete', errorCode: 'icloud_audit_unavailable' },
        { retry: false },
      );
    } else {
      expect(operations.complete).toHaveBeenCalledOnce();
      expect(operations.fail).not.toHaveBeenCalled();
    }
    expect(identities.release).toHaveBeenCalledOnce();
  });
});
