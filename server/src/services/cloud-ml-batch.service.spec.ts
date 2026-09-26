import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { MediaOperation } from 'src/repositories/media-operation.repository.js';
import type { CloudDescriptionEstimateRecord } from 'src/utils/cloud-description-batch.js';
import type { CloudProbeFacts } from 'src/utils/frameleaf-cloud.js';
import { defaults } from 'src/config.js';
import {
  AssetStatus,
  AssetType,
  AssetVisibility,
  DatabaseLock,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  NotificationLevel,
  NotificationType,
  SystemMetadataKey,
} from 'src/enum.js';
import { CloudMlBatchService } from 'src/services/cloud-ml-batch.service.js';
import {
  CLOUD_DESCRIPTION_CONTRACT,
  CLOUD_DESCRIPTION_POLL_MS,
  CLOUD_DESCRIPTION_UPLOADS_UNPUBLISHED,
  CloudDescriptionPhase,
  emptyCloudDescriptionResult,
  nextServerDay,
  serverDayStart,
} from 'src/utils/cloud-description-batch.js';
import {
  FrameleafCloudError,
  catalogSchema,
  estimateResponseSchema,
  jobAdmittedSchema,
  jobCreateRequestSchema,
} from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const identitySigner = {
  kid: 'kid-1',
  publicJwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: 'x' },
  sign: () => 'header.payload.signature',
};

type CatalogFixture = { etag: string | null; models: Array<Record<string, unknown>> };
const descriptionsFixture = cloudContractFixture<CatalogFixture>('ml/catalog-descriptions.json');
/** The gateway's descriptions catalogue: ms_NME7RZQ1 (light) and ms_K6WT70CS (the default). */
const catalog = catalogSchema.parse(descriptionsFixture);
const DEFAULT_SKU = 'ms_K6WT70CS';

/** The gateway's sealed estimate (two photos: p50 0.021, p90 0.024, start fee 0.02, hold 0.05). */
const sealed = estimateResponseSchema.parse(cloudContractFixture<Record<string, unknown>>('ml/estimate-response.json'));
const admitted = jobAdmittedSchema.parse(cloudContractFixture<Record<string, unknown>>('ml/job-admitted.json'));
/** Before the fixture estimate's `expiresAt` (04:15). */
const now = new Date('2026-09-26T04:05:00.000Z');
const BATCH_ID = '0192f1b0-0000-7000-8000-000000000001';
const KEY_1 = 'desc-0192f1b0000070008000000000000001-1';

const facts: CloudProbeFacts = {
  ...mlDestinationStub.frameleafCloudConsented.lastProbeCloud!,
  modelIds: ['ms_NME7RZQ1', DEFAULT_SKU],
  modelWorkloads: { ms_NME7RZQ1: MlWorkload.Enrichment, [DEFAULT_SKU]: MlWorkload.Enrichment },
  defaultModels: { descriptions: DEFAULT_SKU },
  modelGroups: { ms_NME7RZQ1: 'descriptions', [DEFAULT_SKU]: 'descriptions' },
};
const cloud = { ...mlDestinationStub.frameleafCloudConsented, budgetLimitUsd: null, lastProbeCloud: facts };

const admin = { user: { id: 'admin-1', isAdmin: true } } as unknown as AuthDto;
const ownerA = 'owner-a';
const ownerB = 'owner-b';

type AssetRow = { id: string; ownerId: string; type?: AssetType; previewFile?: string | null };

describe(CloudMlBatchService.name, () => {
  let sut: CloudMlBatchService;
  let mocks: ServiceMocks;
  let metadata: Map<string, unknown>;
  let assets: Map<string, AssetRow>;

  const configure = ({
    enabled = true,
    descriptions = 'both',
    autoDescribe = false,
    dailyBudgetUsd = 2,
  }: { enabled?: boolean; descriptions?: string; autoDescribe?: boolean; dailyBudgetUsd?: number } = {}) => {
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        (key === SystemMetadataKey.SystemConfig
          ? {
              frameleafCloud: {
                cloudMl: {
                  ...defaults.frameleafCloud.cloudMl,
                  enabled,
                  routing: { ...defaults.frameleafCloud.cloudMl.routing, descriptions },
                  autoDescribe: { enabled: autoDescribe, dailyBudgetUsd },
                },
              },
            }
          : (metadata.get(key) ?? null)) as never,
      ),
    );
  };

  const addAssets = (rows: AssetRow[]) => {
    for (const row of rows) {
      assets.set(row.id, row);
    }
    mocks.assetJob.streamForImageDescriptionJob.mockReturnValue(makeStream(rows.map(({ id }) => ({ id }))));
  };

  const photos = (ownerId: string, count: number, prefix = ownerId) =>
    Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index + 1}`, ownerId }));

  const operation = (overrides: Partial<Record<string, unknown>> = {}): MediaOperation => {
    const assetIds = (overrides.assetIds as string[] | undefined) ?? ['a-1', 'a-2'];
    return {
      id: BATCH_ID,
      ownerId: ownerA,
      kind: MediaOperationKind.CloudDescriptionBatch,
      status: MediaOperationStatus.Preparing,
      destination: MediaOperationDestination.FrameleafCloud,
      snapshot: {
        version: 1,
        origin: 'backfill',
        destinationId: cloud.id,
        assetIds,
        modelSku: DEFAULT_SKU,
        packKey: `descriptions-${DEFAULT_SKU}`,
        approvedP90Usd: 1,
        ...(overrides.snapshot as object),
      },
      result: (overrides.result as object) ?? emptyCloudDescriptionResult(assetIds),
      remoteJobId: null,
      cancelRequestedAt: null,
      createdAt: now,
      ...(overrides.row as object),
    } as unknown as MediaOperation;
  };

  const inputs = [
    { assetId: 'a-1', inputId: 'p1', sha256: 'ab'.repeat(32), bytes: 1000, contentType: 'image/jpeg' },
    { assetId: 'a-2', inputId: 'p2', sha256: 'ab'.repeat(32), bytes: 1000, contentType: 'image/jpeg' },
  ];

  /** A batch estimated earlier, waiting to be submitted (after a 503, or a lost claim). */
  const estimated = (submission: Record<string, unknown> = {}) =>
    operation({
      result: {
        ...emptyCloudDescriptionResult(['a-1', 'a-2']),
        phase: CloudDescriptionPhase.Estimated,
        estimates: 1,
        items: inputs,
        submission: {
          idempotencyKey: KEY_1,
          estimate: sealed.estimate,
          expiresAt: sealed.expiresAt,
          modelRev: sealed.modelRev,
          computeSku: sealed.computeSku,
          p50Usd: 0.021,
          p90Usd: 0.024,
          holdUsd: 0.05,
          startupUsd: 0.02,
          attemptedAt: null,
          ...submission,
        },
      },
    });

  const written = () =>
    mocks.mediaOperation.setBulkResult.mock.calls.at(-1)?.[2].result as unknown as {
      phase: CloudDescriptionPhase;
      items: Array<{ assetId: string; refused?: string; sha256?: string; costShareUsd?: number }>;
      submission: { idempotencyKey: string; attemptedAt?: string | null } | null;
      job: { jobId: string } | null;
      waiting: { refusal: string } | null;
    };

  const estimates = () =>
    (metadata.get(SystemMetadataKey.FrameleafCloudDescriptionEstimates) as
      { records: CloudDescriptionEstimateRecord[] } | undefined) ?? { records: [] };

  beforeEach(() => {
    CLOUD_DESCRIPTION_CONTRACT.uploadsPublished = true;
    ({ sut, mocks } = newTestService(CloudMlBatchService));
    metadata = new Map();
    assets = new Map();
    metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      status: 'linked',
      cloudUrl: 'https://cloud.test',
      instanceId: 'instance-1',
      dataRegion: 'eu',
    });
    configure();
    mocks.config.getEnv.mockReturnValue({
      ...mocks.config.getEnv(),
      frameleafCloud: { ...mocks.config.getEnv().frameleafCloud, url: 'https://cloud.test', identityDir: '/tmp/id' },
    });
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, value);
      return Promise.resolve();
    });
    mocks.database.withLock.mockImplementation((_lock, callback) => callback() as never);
    mocks.instanceIdentity.loadOrCreate.mockResolvedValue({
      instanceId: 'instance-1',
      kid: 'kid-1',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
      keyFile: '/tmp/id/instance-key.pem',
      createdAt: '2026-09-25T00:00:00.000Z',
    });
    mocks.instanceIdentity.currentSigner.mockReturnValue(identitySigner);
    mocks.frameleafCloud.discovery.mockResolvedValue({
      version: 1,
      validFor: 3600,
      issuer: 'https://id.cloud.test',
      api: 'https://api.cloud.test',
      ml: { eu: 'https://ml.eu.cloud.test' },
    });
    mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'ml-token', signer: identitySigner });

    mocks.frameleafCloudMl.getCatalog.mockResolvedValue(catalog);
    mocks.frameleafCloudMl.createEstimate.mockResolvedValue(sealed);
    mocks.frameleafCloudMl.createJob.mockResolvedValue(admitted);
    mocks.frameleafCloudMl.getWallet.mockResolvedValue({
      balanceUsd: 10,
      heldUsd: 0,
      dailyCapUsd: 20,
      spentTodayUsd: 0,
      topUpUrl: null,
      autoTopUp: false,
      settingsUrl: null,
    });
    mocks.frameleafCloudMl.getUsage.mockResolvedValue({ items: [], refused: 0 });
    mocks.frameleafCloudMl.cancelJob.mockResolvedValue();
    mocks.frameleafCloudMl.deleteJob.mockResolvedValue();

    mocks.mlDestination.getAll.mockResolvedValue([cloud]);
    mocks.mlDestination.getById.mockResolvedValue(cloud);
    mocks.mlDestination.getRoute.mockResolvedValue({
      workload: MlWorkload.Enrichment,
      destinationId: cloud.id,
      modelId: null,
      updatedAt: now,
    });
    mocks.mlDestination.getCloudModelChoice.mockResolvedValue(null);
    mocks.mlDestination.applySettlements.mockResolvedValue(0);
    mocks.mlDestination.recordCloudJobAccounting.mockResolvedValue(true);
    mocks.machineLearning.probe.mockResolvedValue({ ...mlProbeStub.frameleafCloud, cloud: facts });

    mocks.assetJob.getForImageEnrichment.mockImplementation((id) => {
      const row = assets.get(id);
      return Promise.resolve(
        row && {
          id,
          ownerId: row.ownerId,
          type: row.type ?? AssetType.Image,
          status: AssetStatus.Active,
          deletedAt: null,
          visibility: AssetVisibility.Timeline,
          description: '',
          previewFile: row.previewFile === undefined ? `/thumbs/${id}.webp` : row.previewFile,
        },
      );
    });
    mocks.assetJob.streamForImageDescriptionJob.mockReturnValue(makeStream([]));
    mocks.crypto.hashFileDigests.mockResolvedValue({
      sha1: Buffer.alloc(20, 1),
      sha256: Buffer.alloc(32, 0xab),
      sizeInBytes: 1000,
    });
    mocks.crypto.randomUUID.mockReturnValue('5f0c6f8e-2b1a-4c3d-9e8f-1a2b3c4d5e6f');

    mocks.mediaOperation.getOpenCloudDescriptionAssetIds.mockResolvedValue(new Set());
    mocks.mediaOperation.sumCloudDescriptionSpend.mockResolvedValue(0);
    mocks.mediaOperation.sumCloudDescriptionOpenHolds.mockResolvedValue(0);
    mocks.mediaOperation.hasUnsettledCloudDescriptionJobs.mockResolvedValue(false);
    mocks.mediaOperation.getManyForWorker.mockResolvedValue([]);
    mocks.mediaOperation.listCloudDescriptionPendingReleases.mockResolvedValue([]);
    mocks.mediaOperation.setFinishedResult.mockResolvedValue(true);
    mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set());
    mocks.mediaOperation.getUnreleasedRemoteOperations.mockResolvedValue([]);
    let created = 0;
    mocks.mediaOperation.create.mockImplementation((row) => {
      created++;
      return Promise.resolve({ ...row, id: `batch-${created}` } as never);
    });
    mocks.mediaOperation.setBulkResult.mockResolvedValue({
      status: MediaOperationStatus.Preparing,
      cancelRequestedAt: null,
      pauseRequestedAt: null,
    });
    mocks.mediaOperation.setRemoteJobId.mockResolvedValue(true);
    mocks.mediaOperation.recordRemoteJobId.mockResolvedValue(true);
    mocks.mediaOperation.requeue.mockResolvedValue(true);
    mocks.mediaOperation.fail.mockResolvedValue('failed');
    mocks.mediaOperation.reportProgress.mockResolvedValue(true);
    mocks.mediaOperation.acknowledgeCancel.mockResolvedValue(true);
    mocks.mediaOperation.markRemoteReleased.mockResolvedValue();
    mocks.mediaOperation.claimNext.mockResolvedValue(undefined);
  });

  afterEach(() => {
    CLOUD_DESCRIPTION_CONTRACT.uploadsPublished = false;
  });

  describe('the upload gate (review P1)', () => {
    beforeEach(() => {
      CLOUD_DESCRIPTION_CONTRACT.uploadsPublished = false;
    });

    it('still estimates, and says why nothing can be queued', async () => {
      addAssets(photos(ownerA, 3));

      const estimate = await sut.estimateBackfill(admin, now);

      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledTimes(1);
      expect(estimate.refusal).toBe(CLOUD_DESCRIPTION_UPLOADS_UNPUBLISHED);
      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
    });

    it('refuses a backfill before any batch row exists', async () => {
      addAssets(photos(ownerA, 3));
      await sut.estimateBackfill(admin, now);
      mocks.database.withLock.mockClear();

      await expect(sut.startBackfill({ estimateId: estimates().records[0].id }, now)).rejects.toThrow(
        CLOUD_DESCRIPTION_UPLOADS_UNPUBLISHED,
      );
      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
      expect(mocks.database.withLock).not.toHaveBeenCalledWith(
        DatabaseLock.FrameleafCloudMlBackfill,
        expect.anything(),
      );
    });

    it('batches no new photos', async () => {
      configure({ autoDescribe: true });
      metadata.set(SystemMetadataKey.FrameleafCloudDescriptionQueue, {
        items: photos(ownerA, 25).map(({ id }) => ({ assetId: id, ownerId: ownerA, queuedAt: now.toISOString() })),
        lastBatchAt: {},
      });

      await sut.batchNewPhotos(now, 2);

      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
      expect(mocks.database.withLock).not.toHaveBeenCalled();
    });

    it('stops an existing batch at estimated, before POST /v2/jobs', async () => {
      addAssets(photos(ownerA, 2, 'a'));

      await sut.step(operation(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledTimes(1);
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(written().phase).toBe(CloudDescriptionPhase.Estimated);
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        { error: CLOUD_DESCRIPTION_UPLOADS_UNPUBLISHED, errorCode: 'cloud_description_uploads_unpublished' },
        { retry: false },
      );
    });

    it('stops a retried submission too, even one already attempted', async () => {
      addAssets(photos(ownerA, 2, 'a'));

      await sut.step(estimated({ attemptedAt: now.toISOString() }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_uploads_unpublished' }),
        { retry: false },
      );
    });
  });

  describe('the kill switch (review P1)', () => {
    it.each([
      ['processing is turned off', { enabled: false }],
      ['descriptions stay on this server', { descriptions: 'local' }],
    ])('stops a queued batch when %s, sending nothing', async (_label, settings) => {
      configure(settings);
      addAssets(photos(ownerA, 2, 'a'));

      await sut.step(operation(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_turned_off' }),
        { retry: false },
      );
    });

    it('stops and releases a running cloud job when processing is turned off', async () => {
      configure({ enabled: false });
      const batch = operation({
        row: { remoteJobId: admitted.jobId },
        result: {
          ...emptyCloudDescriptionResult(['a-1', 'a-2']),
          phase: CloudDescriptionPhase.Submitted,
          job: {
            jobId: admitted.jobId,
            status: 'running',
            holdUsd: 0.2,
            ceilingUsd: 0.22,
            admittedAt: now.toISOString(),
            meteredSeconds: null,
          },
        },
      });

      await sut.step(batch, 'claim-1', now);

      expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.frameleafCloudMl.getJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_turned_off' }),
        { retry: false },
      );
    });

    it('refuses a backfill estimate while processing is off', async () => {
      configure({ enabled: false });

      await expect(sut.estimateBackfill(admin, now)).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
    });

    it('reads no usage report while off, unless an admitted batch is still unsettled', async () => {
      await sut.settle(now, true, false);
      expect(mocks.frameleafCloudMl.getUsage).not.toHaveBeenCalled();

      mocks.mediaOperation.hasUnsettledCloudDescriptionJobs.mockResolvedValue(true);
      await sut.settle(now, true, false);
      expect(mocks.frameleafCloudMl.getUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe('estimateBackfill', () => {
    it("estimates from metered GPU time per owner's batches, keeps the estimate and queues nothing", async () => {
      addAssets([...photos(ownerA, 250), ...photos(ownerB, 3)]);

      const estimate = await sut.estimateBackfill(admin, now);

      // one sealed estimate for a sample of at most ten photos, never a job
      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledTimes(1);
      const request = mocks.frameleafCloudMl.createEstimate.mock.calls[0][1];
      expect(request).toMatchObject({
        workload: 'descriptions',
        modelSku: DEFAULT_SKU,
        request: { length: 'standard' },
      });
      expect(request.inputs).toHaveLength(10);
      expect(mocks.media.writeCloudUpload).toHaveBeenCalledTimes(10);
      expect(mocks.storage.unlinkDir).toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();

      // 250 + 3 photos: owner A in 200 and 50, owner B in 3; per photo (0.021 − 0.02) / 10 and (0.024 − 0.02) / 10
      expect(estimate).toMatchObject({
        photos: 253,
        batches: 3,
        truncated: false,
        modelId: DEFAULT_SKU,
        modelName: 'Descriptions · Standard',
        startupUsd: 0.02,
        perPhotoP50Usd: 0.0001,
        perPhotoP90Usd: 0.0004,
        basis: 'measured',
        availableUsd: 10,
        dailyCapUsd: 20,
        guidance: null,
        refusal: null,
        estimateId: '5f0c6f8e-2b1a-4c3d-9e8f-1a2b3c4d5e6f',
        expiresAt: '2026-09-26T04:35:00.000Z',
      });
      expect(estimate.p50Usd).toBeCloseTo(0.06 + 253 * 0.0001, 6);
      expect(estimate.p90Usd).toBeCloseTo(0.06 + 253 * 0.0004, 6);

      const [record] = estimates().records;
      expect(record).toMatchObject({
        id: estimate.estimateId,
        modelSku: DEFAULT_SKU,
        perPhotoP90Usd: 0.0004,
        startupUsd: 0.02,
        photos: 253,
        p90Usd: estimate.p90Usd,
        createdBy: 'admin-1',
        started: null,
      });
      expect(record.owners[ownerA]).toHaveLength(250);
      expect(record.owners[ownerB]).toEqual(['owner-b-1', 'owner-b-2', 'owner-b-3']);
      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.FrameleafCloudMlBackfill, expect.any(Function));
    });

    it('checks consent and admission before anything is asked of the cloud (review P2)', async () => {
      mocks.mlDestination.getAll.mockResolvedValue([{ ...cloud, consentAcknowledgedAt: null }]);

      await expect(sut.estimateBackfill(admin, now)).rejects.toThrow(/processing terms/);

      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.getCatalog).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
    });

    it('refuses when admission refuses (an outdated consent), before the catalogue is read', async () => {
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        cloud: { ...facts, consentRequiredVersion: '2026-10-01.1' },
      });

      await expect(sut.estimateBackfill(admin, now)).rejects.toThrow(/consent/);
      expect(mocks.frameleafCloudMl.getCatalog).not.toHaveBeenCalled();
    });

    it('leaves Locked photos, videos, photos without a preview and photos in open batches out', async () => {
      addAssets([
        { id: 'a-1', ownerId: ownerA },
        { id: 'a-2', ownerId: ownerA },
        { id: 'a-open', ownerId: ownerA },
        { id: 'a-video', ownerId: ownerA, type: AssetType.Video },
        { id: 'a-no-preview', ownerId: ownerA, previewFile: null },
      ]);
      mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set(['a-2']));
      mocks.mediaOperation.getOpenCloudDescriptionAssetIds.mockResolvedValue(new Set(['a-open']));

      const estimate = await sut.estimateBackfill(admin, now);

      expect(estimate.photos).toBe(1);
      expect(mocks.mediaOperation.getLockedAssetIds).toHaveBeenCalledWith(ownerA, ['a-1', 'a-2']);
      expect(mocks.media.writeCloudUpload).toHaveBeenCalledWith('/thumbs/a-1.webp', expect.stringContaining('s1.jpeg'));
    });

    it('refuses to start when the AI Wallet cannot cover the p90', async () => {
      addAssets(photos(ownerA, 5));
      mocks.frameleafCloudMl.getWallet.mockResolvedValue({
        balanceUsd: 0.05,
        heldUsd: 0.04,
        dailyCapUsd: null,
        spentTodayUsd: 0,
        topUpUrl: null,
        autoTopUp: false,
        settingsUrl: null,
      });

      const estimate = await sut.estimateBackfill(admin, now);

      expect(estimate.refusal).toMatch(/^The AI Wallet has 0\.01 USD available/);
    });

    it("counts the destination's spend in its window and running batches' holds against its budget (review P2)", async () => {
      addAssets(photos(ownerA, 5));
      mocks.mlDestination.getAll.mockResolvedValue([{ ...cloud, budgetLimitUsd: 1 }]);
      mocks.mlDestination.getById.mockResolvedValue({ ...cloud, budgetLimitUsd: 1 });
      mocks.mlDestination.getSpend.mockResolvedValue(0.5);
      mocks.mediaOperation.sumCloudDescriptionOpenHolds.mockResolvedValue(0.49);

      const estimate = await sut.estimateBackfill(admin, now);

      expect(mocks.mediaOperation.sumCloudDescriptionOpenHolds).toHaveBeenCalledWith(
        cloud.id,
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      );
      expect(estimate.refusal).toMatch(/has 0\.01 USD left of its 1\.00 USD spending limit/);
    });

    it('steers small batches away from a 72B-class model', async () => {
      const heavy = { ...descriptionsFixture.models[1], sku: 'ms_M72B0000', rank: 6, default: false };
      const mid = { ...descriptionsFixture.models[1], sku: 'ms_M27B0000', rank: 3, default: false };
      mocks.frameleafCloudMl.getCatalog.mockResolvedValue(
        catalogSchema.parse({
          ...descriptionsFixture,
          models: [
            ...descriptionsFixture.models,
            { ...heavy, label: 'Descriptions · Largest', display: { model: 'Qwen2.5-VL-72B', gpu: 'H100-class' } },
            { ...mid, label: 'Descriptions · Detailed', display: { model: 'Qwen3.5-27B', gpu: 'L40S-class' } },
          ],
        }),
      );
      mocks.mlDestination.getCloudModelChoice.mockResolvedValue('ms_M72B0000');
      // the admission check (consent first, before the catalogue is read) judges the chosen model
      // against the last check's facts, so that check must have seen the same catalogue
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        cloud: {
          ...facts,
          modelIds: [...facts.modelIds, 'ms_M72B0000', 'ms_M27B0000'],
          modelWorkloads: {
            ...facts.modelWorkloads,
            ms_M72B0000: MlWorkload.Enrichment,
            ms_M27B0000: MlWorkload.Enrichment,
          },
          modelGroups: { ...facts.modelGroups, ms_M72B0000: 'descriptions', ms_M27B0000: 'descriptions' },
        },
      });
      addAssets(photos(ownerA, 40));

      const estimate = await sut.estimateBackfill(admin, now);

      expect(estimate.modelId).toBe('ms_M72B0000');
      expect(estimate.guidance).toEqual({
        minimumBatch: 200,
        smallBatches: 1,
        suggestedModelId: 'ms_M27B0000',
        suggestedModelName: 'Descriptions · Detailed',
      });
    });

    it('asks for a model when the catalogue recommends none and none is chosen', async () => {
      mocks.frameleafCloudMl.getCatalog.mockResolvedValue(
        catalogSchema.parse({
          ...descriptionsFixture,
          models: descriptionsFixture.models.map((model) => ({ ...model, default: false })),
        }),
      );

      await expect(sut.estimateBackfill(admin, now)).rejects.toThrow(/choose one in Where each job runs/);
    });
  });

  describe('startBackfill', () => {
    const estimateFirst = async () => {
      const estimate = await sut.estimateBackfill(admin, now);
      return estimate.estimateId!;
    };

    it("queues the kept estimate's photos, one batch per owner's 200, at the kept prices (review P1)", async () => {
      addAssets([...photos(ownerA, 250), ...photos(ownerB, 3)]);
      const estimateId = await estimateFirst();

      const result = await sut.startBackfill({ estimateId }, now);

      expect(result).toEqual({ batches: 3, photos: 253, operationIds: ['batch-1', 'batch-2', 'batch-3'] });
      const rows = mocks.mediaOperation.create.mock.calls.map(([row]) => row);
      expect(rows.map((row) => [row.ownerId, (row.snapshot as { assetIds: string[] }).assetIds.length])).toEqual([
        [ownerA, 200],
        [ownerA, 50],
        [ownerB, 3],
      ]);
      expect(rows[0]).toMatchObject({
        kind: MediaOperationKind.CloudDescriptionBatch,
        destination: MediaOperationDestination.FrameleafCloud,
        label: 'Describe 200 photos with Frameleaf Cloud',
        snapshot: {
          origin: 'backfill',
          destinationId: cloud.id,
          modelSku: DEFAULT_SKU,
          packKey: `descriptions-${DEFAULT_SKU}`,
          approvedP90Usd: 0.02 + 200 * 0.0004,
        },
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.CloudMlDescriptionBatch, data: {} });
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.FrameleafCloudMlBackfill, expect.any(Function));
      expect(estimates().records[0]).toMatchObject({ owners: {}, started: { batches: 3, photos: 253 } });
    });

    it('takes the backfill lock, then the automatic queue lock, around creating batches (re-check)', async () => {
      addAssets(photos(ownerA, 3));
      const estimateId = await estimateFirst();
      mocks.database.withLock.mockClear();

      await sut.startBackfill({ estimateId }, now);

      const batchLocks = new Set([DatabaseLock.FrameleafCloudMlBackfill, DatabaseLock.FrameleafCloudMlBatchQueue]);
      expect(mocks.database.withLock.mock.calls.map(([lock]) => lock).filter((lock) => batchLocks.has(lock))).toEqual([
        DatabaseLock.FrameleafCloudMlBackfill,
        DatabaseLock.FrameleafCloudMlBatchQueue,
      ]);
    });

    it('answers a second request for the same estimate with the first, queueing nothing more (review P2)', async () => {
      addAssets(photos(ownerA, 3));
      const estimateId = await estimateFirst();

      const first = await sut.startBackfill({ estimateId }, now);
      const second = await sut.startBackfill({ estimateId }, now);

      expect(second).toEqual(first);
      expect(mocks.mediaOperation.create).toHaveBeenCalledTimes(1);
    });

    it('leaves out photos that joined another batch or became Locked since the estimate (review P2)', async () => {
      addAssets(photos(ownerA, 4));
      const estimateId = await estimateFirst();
      mocks.mediaOperation.getOpenCloudDescriptionAssetIds.mockResolvedValue(new Set(['owner-a-1']));
      mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set(['owner-a-2']));

      const result = await sut.startBackfill({ estimateId }, now);

      expect(result.photos).toBe(2);
      expect(mocks.mediaOperation.create.mock.calls[0][0].snapshot).toMatchObject({
        assetIds: ['owner-a-3', 'owner-a-4'],
      });
    });

    it('refuses an estimate the server does not know, or one that expired', async () => {
      addAssets(photos(ownerA, 3));
      const estimateId = await estimateFirst();

      await expect(sut.startBackfill({ estimateId: '00000000-0000-4000-8000-000000000000' }, now)).rejects.toThrow(
        /not known/,
      );
      await expect(sut.startBackfill({ estimateId }, new Date(now.getTime() + 31 * 60_000))).rejects.toThrow(/expired/);
      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
    });

    it('refuses when the model changed since the estimate', async () => {
      addAssets(photos(ownerA, 3));
      const estimateId = await estimateFirst();
      mocks.mlDestination.getCloudModelChoice.mockResolvedValue('ms_NME7RZQ1');

      await expect(sut.startBackfill({ estimateId }, now)).rejects.toThrow(/model changed/);
      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
    });

    it('refuses when the wallet can no longer cover it', async () => {
      addAssets(photos(ownerA, 3));
      const estimateId = await estimateFirst();
      mocks.frameleafCloudMl.getWallet.mockResolvedValue({
        balanceUsd: 0.01,
        heldUsd: 0,
        dailyCapUsd: null,
        spentTodayUsd: 0,
        topUpUrl: null,
        autoTopUp: false,
        settingsUrl: null,
      });

      await expect(sut.startBackfill({ estimateId }, now)).rejects.toThrow(/Add credit first/);
      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
    });
  });

  describe('a batch step', () => {
    beforeEach(() => {
      addAssets(photos(ownerA, 3, 'a'));
    });

    it('estimates, checks the wallet and submits one job with its pack key and idempotency key', async () => {
      const batch = operation({ assetIds: ['a-1', 'a-2', 'a-3'] });
      mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set(['a-3']));

      await sut.step(batch, 'claim-1', now);

      // the Locked photo is never prepared or sent
      expect(mocks.media.writeCloudUpload).toHaveBeenCalledTimes(2);
      const estimateRequest = mocks.frameleafCloudMl.createEstimate.mock.calls[0][1];
      expect(estimateRequest.inputs.map(({ inputId }) => inputId)).toEqual(['p1', 'p2']);

      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledTimes(1);
      const [, body, key] = mocks.frameleafCloudMl.createJob.mock.calls[0];
      expect(jobCreateRequestSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({
        estimate: sealed.estimate,
        workload: 'descriptions',
        modelSku: DEFAULT_SKU,
        modelRev: sealed.modelRev,
        clientRef: `batch-${batch.id}`,
        packKey: `descriptions-${DEFAULT_SKU}`,
        request: { length: 'standard' },
      });
      // prompts stay in the cloud: nothing but the length is asked for, so no name ever leaves
      expect(Object.keys(body.request)).toEqual(['length']);
      expect(key).toBe(KEY_1);

      expect(mocks.mediaOperation.setRemoteJobId).toHaveBeenCalledWith(batch.id, 'claim-1', admitted.jobId);
      expect(mocks.mlDestination.recordCloudJobAccounting).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationKind: MlDestinationKind.FrameleafCloud,
          workload: MlWorkload.Enrichment,
          jobId: batch.id,
          jobName: JobName.CloudMlDescriptionBatch,
          bytesSent: 2000,
          costUsd: null,
          cloudJobId: admitted.jobId,
        }),
      );
      expect(written()).toMatchObject({ phase: CloudDescriptionPhase.Submitted, job: { jobId: admitted.jobId } });
      expect(written().items.find(({ assetId }) => assetId === 'a-3')).toEqual({
        assetId: 'a-3',
        inputId: 'p3',
        refused: 'locked',
      });
      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(batch.id, 'claim-1', {
        delayMs: CLOUD_DESCRIPTION_POLL_MS,
        returnAttempt: true,
      });
    });

    it('records the attempt before POST /v2/jobs (review P2)', async () => {
      const order: string[] = [];
      mocks.mediaOperation.setBulkResult.mockImplementation((_id, _token, patch) => {
        const submission = (patch.result as { submission?: { attemptedAt?: string | null } }).submission;
        order.push(submission?.attemptedAt ? 'attempt saved' : 'saved');
        return Promise.resolve({
          status: MediaOperationStatus.Preparing,
          cancelRequestedAt: null,
          pauseRequestedAt: null,
        });
      });
      mocks.frameleafCloudMl.createJob.mockImplementation(() => {
        order.push('POST /v2/jobs');
        return Promise.resolve(admitted);
      });

      await sut.step(operation(), 'claim-1', now);

      expect(order.indexOf('attempt saved')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('attempt saved')).toBeLessThan(order.indexOf('POST /v2/jobs'));
    });

    it('replays an attempted submission with its own key, even past its expiry, before estimating again (review P2)', async () => {
      const later = new Date('2026-09-26T05:00:00.000Z');

      await sut.step(estimated({ attemptedAt: now.toISOString() }), 'claim-1', later);

      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ estimate: sealed.estimate }),
        KEY_1,
      );
      expect(written()).toMatchObject({ phase: CloudDescriptionPhase.Submitted, job: { jobId: admitted.jobId } });
    });

    it('checks the photos before a replay, and keeps the attempt when one changed (re-check)', async () => {
      mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set(['a-2']));

      await sut.step(estimated({ attemptedAt: now.toISOString() }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(written().submission).toMatchObject({ idempotencyKey: KEY_1, attemptedAt: now.toISOString() });
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_photos_changed' }),
        { retry: false },
      );
    });

    it('runs the pre-flight before a replay (re-check)', async () => {
      mocks.frameleafCloudMl.getWallet.mockResolvedValue({
        balanceUsd: 0.04,
        heldUsd: 0,
        dailyCapUsd: null,
        spentTodayUsd: 0,
        topUpUrl: null,
        autoTopUp: false,
        settingsUrl: null,
      });

      await sut.step(estimated({ attemptedAt: now.toISOString() }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_wallet_insufficient' }),
        { retry: false },
      );
    });

    it('keeps an attempted submission when the batch has to wait for tomorrow (re-check)', async () => {
      configure({ autoDescribe: true, dailyBudgetUsd: 0.5 });
      mocks.mediaOperation.sumCloudDescriptionSpend.mockResolvedValue(0.49);
      const batch = estimated({ attemptedAt: now.toISOString() });
      (batch.snapshot as Record<string, unknown>).origin = 'automatic';
      (batch.snapshot as Record<string, unknown>).approvedP90Usd = null;

      await sut.step(batch, 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(written()).toMatchObject({
        phase: CloudDescriptionPhase.Estimated,
        submission: { idempotencyKey: KEY_1, attemptedAt: now.toISOString() },
      });
    });

    it('estimates again when a replayed attempt created no job (409)', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValueOnce(
        new FrameleafCloudError(MlAdmissionRefusal.ModelMismatch, 409, 'The estimate expired'),
      );

      await sut.step(estimated({ attemptedAt: now.toISOString() }), 'claim-1', new Date('2026-09-26T05:00:00.000Z'));

      expect(written()).toMatchObject({ phase: CloudDescriptionPhase.Queued, submission: null });
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
    });

    it('checks everything again before submitting a batch that waited (review P2)', async () => {
      mocks.frameleafCloudMl.getWallet.mockResolvedValue({
        balanceUsd: 0.04,
        heldUsd: 0,
        dailyCapUsd: null,
        spentTodayUsd: 0,
        topUpUrl: null,
        autoTopUp: false,
        settingsUrl: null,
      });

      await sut.step(estimated(), 'claim-1', now);

      expect(mocks.machineLearning.probe).toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_wallet_insufficient' }),
        { retry: false },
      );
    });

    it('estimates a waiting batch again when one of its photos became Locked (review P2)', async () => {
      mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set(['a-2']));

      await sut.step(estimated(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(written()).toMatchObject({ phase: CloudDescriptionPhase.Queued, submission: null });
      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(BATCH_ID, 'claim-1', {
        delayMs: 0,
        returnAttempt: true,
      });
    });

    it('fails closed on 503 capacity: one retry, never another destination', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.DestinationUnhealthy, 503, 'Frameleaf Cloud has no capacity now'),
      );

      await sut.step(operation(), 'claim-1', now);

      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        { error: 'Frameleaf Cloud has no capacity now', errorCode: 'cloud_description_destination_unhealthy' },
        { retry: true },
      );
      expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.setRemoteJobId).not.toHaveBeenCalled();
    });

    it('keeps the job id on the row before releasing a job whose claim was lost (review P2)', async () => {
      const order: string[] = [];
      mocks.mediaOperation.setRemoteJobId.mockResolvedValue(false);
      mocks.mediaOperation.recordRemoteJobId.mockImplementation(() => {
        order.push('recorded');
        return Promise.resolve(true);
      });
      mocks.frameleafCloudMl.cancelJob.mockImplementation(() => {
        order.push('cancelled');
        return Promise.resolve();
      });

      await sut.step(operation(), 'claim-1', now);

      expect(mocks.mediaOperation.recordRemoteJobId).toHaveBeenCalledWith(BATCH_ID, admitted.jobId);
      expect(order).toEqual(['recorded', 'cancelled']);
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.mlDestination.recordCloudJobAccounting).not.toHaveBeenCalled();
    });

    it('refuses a hold the AI Wallet cannot cover, and sends nothing', async () => {
      mocks.frameleafCloudMl.getWallet.mockResolvedValue({
        balanceUsd: 0.04,
        heldUsd: 0,
        dailyCapUsd: null,
        spentTodayUsd: 0,
        topUpUrl: null,
        autoTopUp: false,
        settingsUrl: null,
      });

      await sut.step(operation(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_wallet_insufficient' }),
        { retry: false },
      );
    });

    it('refuses a batch estimated well above its approval', async () => {
      await sut.step(operation({ snapshot: { approvedP90Usd: 0.01 } }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_estimate_increased' }),
        { retry: false },
      );
    });

    it("refuses when the destination's budget, with running batches' holds, has no room (review P2)", async () => {
      mocks.mlDestination.getById.mockResolvedValue({ ...cloud, budgetLimitUsd: 1 });
      mocks.mlDestination.getSpend.mockResolvedValue(0.5);
      mocks.mediaOperation.sumCloudDescriptionOpenHolds.mockResolvedValue(0.48);

      await sut.step(operation(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_budget_exceeded' }),
        { retry: false },
      );
    });

    it('ends a batch whose photos were all left out without sending anything', async () => {
      mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set(['a-1', 'a-2']));
      mocks.mediaOperation.beginValidation.mockResolvedValue(true);
      mocks.mediaOperation.complete.mockResolvedValue(true);

      await sut.step(operation(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.complete).toHaveBeenCalledWith(BATCH_ID, 'claim-1', { resultAssetId: null });
    });
  });

  describe('automatic batches and the daily budget', () => {
    const automatic = () => operation({ snapshot: { origin: 'automatic', approvedP90Usd: null } });

    beforeEach(() => {
      addAssets(photos(ownerA, 2, 'a'));
    });

    it("sums today's automatic spend in SQL by origin and admission day (review P2)", async () => {
      configure({ autoDescribe: true, dailyBudgetUsd: 0.5 });

      await sut.step(automatic(), 'claim-1', now);

      expect(mocks.mediaOperation.sumCloudDescriptionSpend).toHaveBeenCalledWith({
        origin: 'automatic',
        from: serverDayStart(now),
        to: nextServerDay(now),
      });
      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledTimes(1);
    });

    it('waits for the next day once the budget is spent and tells administrators once', async () => {
      configure({ autoDescribe: true, dailyBudgetUsd: 0.5 });
      mocks.mediaOperation.sumCloudDescriptionSpend.mockResolvedValue(0.49);
      const batch = automatic();

      await sut.step(batch, 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.event.emit).toHaveBeenCalledWith('AdminNotify', {
        type: NotificationType.SystemMessage,
        level: NotificationLevel.Info,
        title: 'Automatic descriptions paused for today',
        description: expect.stringContaining('0.50 USD'),
        dedupeKey: expect.stringMatching(/^frameleaf-cloud:description-budget:\d{4}-\d{2}-\d{2}$/),
        dedupeDays: 1,
      });
      expect(written()).toMatchObject({ phase: CloudDescriptionPhase.Queued, submission: null });
      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(batch.id, 'claim-1', {
        delayMs: nextServerDay(now).getTime() - now.getTime(),
        returnAttempt: true,
      });
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
    });

    it('starts no new automatic batch once the budget is spent', async () => {
      configure({ autoDescribe: true, dailyBudgetUsd: 0.5 });
      mocks.mediaOperation.sumCloudDescriptionSpend.mockResolvedValue(0.6);
      metadata.set(SystemMetadataKey.FrameleafCloudDescriptionQueue, {
        items: photos(ownerA, 25).map(({ id }) => ({ assetId: id, ownerId: ownerA, queuedAt: now.toISOString() })),
        lastBatchAt: {},
      });

      await sut.batchNewPhotos(now, 0.5);

      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
      expect(mocks.event.emit).toHaveBeenCalledWith('AdminNotify', expect.objectContaining({ dedupeDays: 1 }));
    });

    it("batches an owner's new photos once there are enough of them, leaving the rest waiting", async () => {
      configure({ autoDescribe: true });
      addAssets([...photos(ownerA, 20), ...photos(ownerB, 2)]);
      mocks.mediaOperation.getLockedAssetIds.mockImplementation((ownerId) =>
        Promise.resolve(new Set(ownerId === ownerA ? ['owner-a-20'] : [])),
      );
      const queued = (ownerId: string, count: number) =>
        photos(ownerId, count).map(({ id }) => ({ assetId: id, ownerId, queuedAt: now.toISOString() }));
      metadata.set(SystemMetadataKey.FrameleafCloudDescriptionQueue, {
        items: [...queued(ownerA, 20), ...queued(ownerB, 2)],
        lastBatchAt: {},
      });

      await sut.batchNewPhotos(now, 2);

      expect(mocks.database.withLock).toHaveBeenCalledWith(
        DatabaseLock.FrameleafCloudMlBatchQueue,
        expect.any(Function),
      );
      expect(mocks.mediaOperation.create).toHaveBeenCalledTimes(1);
      const [row] = mocks.mediaOperation.create.mock.calls[0];
      expect(row.ownerId).toBe(ownerA);
      // the Locked photo left the queue without joining the batch
      expect((row.snapshot as { assetIds: string[] }).assetIds).toHaveLength(19);
      expect(row.snapshot).toMatchObject({ origin: 'automatic', approvedP90Usd: null });
      expect(metadata.get(SystemMetadataKey.FrameleafCloudDescriptionQueue)).toEqual({
        items: queued(ownerB, 2),
        lastBatchAt: { [ownerA]: now.toISOString() },
      });
    });
  });

  describe('a submitted batch', () => {
    const submitted = () =>
      operation({
        row: { remoteJobId: admitted.jobId },
        result: {
          ...emptyCloudDescriptionResult(['a-1', 'a-2']),
          phase: CloudDescriptionPhase.Submitted,
          job: {
            jobId: admitted.jobId,
            status: 'admitted',
            holdUsd: 0.2,
            ceilingUsd: 0.22,
            admittedAt: admitted.createdAt,
            meteredSeconds: null,
          },
        },
      });
    const status = (value: string) =>
      ({ jobId: admitted.jobId, status: value, modelSku: DEFAULT_SKU, modelRev: sealed.modelRev }) as never;

    it('is read again later while the cloud runs it', async () => {
      mocks.frameleafCloudMl.getJob.mockResolvedValue(status('running'));

      await expect(sut.step(submitted(), 'claim-1', now)).resolves.toBe(false);

      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(expect.any(String), 'claim-1', {
        delayMs: CLOUD_DESCRIPTION_POLL_MS,
        returnAttempt: true,
      });
      expect(mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
    });

    it('stops a job waiting for uploads this server cannot send yet, and releases it', async () => {
      mocks.frameleafCloudMl.getJob.mockResolvedValue(status('awaiting_upload'));

      await expect(sut.step(submitted(), 'claim-1', now)).resolves.toBe(true);

      expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.mediaOperation.markRemoteReleased).toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        expect.any(String),
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_upload_unavailable' }),
        { retry: false },
      );
    });

    it('acknowledges a completed job so the cloud purges it, and writes nothing it cannot read', async () => {
      mocks.frameleafCloudMl.getJob.mockResolvedValue(status('completed'));

      await sut.step(submitted(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        expect.any(String),
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_results_unreadable' }),
        { retry: false },
      );
    });

    it('cancels and releases the cloud job when its owner cancels the batch', async () => {
      mocks.frameleafCloudMl.getJob.mockResolvedValue(status('running'));
      mocks.mediaOperation.setBulkResult.mockResolvedValue({
        status: MediaOperationStatus.Cancelling,
        cancelRequestedAt: now,
        pauseRequestedAt: null,
      });

      await sut.step(submitted(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.mediaOperation.acknowledgeCancel).toHaveBeenCalledWith(expect.any(String), 'claim-1', {
        released: true,
      });
      expect(mocks.mediaOperation.requeue).not.toHaveBeenCalled();
    });
  });

  describe('settlement', () => {
    it('fills ml_workload_accounting from the usage report and writes each photo its share', async () => {
      const usage = cloudContractFixture<{ items: Array<{ jobId: string } & Record<string, unknown>> }>(
        'ml/usage.json',
      );
      const item = { ...usage.items[0], clientRef: `batch-${BATCH_ID}` };
      mocks.frameleafCloudMl.getUsage.mockResolvedValue({ items: [item as never], refused: 0 });
      mocks.mediaOperation.getManyForWorker.mockResolvedValue([
        operation({
          row: { status: MediaOperationStatus.Failed, remoteJobId: item.jobId },
          result: {
            ...emptyCloudDescriptionResult(['a-1', 'a-2']),
            phase: CloudDescriptionPhase.Finished,
            items: [inputs[0], { assetId: 'a-2', inputId: 'p2', refused: 'locked' }],
          },
        }),
      ]);
      mocks.mediaOperation.setFinishedResult.mockResolvedValue(true);

      await sut.settle(now, true);

      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledWith([
        { cloudJobId: item.jobId, costUsd: 0.0244, credits: null },
      ]);
      // the batches are read in one query
      expect(mocks.mediaOperation.getManyForWorker).toHaveBeenCalledWith([BATCH_ID]);
      const [, result] = mocks.mediaOperation.setFinishedResult.mock.calls[0];
      expect(result).toMatchObject({
        settledUsd: 0.0244,
        items: [
          { assetId: 'a-1', costShareUsd: 0.0244 },
          { assetId: 'a-2', refused: 'locked' },
        ],
      });
    });

    it('reads the usage report at most every 15 minutes unless a batch just ended', async () => {
      await sut.settle(now, false);
      await sut.settle(new Date(now.getTime() + 60_000), false);

      expect(mocks.frameleafCloudMl.getUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe('runPass', () => {
    it('releases the cloud job of a batch cancelled while it waited, asking only for its own kind', async () => {
      mocks.mediaOperation.getUnreleasedRemoteOperations.mockResolvedValue([
        operation({ row: { status: MediaOperationStatus.Cancelled, remoteJobId: admitted.jobId } }),
      ]);

      await sut.runPass(now);

      expect(mocks.mediaOperation.getUnreleasedRemoteOperations).toHaveBeenCalledWith(100, [
        MediaOperationKind.CloudDescriptionBatch,
      ]);
      expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledTimes(1);
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.mediaOperation.markRemoteReleased).toHaveBeenCalledWith(BATCH_ID);
    });

    describe('attempted submissions whose job was never recorded (re-check)', () => {
      const ended = () =>
        operation({
          row: { status: MediaOperationStatus.Failed },
          result: {
            ...emptyCloudDescriptionResult(['a-1', 'a-2']),
            phase: CloudDescriptionPhase.Estimated,
            estimates: 1,
            items: inputs,
            submission: {
              idempotencyKey: KEY_1,
              estimate: sealed.estimate,
              expiresAt: sealed.expiresAt,
              modelRev: sealed.modelRev,
              computeSku: sealed.computeSku,
              p50Usd: 0.021,
              p90Usd: 0.024,
              holdUsd: 0.05,
              startupUsd: 0.02,
              attemptedAt: '2026-09-26T04:06:00.000Z',
            },
          },
        });
      const later = new Date('2026-09-26T05:00:00.000Z');

      it('replays the key once the estimate expired, then records, stops and releases the job', async () => {
        mocks.mediaOperation.listCloudDescriptionPendingReleases.mockResolvedValue([ended()]);

        await sut.runPass(later);

        expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ clientRef: `batch-${BATCH_ID}`, estimate: sealed.estimate }),
          KEY_1,
        );
        expect(mocks.mediaOperation.recordRemoteJobId).toHaveBeenCalledWith(BATCH_ID, admitted.jobId);
        expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
        expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
        expect(mocks.mediaOperation.setFinishedResult).toHaveBeenCalledWith(
          BATCH_ID,
          expect.objectContaining({ submission: expect.objectContaining({ attemptedAt: null }) }),
        );
      });

      it('clears the marker when the replay shows no job was created (409)', async () => {
        mocks.mediaOperation.listCloudDescriptionPendingReleases.mockResolvedValue([ended()]);
        mocks.frameleafCloudMl.createJob.mockRejectedValue(
          new FrameleafCloudError(MlAdmissionRefusal.ModelMismatch, 409, 'The estimate expired'),
        );

        await sut.runPass(later);

        expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
        expect(mocks.mediaOperation.setFinishedResult).toHaveBeenCalledWith(
          BATCH_ID,
          expect.objectContaining({ submission: expect.objectContaining({ attemptedAt: null }) }),
        );
      });

      it('waits while the estimate could still create a job', async () => {
        mocks.mediaOperation.listCloudDescriptionPendingReleases.mockResolvedValue([ended()]);

        await sut.runPass(now);

        expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
        expect(mocks.mediaOperation.setFinishedResult).not.toHaveBeenCalled();
      });

      it('replays nothing while the upload gate is closed', async () => {
        CLOUD_DESCRIPTION_CONTRACT.uploadsPublished = false;
        mocks.mediaOperation.listCloudDescriptionPendingReleases.mockResolvedValue([ended()]);

        await sut.runPass(later);

        expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      });
    });

    it('steps claimed batches under the batch lock', async () => {
      addAssets(photos(ownerA, 2, 'a'));
      // the pass runs at the real time, so the sealed estimate must still be valid then
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({ ...sealed, expiresAt: '2099-01-01T00:00:00.000Z' });
      mocks.mediaOperation.claimNext
        .mockResolvedValueOnce({ operation: operation(), claimToken: 'claim-1' })
        .mockResolvedValueOnce(undefined);

      await sut.handleBatchPass();

      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.FrameleafCloudMlBatch, expect.any(Function));
      expect(mocks.mediaOperation.claimNext).toHaveBeenCalledWith(
        expect.objectContaining({ kinds: [MediaOperationKind.CloudDescriptionBatch] }),
      );
      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledTimes(1);
    });
  });
});
