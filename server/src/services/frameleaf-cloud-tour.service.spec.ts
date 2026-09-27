import { SystemMetadataKey, UserMetadataKey } from 'src/enum.js';
import { FrameleafCloudTourService } from 'src/services/frameleaf-cloud-tour.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const CLOUD_URL = 'https://cloud.frameleaf.test';

describe(FrameleafCloudTourService.name, () => {
  let sut: FrameleafCloudTourService;
  let mocks: ServiceMocks;
  let metadata: Record<string, unknown>;
  let userMetadata: Array<{ key: UserMetadataKey; value: unknown }>;

  const linked = () => {
    metadata[SystemMetadataKey.FrameleafCloudLink] = {
      cloudUrl: CLOUD_URL,
      status: 'linked',
      instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55',
    };
  };

  beforeEach(() => {
    clearConfigCache();
    ({ sut, mocks } = newTestService(FrameleafCloudTourService));
    metadata = {};
    userMetadata = [];
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata[key] ?? null) as never));
    mocks.config.getEnv.mockReturnValue(
      mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, url: CLOUD_URL } }),
    );
    mocks.user.getMetadata.mockImplementation(() => Promise.resolve(userMetadata as never));
    mocks.user.upsertMetadata.mockImplementation((_userId, item) => {
      userMetadata.push(item as never);
      return Promise.resolve();
    });
  });

  it('offers the tour to an administrator who has not seen it once the server is linked', async () => {
    await expect(sut.getTour(authStub.admin)).resolves.toMatchObject({ seen: false, offer: false });
    linked();
    await expect(sut.getTour(authStub.admin)).resolves.toMatchObject({
      seen: false,
      seenAt: null,
      ending: null,
      offer: true,
    });
  });

  it('does not offer it for a link made against another Frameleaf Cloud address', async () => {
    linked();
    mocks.config.getEnv.mockReturnValue(
      mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, url: 'https://other.test' } }),
    );
    await expect(sut.getTour(authStub.admin)).resolves.toMatchObject({ offer: false });
  });

  it('keeps the first ending per account and stops offering it', async () => {
    linked();
    const first = await sut.markSeen(authStub.admin, { ending: 'skipped' });
    expect(first).toMatchObject({ seen: true, ending: 'skipped', offer: false });
    expect(first.seenAt).toEqual(expect.any(String));
    expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(authStub.admin.user.id, {
      key: UserMetadataKey.FrameleafCloudTour,
      value: { seenAt: expect.any(String), ending: 'skipped' },
    });

    await expect(sut.markSeen(authStub.admin, { ending: 'finished' })).resolves.toMatchObject({ ending: 'skipped' });
    expect(mocks.user.upsertMetadata).toHaveBeenCalledTimes(1);
  });

  it('records setup as the ending when the server was linked during first-run setup', async () => {
    await expect(sut.markSeen(authStub.admin, { ending: 'setup' })).resolves.toMatchObject({
      seen: true,
      ending: 'setup',
    });
    linked();
    await expect(sut.getTour(authStub.admin)).resolves.toMatchObject({ offer: false });
  });

  it('reads the status chips from this server only', async () => {
    linked();
    metadata[SystemMetadataKey.SystemConfig] = {
      frameleafCloud: {
        remoteAccess: { customHostname: { host: 'photos.example.com', status: 'verified', checkedAt: null } },
        cloudMl: { enabled: true },
        cloudBackup: { enabled: true, target: 'managed' },
      },
    };
    metadata[SystemMetadataKey.FrameleafMlWallet] = { balanceUsd: 12.5, heldUsd: 2.25 };
    metadata[SystemMetadataKey.FrameleafCloudBackup] = { target: 'managed' };

    await expect(sut.getTour(authStub.admin)).resolves.toMatchObject({
      customHostnameVerified: true,
      processingEnabled: true,
      walletAvailableUsd: 10.25,
      backupConfigured: true,
    });
  });

  it('reports nothing set up, and no wallet read, on a fresh link', async () => {
    linked();
    await expect(sut.getTour(authStub.admin)).resolves.toMatchObject({
      customHostnameVerified: false,
      processingEnabled: false,
      walletAvailableUsd: null,
      backupConfigured: false,
    });
  });
});
