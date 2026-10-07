import type { FrameleafLicense, FrameleafLicenseClaims } from 'src/types.js';
import { SystemMetadataKey } from 'src/enum.js';
import { ServerService } from 'src/services/server.service.js';
import * as frameleafRemoteAccess from 'src/utils/frameleaf-remote-access.js';
import { UserFactory } from 'test/factories/user.factory.js';
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

  describe('getConnections (FL-165)', () => {
    const CLOUD = 'https://api.frameleaf.cloud';
    const names = {
      cloudUrl: CLOUD,
      instanceId: 'instance-1',
      label: 'u225vlzhsdlhwh4l',
      domain: 'frameleaf.net',
      names: {
        relay: 'r.u225vlzhsdlhwh4l.frameleaf.net',
        lanPattern: '{ipv4}.u225vlzhsdlhwh4l.frameleaf.net',
        ipv6Pattern: '{ipv6}.u225vlzhsdlhwh4l.frameleaf.net',
      },
    };
    const candidates = [
      { kind: 'local', uri: 'https://192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net:2443', relay: false },
      { kind: 'relay', uri: 'https://r.u225vlzhsdlhwh4l.frameleaf.net', relay: true },
    ];
    const RELAY_CONNECTED = { connected: true };
    const setup = (
      remoteAccess: Record<string, unknown>,
      updatedAt = new Date().toISOString(),
      relay: { connected: boolean } = RELAY_CONNECTED,
    ) => {
      const env = mockEnvData({});
      mocks.config.getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url: CLOUD } });
      const metadata = new Map<string, unknown>([
        [SystemMetadataKey.FrameleafCloudLink, { status: 'linked', cloudUrl: CLOUD, instanceId: 'instance-1' }],
        [SystemMetadataKey.SystemConfig, { frameleafCloud: { remoteAccess } }],
        [SystemMetadataKey.FrameleafRemoteAccess, { status: 'ready', updatedAt, names, candidates, relay }],
      ]);
      mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
    };

    // FL-229: no cloud-reported local candidate exists in either case below, so a signed-in
    // caller still gets the plain-HTTP fallback for this server's own detected LAN addresses,
    // rather than an empty list.
    const local = {
      kind: 'local',
      uri: 'http://192.168.1.20:2283',
      protocol: 'http',
      address: '192.168.1.20',
      port: 2283,
      local: true,
      relay: false,
      ipv6: false,
      custom: false,
      dnsRebindingProtection: false,
      httpsRequired: false,
      verified: false,
    };

    beforeEach(() => {
      // detectHostAddresses is called cross-module from server.service.ts, so spying on it here
      // takes effect (unlike its own internal helpers, which it calls locally and a same-module spy
      // can't redirect) - stand in for "this host's one LAN interface is 192.168.1.20".
      vi.spyOn(frameleafRemoteAccess, 'detectHostAddresses').mockReturnValue({
        lanAddresses: ['192.168.1.20'],
        ipv6Addresses: [],
      });
    });

    it('falls back to this server’s own LAN address while remote access is off or the server is unlinked', async () => {
      setup({ enabled: false });
      await expect(sut.getConnections()).resolves.toEqual({
        instanceId: 'instance-1',
        publicUrl: null,
        connections: [local],
      });
      mocks.systemMetadata.get.mockResolvedValue(null as never);
      await expect(sut.getConnections()).resolves.toEqual({ instanceId: null, publicUrl: null, connections: [local] });
    });

    it('publishes the Frameleaf address and the candidates the edge worker reported', async () => {
      setup({ enabled: true });
      await expect(sut.getConnections()).resolves.toEqual({
        instanceId: 'instance-1',
        publicUrl: 'https://r.u225vlzhsdlhwh4l.frameleaf.net',
        connections: candidates,
      });
      await expect(sut.getSystemConfig()).resolves.toMatchObject({
        frameleaf: { publicUrl: 'https://r.u225vlzhsdlhwh4l.frameleaf.net' },
      });
    });

    it('publishes the verified custom hostname when Use my domain is chosen', async () => {
      setup({
        enabled: true,
        publicUrl: 'custom',
        customHostname: { host: 'photos.example.com', status: 'verified', checkedAt: null },
      });
      await expect(sut.getConnections()).resolves.toMatchObject({ publicUrl: 'https://photos.example.com' });
    });

    it('publishes no relay address and no relay candidate until the relay is connected', async () => {
      setup({ enabled: true }, new Date().toISOString(), { connected: false });
      await expect(sut.getConnections()).resolves.toEqual({
        instanceId: 'instance-1',
        publicUrl: null,
        connections: [candidates[0]],
      });
    });

    it('falls back to this server’s own LAN address once the edge worker stops reporting (FL-229)', async () => {
      setup({ enabled: true }, new Date(Date.now() - 5 * 60 * 1000).toISOString());
      await expect(sut.getConnections()).resolves.toMatchObject({ publicUrl: null, connections: [local] });
    });
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

  describe('ping (FL-229)', () => {
    const setupPing = (options: {
      linked?: boolean;
      instanceId?: string | null;
      serverName?: string;
      storedServerId?: { id: string; createdAt: string } | null;
    }) => {
      const env = mockEnvData({});
      mocks.config.getEnv.mockReturnValue({
        ...env,
        frameleafCloud: { ...env.frameleafCloud, url: 'https://api.frameleaf.cloud' },
      });
      const metadata = new Map<string, unknown>([
        [
          SystemMetadataKey.FrameleafCloudLink,
          options.linked
            ? {
                status: 'linked',
                cloudUrl: 'https://api.frameleaf.cloud',
                instanceId: options.instanceId ?? 'instance-1',
              }
            : null,
        ],
        [SystemMetadataKey.SystemConfig, { server: { name: options.serverName ?? '' } }],
        [SystemMetadataKey.FrameleafServerId, options.storedServerId ?? null],
      ]);
      mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve((metadata.get(key) ?? null) as never));
      mocks.systemMetadata.set.mockImplementation((key, value, overwrite = true) => {
        if (overwrite || !metadata.get(key)) {
          metadata.set(key, value);
        }
        return Promise.resolve();
      });
    };

    it('reports whether the server still needs setting up and can link, never the setup code (FL-292)', async () => {
      setupPing({ linked: false });
      mocks.user.getAdmin.mockResolvedValue(void 0);
      const needed = await sut.ping();
      expect(needed).toMatchObject({ setup: 'needed', cloud: expect.stringMatching(/^(available|unavailable)$/) });
      expect(JSON.stringify(needed)).not.toMatch(/code/i);
      mocks.user.getAdmin.mockResolvedValue(UserFactory.create({ isAdmin: true }) as never);
      await expect(sut.ping()).resolves.toMatchObject({ setup: 'complete' });
    });

    it('returns the Frameleaf Cloud instance id, marked linked, while linked', async () => {
      setupPing({ linked: true, instanceId: 'instance-1', serverName: 'My Home Server' });
      await expect(sut.ping()).resolves.toMatchObject({
        res: 'pong',
        id: 'instance-1',
        linked: true,
        name: 'My Home Server',
      });
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('creates and persists a stable local id on the first ping while unlinked', async () => {
      setupPing({ linked: false });
      const first = await sut.ping();
      expect(first.linked).toBe(false);
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(
        SystemMetadataKey.FrameleafServerId,
        expect.objectContaining({ id: first.id }),
        false,
      );
    });

    it('reuses the stored local id on later pings, never regenerating it', async () => {
      setupPing({ linked: false, storedServerId: { id: 'stored-id-1', createdAt: '2026-01-01T00:00:00.000Z' } });
      await expect(sut.ping()).resolves.toMatchObject({
        res: 'pong',
        id: 'stored-id-1',
        linked: false,
        name: 'Frameleaf server',
      });
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('falls back to a default display name when none is set', async () => {
      setupPing({ linked: false, storedServerId: { id: 'stored-id-1', createdAt: '2026-01-01T00:00:00.000Z' } });
      await expect(sut.ping()).resolves.toMatchObject({ name: 'Frameleaf server' });
    });
  });

  describe('getFeatures', () => {
    it('should respond the server features', async () => {
      await expect(sut.getFeatures()).resolves.toEqual({
        imageCapabilities: {
          experimentalEnabled: false,
          qualified: false,
          renderer: null,
          codecs: {},
          decode: [],
          render: [],
          export: [],
          unavailable: ['apple-gain-map-heic', 'iso-adaptive-heif', 'hdr-heic'],
        },
        smartSearch: true,
        askSearch: true,
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
        physicalDeduplication: true,
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

    it('reports installed decoders independently from render, export and qualification', async () => {
      mocks.media.getHdrCodecCapabilities.mockResolvedValue({
        libheif: '1.23.3',
        libultrahdr: '2.0.2',
        heicDecoder: true,
        avifDecoder: false,
      });
      const features = await sut.getFeatures();
      expect(features.imageCapabilities).toMatchObject({
        qualified: false,
        renderer: 'frameleaf-develop-hdr/1',
        decode: ['gain-map-jpeg', 'sdr-heic', 'pq-heic', 'hlg-heic'],
        render: ['linear-hdr-develop'],
        export: ['sdr-jpeg', 'hdr-jpeg'],
        unavailable: ['apple-gain-map-heic', 'iso-adaptive-heif', 'hdr-heic'],
      });
      mocks.media.getHdrCodecCapabilities.mockRejectedValue(new Error('worker unavailable'));
      await expect(sut.getFeatures()).resolves.toMatchObject({
        imageCapabilities: { renderer: null, decode: [], export: [] },
      });
    });
    it.each([true, false])(
      'offers experimental Apple reconstruction only with HEVC support (%s)',
      async (heicDecoder) => {
        mocks.media.getHdrCodecCapabilities.mockResolvedValue({
          libheif: '1.23.3',
          libultrahdr: '2.0.2',
          heicDecoder,
          avifDecoder: false,
          appleGainMapDecoder: true,
        });
        const { imageCapabilities } = await sut.getFeatures();
        expect(imageCapabilities?.qualified).toBe(false);
        expect(imageCapabilities?.decode.includes('apple-gain-map-heic')).toBe(heicDecoder);
        expect(imageCapabilities?.unavailable.includes('apple-gain-map-heic')).toBe(!heicDecoder);
      },
    );
    it('reports ISO decoding and the exact new renderer without claiming ISO HEIF encoding', async () => {
      mocks.media.getHdrCodecCapabilities.mockResolvedValue({
        libheif: '1.23.3',
        libultrahdr: '2.0.2',
        heicDecoder: true,
        avifDecoder: true,
        isoGainMapDecoder: true,
        renderer: 'frameleaf-develop-hdr/2',
      });
      const { imageCapabilities } = await sut.getFeatures();
      expect(imageCapabilities).toMatchObject({
        qualified: false,
        renderer: 'frameleaf-develop-hdr/2',
        export: ['sdr-jpeg', 'hdr-jpeg'],
      });
      expect(imageCapabilities?.decode).toContain('iso-adaptive-heif');
      expect(imageCapabilities?.export).not.toContain('iso-adaptive-heif');
    });
    it('offers HDR HEIC only after the admitted codec verifies ten-bit PQ output', async () => {
      mocks.media.getHdrCodecCapabilities.mockResolvedValue({
        libheif: '1.23.3',
        libultrahdr: '2.0.2',
        heicDecoder: true,
        avifDecoder: false,
        heicPqEncoder: true,
      });
      expect((await sut.getFeatures()).imageCapabilities).toMatchObject({
        qualified: false,
        export: ['sdr-jpeg', 'hdr-jpeg', 'hdr-heic'],
        unavailable: ['apple-gain-map-heic', 'iso-adaptive-heif'],
      });
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
        mapDarkStyleUrl: 'https://tiles.frameleaf.cloud/v1/style/dark.json',
        mapLightStyleUrl: 'https://tiles.frameleaf.cloud/v1/style/light.json',
        maintenanceMode: false,
        minFaces: 3,
        frameleaf: {
          via: null,
          cloudConfigured: false,
          signInAvailable: false,
          signInRequired: false,
          publicUrl: null,
        },
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

    it('says how a request arrived and what remote access asks of it (FL-161)', async () => {
      const env = mockEnvData({});
      mocks.config.getEnv.mockReturnValue({
        ...env,
        frameleafCloud: { ...env.frameleafCloud, url: 'https://api.frameleaf.cloud' },
      });
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          (key === SystemMetadataKey.FrameleafCloudLink
            ? {
                status: 'linked',
                cloudUrl: 'https://api.frameleaf.cloud',
                instanceId: 'instance-1',
                oidc: { issuer: 'https://id.frameleaf.cloud', clientId: 'instance-1' },
                services: {
                  relayOrigin: 'https://r.k3v9.frameleaf.net',
                  publicUrl: 'https://photos.example.com/',
                },
              }
            : null) as never,
        ),
      );

      await expect(sut.getSystemConfig('relay')).resolves.toMatchObject({
        frameleaf: {
          via: 'relay',
          // FL-168: the deployment names Frameleaf Cloud, so setup can offer to link
          cloudConfigured: true,
          signInAvailable: true,
          signInRequired: true,
          publicUrl: 'https://photos.example.com',
        },
      });
      await expect(sut.getSystemConfig('lan')).resolves.toMatchObject({
        frameleaf: { via: 'lan', signInRequired: false },
      });
      await expect(sut.getSystemConfig()).resolves.toMatchObject({
        frameleaf: { via: null, signInRequired: false },
      });
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
