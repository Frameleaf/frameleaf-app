import type { FrameleafLicense, FrameleafLicenseClaims } from 'src/types.js';
import { SystemMetadataKey } from 'src/enum.js';
import { ServerService } from 'src/services/server.service.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/** A stored licence certificate for specs (FL-156); only the claims matter to the state. */
const license = (claims: Partial<FrameleafLicenseClaims>, iat: number): FrameleafLicense => ({
  certificate: 'x.y.z',
  kind: claims.lic ? 'server' : 'plan',
  source: 'account',
  kid: 'kid-1',
  claims: {
    iss: 'https://id.cloud.test',
    aud: 'frameleaf-server',
    sub: 'account-1',
    iid: 'instance-1',
    ent: [],
    lic_exp: null,
    iat,
    exp: iat + 7 * 86_400,
    ...claims,
  },
  verifiedAt: new Date(iat * 1000).toISOString(),
});

describe(ServerService.name, () => {
  let sut: ServerService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ServerService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getStorage', () => {
    it('should return the disk space as B', async () => {
      mocks.storage.checkDiskUsage.mockResolvedValue({ free: 200, available: 300, total: 500 });

      await expect(sut.getStorage()).resolves.toEqual({
        diskAvailable: '300 B',
        diskAvailableRaw: 300,
        diskSize: '500 B',
        diskSizeRaw: 500,
        diskUsagePercentage: 60,
        diskUse: '300 B',
        diskUseRaw: 300,
      });

      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
    });

    it('should return the disk space as KiB', async () => {
      mocks.storage.checkDiskUsage.mockResolvedValue({ free: 200_000, available: 300_000, total: 500_000 });

      await expect(sut.getStorage()).resolves.toEqual({
        diskAvailable: '293.0 KiB',
        diskAvailableRaw: 300_000,
        diskSize: '488.3 KiB',
        diskSizeRaw: 500_000,
        diskUsagePercentage: 60,
        diskUse: '293.0 KiB',
        diskUseRaw: 300_000,
      });

      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
    });

    it('should return the disk space as MiB', async () => {
      mocks.storage.checkDiskUsage.mockResolvedValue({ free: 200_000_000, available: 300_000_000, total: 500_000_000 });

      await expect(sut.getStorage()).resolves.toEqual({
        diskAvailable: '286.1 MiB',
        diskAvailableRaw: 300_000_000,
        diskSize: '476.8 MiB',
        diskSizeRaw: 500_000_000,
        diskUsagePercentage: 60,
        diskUse: '286.1 MiB',
        diskUseRaw: 300_000_000,
      });

      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
    });

    it('should return the disk space as GiB', async () => {
      mocks.storage.checkDiskUsage.mockResolvedValue({
        free: 200_000_000_000,
        available: 300_000_000_000,
        total: 500_000_000_000,
      });

      await expect(sut.getStorage()).resolves.toEqual({
        diskAvailable: '279.4 GiB',
        diskAvailableRaw: 300_000_000_000,
        diskSize: '465.7 GiB',
        diskSizeRaw: 500_000_000_000,
        diskUsagePercentage: 60,
        diskUse: '279.4 GiB',
        diskUseRaw: 300_000_000_000,
      });

      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
    });

    it('should return the disk space as TiB', async () => {
      mocks.storage.checkDiskUsage.mockResolvedValue({
        free: 200_000_000_000_000,
        available: 300_000_000_000_000,
        total: 500_000_000_000_000,
      });

      await expect(sut.getStorage()).resolves.toEqual({
        diskAvailable: '272.8 TiB',
        diskAvailableRaw: 300_000_000_000_000,
        diskSize: '454.7 TiB',
        diskSizeRaw: 500_000_000_000_000,
        diskUsagePercentage: 60,
        diskUse: '272.8 TiB',
        diskUseRaw: 300_000_000_000_000,
      });

      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
    });

    it('should return the disk space as PiB', async () => {
      mocks.storage.checkDiskUsage.mockResolvedValue({
        free: 200_000_000_000_000_000,
        available: 300_000_000_000_000_000,
        total: 500_000_000_000_000_000,
      });

      await expect(sut.getStorage()).resolves.toEqual({
        diskAvailable: '266.5 PiB',
        diskAvailableRaw: 300_000_000_000_000_000,
        diskSize: '444.1 PiB',
        diskSizeRaw: 500_000_000_000_000_000,
        diskUsagePercentage: 60,
        diskUse: '266.5 PiB',
        diskUseRaw: 300_000_000_000_000_000,
      });

      expect(mocks.storage.checkDiskUsage).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
    });
  });

  describe('app releases', () => {
    const android = {
      releaseUrl: 'https://releases.example.test/{version}',
      appId: 'app.frameleaf.android',
      signingSha256: `${'AB:'.repeat(31)}AB`,
    };

    it('reports both apps unavailable when no destination is configured', () => {
      expect(sut.getAppReleases()).toEqual({ android: { available: false }, ios: { available: false } });
    });

    it('never links another product when no Android destination is configured', () => {
      expect(() => sut.getApkLinks()).toThrow('No signed Android release is configured for this server');
    });

    it('offers the configured signed destinations', () => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ appReleases: { android, iosUrl: 'https://apps.apple.com/app/id000' } }),
      );

      const releases = sut.getAppReleases();
      expect(releases).toMatchObject({
        android: { available: true, appId: android.appId, signingCertificateSha256: android.signingSha256 },
        ios: { available: true, url: 'https://apps.apple.com/app/id000' },
      });
      expect(releases.android.links?.universal).toMatch(
        /^https:\/\/releases\.example\.test\/\d+\.\d+\.\d+\/app-release\.apk$/,
      );
      expect(sut.getApkLinks()).toEqual(releases.android.links);
      expect(JSON.stringify(releases)).not.toContain('immich');
    });

    it('offers the Android store listing when one is configured (FL-135)', () => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ appReleases: { androidStoreUrl: 'https://f-droid.example/app' } }),
      );

      expect(sut.getAppReleases().android).toEqual({ available: false, storeUrl: 'https://f-droid.example/app' });
    });
  });

  describe('getAboutInfo', () => {
    it('is licensed while a licence is active or in grace, and not once it expired (FL-156)', async () => {
      mocks.serverInfo.getBuildVersions.mockResolvedValue({} as never);
      const now = Math.floor(Date.now() / 1000);
      const active = { key: null, plan: license({ ent: ['CLOUD'], lic_exp: now + 60 }, now) };
      const grace = { key: null, plan: license({ ent: ['CLOUD'], lic_exp: now - 60, grace_days: 7 }, now - 86_400) };
      const expired = {
        key: null,
        plan: license({ ent: ['CLOUD'], lic_exp: now - 30 * 86_400, grace_days: 7 }, now - 31 * 86_400),
      };

      for (const [store, licensed] of [
        [null, false],
        [active, true],
        [grace, true],
        [expired, false],
      ] as const) {
        mocks.systemMetadata.get.mockImplementation((key) =>
          Promise.resolve((key === SystemMetadataKey.FrameleafLicense ? store : null) as never),
        );
        await expect(sut.getAboutInfo()).resolves.toMatchObject({ licensed });
      }
    });

    it('links the version to its Frameleaf release notes', async () => {
      mocks.serverInfo.getBuildVersions.mockResolvedValue({} as never);
      mocks.systemMetadata.get.mockResolvedValue(null);

      const about = await sut.getAboutInfo();

      expect(about.versionUrl).toBe(
        `https://github.com/Frameleaf/frameleaf-app/releases?q=frameleaf-${about.version}&expanded=true`,
      );
      expect(about.version).toMatch(/^v\d+\.\d+\.\d+/);
      expect(about.versionUrl).not.toContain('immich-app');
    });
  });

  describe('ping', () => {
    it('should respond with pong', () => {
      expect(sut.ping()).toEqual({ res: 'pong' });
    });
  });

  describe('getFeatures', () => {
    it('should respond the server features', async () => {
      await expect(sut.getFeatures()).resolves.toEqual({
        smartSearch: true,
        duplicateDetection: true,
        facialRecognition: true,
        importFaces: false,
        map: true,
        reverseGeocoding: true,
        oauth: false,
        oauthAutoLaunch: false,
        ocr: true,
        imageDescription: true,
        nsfwDetection: false,
        nsfwHiding: false,
        passwordLogin: true,
        physicalDeduplication: false,
        search: true,
        sidecar: true,
        configFile: false,
        trash: true,
        email: false,
        realtimeTranscoding: false,
        frameleafCloud: false,
        remoteAccess: false,
        cloudMl: false,
        cloudBackup: false,
        supporter: false,
      });
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('reports cloud entitlements only while linked, and the supporter flag from the licence (FL-156)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const store = {
        key: license({ ent: ['SUPPORTER_SERVER'], lic_exp: null, lic: { last4: 'J58U', kind: 'server' } }, now),
        plan: license({ ent: ['CLOUD', 'REMOTE_ACCESS', 'CLOUD_BACKUP', 'CLOUD_ML'], lic_exp: now + 86_400 }, now),
      };
      mocks.config.getEnv.mockReturnValue({
        ...mocks.config.getEnv(),
        frameleafCloud: { ...mocks.config.getEnv().frameleafCloud, url: 'https://cloud.test' },
      });
      const metadata = new Map<string, unknown>([[SystemMetadataKey.FrameleafLicense, store]]);
      mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));

      await expect(sut.getFeatures()).resolves.toMatchObject({
        frameleafCloud: false,
        remoteAccess: false,
        cloudMl: false,
        cloudBackup: false,
        supporter: true,
      });

      metadata.set(SystemMetadataKey.FrameleafCloudLink, {
        status: 'linked',
        cloudUrl: 'https://cloud.test',
        instanceId: 'instance-1',
      });
      await expect(sut.getFeatures()).resolves.toMatchObject({
        frameleafCloud: true,
        remoteAccess: true,
        cloudMl: true,
        cloudBackup: true,
        supporter: true,
      });
    });
  });

  describe('getSystemConfig', () => {
    it('reports the server name an administrator set (FL-71 CC-4)', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ server: { name: 'Home archive' } });

      await expect(sut.getSystemConfig()).resolves.toEqual(expect.objectContaining({ serverName: 'Home archive' }));
    });

    it('should respond the server configuration', async () => {
      const result = await sut.getSystemConfig();
      const { defaultImageDescriptionRawPromptTemplate, ...rest } = result;
      expect(rest).toEqual({
        loginPageMessage: '',
        serverName: '',
        oauthButtonText: 'Login with OAuth',
        oauthAccountManagementUrl: '',
        trashDays: 30,
        userDeleteDelay: 7,
        isInitialized: false,
        isOnboarded: false,
        externalDomain: '',
        publicUsers: true,
        mapDarkStyleUrl: 'https://tiles.immich.cloud/v1/style/dark.json',
        mapLightStyleUrl: 'https://tiles.immich.cloud/v1/style/light.json',
        maintenanceMode: false,
        minFaces: 3,
      });
      expect(defaultImageDescriptionRawPromptTemplate).toContain('{schema}');
      expect(defaultImageDescriptionRawPromptTemplate).toContain('{names}');
      expect(defaultImageDescriptionRawPromptTemplate).toContain('{style_hint}');
      expect(defaultImageDescriptionRawPromptTemplate).toContain('{vocabulary}');
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('should be initialized once an admin exists', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);

      await expect(sut.getSystemConfig()).resolves.toMatchObject({ isInitialized: true });
    });

    it('should be initialized when setup is disabled', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ setup: { allow: false } }));
      mocks.user.hasAdmin.mockResolvedValue(false);

      await expect(sut.getSystemConfig()).resolves.toMatchObject({ isInitialized: true });
    });
  });

  describe('getStats', () => {
    it('should total up usage by user', async () => {
      mocks.user.getUserStats.mockResolvedValue([
        {
          userId: 'user1',
          userName: '1 User',
          photos: 10,
          videos: 11,
          usage: 12_345,
          usagePhotos: 1,
          usageVideos: 11_345,
          quotaSizeInBytes: 0,
        },
        {
          userId: 'user2',
          userName: '2 User',
          photos: 10,
          videos: 20,
          usage: 123_456,
          usagePhotos: 100,
          usageVideos: 23_456,
          quotaSizeInBytes: 0,
        },
        {
          userId: 'user3',
          userName: '3 User',
          photos: 100,
          videos: 0,
          usage: 987_654,
          usagePhotos: 900,
          usageVideos: 87_654,
          quotaSizeInBytes: 0,
        },
      ]);

      await expect(sut.getStatistics()).resolves.toEqual({
        photos: 120,
        videos: 31,
        usage: 1_123_455,
        usagePhotos: 1001,
        usageVideos: 122_455,
        usageByUser: [
          {
            photos: 10,
            quotaSizeInBytes: 0,
            usage: 12_345,
            usagePhotos: 1,
            usageVideos: 11_345,
            userName: '1 User',
            userId: 'user1',
            videos: 11,
          },
          {
            photos: 10,
            quotaSizeInBytes: 0,
            usage: 123_456,
            usagePhotos: 100,
            usageVideos: 23_456,
            userName: '2 User',
            userId: 'user2',
            videos: 20,
          },
          {
            photos: 100,
            quotaSizeInBytes: 0,
            usage: 987_654,
            usagePhotos: 900,
            usageVideos: 87_654,
            userName: '3 User',
            userId: 'user3',
            videos: 0,
          },
        ],
      });

      expect(mocks.user.getUserStats).toHaveBeenCalled();
    });
  });
});
