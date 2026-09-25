import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/config.js';
import {
  ImmichWorker,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  NotificationLevel,
  NotificationType,
  SystemMetadataKey,
} from 'src/enum.js';
import { CloudMlService } from 'src/services/cloud-ml.service.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const capabilities = {
  protocol: 'frameleaf-cloud-v2' as const,
  region: 'eu',
  workloads: ['enrichment', 'restoration-faithful', 'face', 'teleportation'],
  consent: {
    requiredVersion: '2026-09-25',
    recordedVersion: '2026-09-25',
    features: { identityNames: false, medicalSignals: false, ocrAddon: false },
  },
  entitlement: { active: true },
  wallet: { balanceUsd: 12, heldUsd: 2, dailyCapUsd: null, spentTodayUsd: 0 },
  limits: {},
  catalogEtag: 'etag-1',
};

describe(CloudMlService.name, () => {
  let sut: CloudMlService;
  let mocks: ServiceMocks;
  let metadata: Map<string, unknown>;

  const allBoth = { descriptions: 'both', upscale: 'both', restoration: 'both', studio: 'both', interpolation: 'both' };
  const configure = ({
    cloudMlEnabled = true,
    url = 'https://cloud.test' as string | null,
    routing = allBoth as Record<string, string>,
  } = {}) => {
    mocks.config.getEnv.mockReturnValue({
      ...mocks.config.getEnv(),
      frameleafCloud: { ...mocks.config.getEnv().frameleafCloud, url, identityDir: '/tmp/identity' },
    });
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        (key === SystemMetadataKey.SystemConfig
          ? { frameleafCloud: { cloudMl: { ...defaults.frameleafCloud.cloudMl, enabled: cloudMlEnabled, routing } } }
          : (metadata.get(key) ?? null)) as never,
      ),
    );
  };

  const link = () =>
    metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      status: 'linked',
      cloudUrl: 'https://cloud.test',
      instanceId: 'instance-1',
      dataRegion: 'eu',
    });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(CloudMlService));
    metadata = new Map();
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.systemMetadata.delete.mockImplementation((key) => {
      metadata.delete(key);
      return Promise.resolve();
    });
    mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    mocks.instanceIdentity.loadOrCreate.mockResolvedValue({
      instanceId: 'instance-1',
      kid: 'kid-1',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
      keyFile: '/tmp/identity/instance-key.pem',
      createdAt: '2026-09-25T00:00:00.000Z',
    });
    mocks.frameleafCloud.discovery.mockResolvedValue({
      version: 1,
      validFor: 3600,
      issuer: 'https://id.cloud.test',
      api: 'https://api.cloud.test',
      ml: { eu: 'https://ml.eu.cloud.test' },
    });
    mocks.frameleafCloud.accessToken.mockResolvedValue('ml-token');
    mocks.frameleafCloudMl.ping.mockResolvedValue();
    mocks.frameleafCloudMl.getCapabilities.mockResolvedValue(capabilities);
    mocks.frameleafCloudMl.getHardware.mockResolvedValue({
      providers: ['CUDAExecutionProvider'],
      cudaDeviceCount: 1,
      preferredAcceleration: 'cuda',
    });
    mocks.frameleafCloudMl.getCatalog.mockResolvedValue({
      etag: 'etag-1',
      models: [
        {
          id: 'describe',
          workload: 'enrichment',
          name: 'Describe',
          fingerprint: 'f1',
          description: '',
          pricing: { unit: 'image', usd: 0.002 },
          retired: false,
        },
        {
          // Local only by owner decision (FL-146): never offered even when a catalogue lists it.
          id: 'Qwen/Qwen2.5-VL-3B-Instruct',
          workload: 'enrichment',
          name: 'Qwen2.5-VL 3B',
          fingerprint: 'f3',
          description: '',
          pricing: { unit: 'image', usd: 0.001 },
          retired: false,
        },
        {
          // Local only by owner decision (FL-146): never offered even when a catalogue lists it.
          id: 'nllb-clip-large-siglip__v1',
          workload: 'enrichment',
          name: 'NLLB CLIP',
          fingerprint: 'f2',
          description: '',
          pricing: { unit: 'image', usd: 0.001 },
          retired: false,
        },
        {
          id: 'old',
          workload: 'enrichment',
          name: 'Old',
          fingerprint: 'f0',
          description: '',
          pricing: null,
          retired: true,
        },
      ],
    });
    mocks.frameleafCloudMl.getWallet.mockResolvedValue({
      balanceUsd: 12,
      heldUsd: 2,
      dailyCapUsd: null,
      spentTodayUsd: 0,
      topUpUrl: 'https://account.cloud.test/wallet',
      autoTopUp: false,
    });
    mocks.frameleafCloudMl.getConsent.mockResolvedValue({
      requiredVersion: '2026-10-01',
      recordedVersion: '2026-09-25',
      features: { identityNames: false, medicalSignals: false, ocrAddon: false },
      summary: 'Media is processed in the EU region.',
      documentUrl: null,
    });
    mocks.frameleafCloudMl.getUsage.mockResolvedValue({ items: [] });
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local]);
    mocks.mlDestination.getSpend.mockResolvedValue(0);
    mocks.mlDestination.applySettlements.mockResolvedValue(0);
    mocks.mlDestination.create.mockImplementation((row) =>
      Promise.resolve({ ...mlDestinationStub.frameleafCloud, ...row, id: 'created' } as never),
    );
    configure();
  });

  describe('probe', () => {
    it('refuses without contacting anything while Frameleaf Cloud processing is turned off', async () => {
      configure({ cloudMlEnabled: false });
      link();

      const probe = await sut.probe();

      expect(probe.reachable).toBe(false);
      expect(probe.cloud?.refusal?.refusal).toBe(MlAdmissionRefusal.CloudUnavailable);
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
    });

    it('refuses without contacting anything while the server is not linked', async () => {
      const probe = await sut.probe();

      expect(probe).toMatchObject({ reachable: false, error: 'This server is not linked to a Frameleaf account' });
      expect(probe.cloud?.refusal?.refusal).toBe(MlAdmissionRefusal.CloudUnavailable);
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
    });

    it('reports what the gateway offers, never faces or unknown work, with the facts admission needs', async () => {
      link();

      const probe = await sut.probe();

      expect(probe.reachable).toBe(true);
      expect(probe.workloads).toEqual([MlWorkload.Enrichment, MlWorkload.RestorationFaithful]);
      expect(probe.hardware).toMatchObject({ cudaDeviceCount: 1, torchCudaAvailable: true });
      expect(probe.cloud).toMatchObject({
        region: 'eu',
        entitled: true,
        consentRequiredVersion: '2026-09-25',
        balanceUsd: 12,
        heldUsd: 2,
        modelIds: ['describe'],
        refusal: null,
      });
      expect(metadata.get(SystemMetadataKey.FrameleafMlWallet)).toMatchObject({ balanceUsd: 12, heldUsd: 2 });
      expect(mocks.frameleafCloudMl.getCapabilities).toHaveBeenCalledWith({
        url: 'https://ml.eu.cloud.test',
        bearer: 'ml-token',
      });
    });

    it('serves only the work set to Both or Cloud only in Where each job runs', async () => {
      link();
      configure({ routing: { ...allBoth, restoration: 'local' } });

      const probe = await sut.probe();

      expect(probe.workloads).toEqual([MlWorkload.Enrichment]);
    });

    it('keeps the refusal when the gateway answers but refuses (402)', async () => {
      link();
      mocks.frameleafCloudMl.getCapabilities.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.WalletInsufficient, 402, 'The AI Wallet is empty'),
      );

      const probe = await sut.probe();

      expect(probe).toMatchObject({ reachable: true, workloads: [], error: 'The AI Wallet is empty' });
      expect(probe.cloud?.refusal).toEqual({
        refusal: MlAdmissionRefusal.WalletInsufficient,
        detail: 'The AI Wallet is empty',
      });
    });

    it('reports an unreachable gateway as unavailable', async () => {
      link();
      mocks.frameleafCloudMl.ping.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, null, 'Frameleaf Cloud did not answer'),
      );

      const probe = await sut.probe();

      expect(probe.reachable).toBe(false);
      expect(probe.cloud?.refusal?.refusal).toBe(MlAdmissionRefusal.CloudUnavailable);
    });

    it('reuses a fresh result instead of calling the cloud again', async () => {
      link();
      await sut.probe(10_000);
      await sut.probe(10_000);
      expect(mocks.frameleafCloudMl.getCapabilities).toHaveBeenCalledTimes(1);
    });
  });

  describe('createDestination', () => {
    it('creates the destination with no URL or token, the account region and no consent', async () => {
      link();

      const result = await sut.createDestination({
        name: 'Frameleaf Cloud',
        workloads: [MlWorkload.Enrichment, MlWorkload.RestorationCreative, MlWorkload.Enrichment],
        budgetLimitUsd: 30,
      });

      expect(mocks.mlDestination.create).toHaveBeenCalledWith({
        kind: MlDestinationKind.FrameleafCloud,
        name: 'Frameleaf Cloud',
        url: null,
        authToken: null,
        enabled: true,
        workloads: [MlWorkload.Enrichment, MlWorkload.RestorationCreative],
        budgetLimitUsd: 30,
        maxRuntimeMinutes: null,
        maxUploadBytes: null,
        sharesLibraryHardware: false,
        region: 'eu',
      });
      expect(result).toMatchObject({ url: null, authTokenConfigured: false, consent: { required: true } });
      // Never routed automatically.
      expect(mocks.mlDestination.setRoute).not.toHaveBeenCalled();
    });

    it('refuses faces and local-only work by policy', async () => {
      link();
      await expect(sut.createDestination({ name: 'Cloud', workloads: [MlWorkload.Face] })).rejects.toThrow(
        /stays on this network/,
      );
      expect(mocks.mlDestination.create).not.toHaveBeenCalled();
    });

    it('refuses before the server is configured and linked, and refuses a second destination', async () => {
      configure({ url: null });
      await expect(sut.createDestination({ name: 'Cloud', workloads: [MlWorkload.Enrichment] })).rejects.toThrow(
        /not configured/,
      );
      configure();
      await expect(sut.createDestination({ name: 'Cloud', workloads: [MlWorkload.Enrichment] })).rejects.toThrow(
        /not linked/,
      );
      link();
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.frameleafCloud]);
      await expect(sut.createDestination({ name: 'Cloud', workloads: [MlWorkload.Enrichment] })).rejects.toThrow(
        /already added/,
      );
      expect(mocks.mlDestination.create).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('says Frameleaf Cloud is not configured without contacting anything', async () => {
      configure({ url: null });

      await expect(sut.getStatus()).resolves.toMatchObject({
        connection: 'not-configured',
        enabled: true,
        destination: null,
        consent: null,
        wallet: null,
      });
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
    });

    it('reports the required consent version, flags an outdated consent and reads the wallet', async () => {
      link();
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.frameleafCloudConsented]);

      const status = await sut.getStatus();

      expect(status).toMatchObject({
        connection: 'ready',
        region: 'eu',
        entitled: true,
        destination: { id: mlDestinationStub.frameleafCloudConsented.id, url: null },
        consent: { requiredVersion: '2026-10-01', acceptedVersion: '2026-09-25', outdated: true },
        wallet: { balanceUsd: 12, heldUsd: 2, availableUsd: 10, topUpUrl: 'https://account.cloud.test/wallet' },
      });
      // A read never writes: settlements are applied by the explicit usage refresh only.
      expect(mocks.frameleafCloudMl.getUsage).not.toHaveBeenCalled();
      expect(mocks.mlDestination.applySettlements).not.toHaveBeenCalled();
    });

    it('shows the top-up link only when the cloud returned one', async () => {
      link();
      mocks.frameleafCloudMl.getWallet.mockResolvedValue({
        balanceUsd: 1,
        heldUsd: 0,
        dailyCapUsd: null,
        spentTodayUsd: 0,
        topUpUrl: null,
        autoTopUp: false,
      });

      await expect(sut.getStatus()).resolves.toMatchObject({ wallet: { topUpUrl: null } });
    });
  });

  describe('catalogue, wallet and usage', () => {
    it('lists only models the cloud still offers and may host (never the local-only ones, FL-146)', async () => {
      link();
      await expect(sut.getCatalog()).resolves.toEqual({
        models: [
          {
            id: 'describe',
            workload: MlWorkload.Enrichment,
            name: 'Describe',
            description: '',
            fingerprint: 'f1',
            pricingUnit: 'image',
            priceUsd: 0.002,
          },
        ],
      });
    });

    it('refuses the wallet while the server is not linked', async () => {
      await expect(sut.getWallet()).rejects.toBeInstanceOf(BadRequestException);
    });

    it('applies settlements to the accounting rows of their jobs', async () => {
      link();
      mocks.frameleafCloudMl.getUsage.mockResolvedValue({
        items: [
          {
            jobId: 'job-1',
            clientRef: null,
            settledUsd: 0.42,
            credits: 42,
            settledAt: '2026-09-25T10:00:00Z',
            modelId: 'qwen3.5-9b@1',
            gpuSeconds: 312,
            workers: 1,
            estimateUsd: 0.5,
          },
        ],
      });
      mocks.mlDestination.applySettlements.mockResolvedValue(1);

      await expect(sut.reconcileUsage()).resolves.toEqual({ settled: 1 });
      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledWith([
        { cloudJobId: 'job-1', costUsd: 0.42, credits: 42 },
      ]);
    });
  });

  describe('updateWallet', () => {
    it('changes the daily cap and automatic top-up on the account and caches the answer', async () => {
      link();
      mocks.frameleafCloudMl.updateWallet.mockResolvedValue({
        balanceUsd: 12,
        heldUsd: 2,
        dailyCapUsd: 40,
        spentTodayUsd: 0,
        topUpUrl: null,
        autoTopUp: true,
      });

      await expect(sut.updateWallet({ dailyCapUsd: 40, autoTopUp: true })).resolves.toMatchObject({
        dailyCapUsd: 40,
        autoTopUp: true,
        availableUsd: 10,
      });
      expect(mocks.frameleafCloudMl.updateWallet).toHaveBeenCalledWith(expect.anything(), {
        dailyCapUsd: 40,
        autoTopUp: true,
      });
      expect(metadata.get(SystemMetadataKey.FrameleafMlWallet)).toMatchObject({ dailyCapUsd: 40, autoTopUp: true });
    });

    it('refuses an empty change and refuses while the server is not linked', async () => {
      link();
      await expect(sut.updateWallet({})).rejects.toBeInstanceOf(BadRequestException);
      metadata.clear();
      await expect(sut.updateWallet({ autoTopUp: true })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getSettlements', () => {
    it('lists nothing before the destination is added', async () => {
      await expect(sut.getSettlements()).resolves.toEqual({ items: [] });
      expect(mocks.mlDestination.getSettlements).not.toHaveBeenCalled();
    });

    it("lists the destination's settled charges without contacting the cloud", async () => {
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.frameleafCloud]);
      mocks.mlDestination.getSettlements.mockResolvedValue([
        {
          cloudJobId: 'job-1',
          workload: MlWorkload.Enrichment,
          jobName: 'ImageDescription',
          outcome: 'success',
          costUsd: 0.42,
          credits: 42,
          startedAt: new Date('2026-09-25T09:59:00Z'),
          finishedAt: new Date('2026-09-25T10:00:00Z'),
        },
      ] as never);

      await expect(sut.getSettlements()).resolves.toEqual({
        items: [
          {
            cloudJobId: 'job-1',
            workload: MlWorkload.Enrichment,
            jobName: 'ImageDescription',
            succeeded: true,
            costUsd: 0.42,
            credits: 42,
            finishedAt: '2026-09-25T10:00:00.000Z',
            modelId: null,
            gpuSeconds: null,
            workers: null,
            estimateUsd: null,
          },
        ],
      });
      expect(mocks.mlDestination.getSettlements).toHaveBeenCalledWith(mlDestinationStub.frameleafCloud.id, 50);
      // Not linked: the local rows stand on their own and nothing is asked of the cloud.
      expect(mocks.frameleafCloudMl.getUsage).not.toHaveBeenCalled();

      link();
      mocks.frameleafCloudMl.getUsage.mockResolvedValue({
        items: [
          {
            jobId: 'job-1',
            clientRef: null,
            settledUsd: 0.42,
            credits: 42,
            settledAt: '2026-09-25T10:00:00Z',
            modelId: 'qwen3.5-9b@1',
            gpuSeconds: 312,
            workers: 1,
            estimateUsd: 0.5,
          },
        ],
      });
      await expect(sut.getSettlements()).resolves.toMatchObject({
        items: [{ cloudJobId: 'job-1', modelId: 'qwen3.5-9b@1', gpuSeconds: 312, workers: 1, estimateUsd: 0.5 }],
      });
    });
  });

  describe('bootstrap', () => {
    it('registers the cloud check and tells every administrator once about removed destinations', async () => {
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Api);
      metadata.set(SystemMetadataKey.FrameleafCloudMigrationNotice, {
        removedDestinations: [{ name: 'Cloud GPU', workloads: ['enrichment'] }],
        cancelledOperations: 2,
        revokedRenderWorkers: 1,
        createdAt: '2026-09-25T00:00:00.000Z',
      });
      mocks.user.getList.mockResolvedValue([
        { id: 'admin-1', isAdmin: true, deletedAt: null },
        { id: 'user-1', isAdmin: false, deletedAt: null },
        { id: 'admin-2', isAdmin: true, deletedAt: null },
      ] as never);
      mocks.notification.create.mockResolvedValue({} as never);

      await sut.onBootstrap();

      expect(mocks.machineLearning.setCloudProber).toHaveBeenCalledWith(expect.any(Function));
      expect(mocks.notification.create).toHaveBeenCalledTimes(2);
      const [notice] = mocks.notification.create.mock.calls[0];
      expect(notice).toMatchObject({
        userId: 'admin-1',
        type: NotificationType.SystemMessage,
        level: NotificationLevel.Warning,
        title: 'Cloud processing moved to Frameleaf Cloud',
      });
      expect(notice.description).toContain('Cloud GPU was removed');
      expect(notice.description).toContain('not sent anywhere else');
      expect(notice.description).toContain('2 unfinished jobs stopped');
      expect(notice.description).not.toMatch(/runpod/i);
      expect(metadata.has(SystemMetadataKey.FrameleafCloudMigrationNotice)).toBe(false);
    });

    it('sends nothing when there is no notice or on another worker', async () => {
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Microservices);
      metadata.set(SystemMetadataKey.FrameleafCloudMigrationNotice, {
        removedDestinations: [],
        cancelledOperations: 1,
        createdAt: '2026-09-25T00:00:00.000Z',
      });
      await sut.onBootstrap();
      (mocks.config.getWorker as ReturnType<typeof vi.fn>).mockReturnValue(ImmichWorker.Api);
      metadata.delete(SystemMetadataKey.FrameleafCloudMigrationNotice);
      await sut.onBootstrap();

      expect(mocks.notification.create).not.toHaveBeenCalled();
    });
  });
});
