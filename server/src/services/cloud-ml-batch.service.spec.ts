import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaOperation } from 'src/repositories/media-operation.repository.js';
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
  CLOUD_DESCRIPTION_POLL_MS,
  CloudDescriptionPhase,
  emptyCloudDescriptionResult,
  nextServerDay,
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

const facts: CloudProbeFacts = {
  ...mlDestinationStub.frameleafCloudConsented.lastProbeCloud!,
  modelIds: ['ms_NME7RZQ1', DEFAULT_SKU],
  modelWorkloads: { ms_NME7RZQ1: MlWorkload.Enrichment, [DEFAULT_SKU]: MlWorkload.Enrichment },
  defaultModels: { descriptions: DEFAULT_SKU },
  modelGroups: { ms_NME7RZQ1: 'descriptions', [DEFAULT_SKU]: 'descriptions' },
};
const cloud = { ...mlDestinationStub.frameleafCloudConsented, budgetLimitUsd: null, lastProbeCloud: facts };

const ownerA = 'owner-a';
const ownerB = 'owner-b';

type AssetRow = { id: string; ownerId: string; type?: AssetType; previewFile?: string | null };

describe(CloudMlBatchService.name, () => {
  let sut: CloudMlBatchService;
  let mocks: ServiceMocks;
  let metadata: Map<string, unknown>;
  let assets: Map<string, AssetRow>;

  const configure = ({
    descriptions = 'both',
    autoDescribe = false,
    dailyBudgetUsd = 2,
  }: { descriptions?: string; autoDescribe?: boolean; dailyBudgetUsd?: number } = {}) => {
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        (key === SystemMetadataKey.SystemConfig
          ? {
              frameleafCloud: {
                cloudMl: {
                  ...defaults.frameleafCloud.cloudMl,
                  enabled: true,
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
      id: '0192f1b0-0000-7000-8000-000000000001',
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

  const written = () =>
    mocks.mediaOperation.setBulkResult.mock.calls.at(-1)?.[2].result as unknown as {
      phase: CloudDescriptionPhase;
      items: Array<{ assetId: string; refused?: string; sha256?: string; costShareUsd?: number }>;
      submission: { idempotencyKey: string } | null;
      job: { jobId: string } | null;
      waiting: { refusal: string } | null;
    };

  beforeEach(() => {
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

    mocks.mediaOperation.listRecentOfKind.mockResolvedValue([]);
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
    mocks.mediaOperation.requeue.mockResolvedValue(true);
    mocks.mediaOperation.fail.mockResolvedValue('failed');
    mocks.mediaOperation.reportProgress.mockResolvedValue(true);
    mocks.mediaOperation.acknowledgeCancel.mockResolvedValue(true);
    mocks.mediaOperation.markRemoteReleased.mockResolvedValue();
    mocks.mediaOperation.claimNext.mockResolvedValue(undefined);
  });

  describe('estimateBackfill', () => {
    it("estimates from metered GPU time per owner's batches and queues nothing", async () => {
      addAssets([...photos(ownerA, 250), ...photos(ownerB, 3)]);

      const estimate = await sut.estimateBackfill();

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
      });
      expect(estimate.p50Usd).toBeCloseTo(0.06 + 253 * 0.0001, 6);
      expect(estimate.p90Usd).toBeCloseTo(0.06 + 253 * 0.0004, 6);
    });

    it('leaves Locked photos, videos and photos without a preview out', async () => {
      addAssets([
        { id: 'a-1', ownerId: ownerA },
        { id: 'a-2', ownerId: ownerA },
        { id: 'a-video', ownerId: ownerA, type: AssetType.Video },
        { id: 'a-no-preview', ownerId: ownerA, previewFile: null },
      ]);
      mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set(['a-2']));

      const estimate = await sut.estimateBackfill();

      expect(estimate.photos).toBe(1);
      expect(mocks.mediaOperation.getLockedAssetIds).toHaveBeenCalledWith(ownerA, ['a-1', 'a-2']);
      const inputs = mocks.frameleafCloudMl.createEstimate.mock.calls[0][1].inputs;
      expect(inputs).toHaveLength(1);
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

      const estimate = await sut.estimateBackfill();

      expect(estimate.refusal).toMatch(/^The AI Wallet has 0\.01 USD available/);
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
      addAssets(photos(ownerA, 40));

      const estimate = await sut.estimateBackfill();

      expect(estimate.modelId).toBe('ms_M72B0000');
      expect(estimate.guidance).toEqual({
        minimumBatch: 200,
        smallBatches: 1,
        suggestedModelId: 'ms_M27B0000',
        suggestedModelName: 'Descriptions · Detailed',
      });
    });

    it('refuses while descriptions may not run on Frameleaf Cloud', async () => {
      configure({ descriptions: 'local' });

      await expect(sut.estimateBackfill()).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
    });

    it('asks for a model when the catalogue recommends none and none is chosen', async () => {
      mocks.frameleafCloudMl.getCatalog.mockResolvedValue(
        catalogSchema.parse({
          ...descriptionsFixture,
          models: descriptionsFixture.models.map((model) => ({ ...model, default: false })),
        }),
      );

      await expect(sut.estimateBackfill()).rejects.toThrow(/choose one in Where each job runs/);
    });
  });

  describe('startBackfill', () => {
    const accepted = { modelId: DEFAULT_SKU, perPhotoP90Usd: 0.0004, startupUsd: 0.02, maxTotalUsd: 0.2 };

    it("queues one batch per owner's 200 photos, never one per photo, with its approval and pack key", async () => {
      addAssets([...photos(ownerA, 250), ...photos(ownerB, 3)]);

      const result = await sut.startBackfill(accepted);

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
        },
      });
      expect((rows[0].snapshot as { approvedP90Usd: number }).approvedP90Usd).toBeCloseTo(0.02 + 200 * 0.0004, 6);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.CloudMlDescriptionBatch, data: {} });
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
    });

    it('refuses when the model changed since the estimate', async () => {
      addAssets(photos(ownerA, 3));

      await expect(sut.startBackfill({ ...accepted, modelId: 'ms_NME7RZQ1' })).rejects.toThrow(/model changed/);
      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
    });

    it('refuses when more photos need a description than were estimated', async () => {
      addAssets(photos(ownerA, 3));

      await expect(sut.startBackfill({ ...accepted, maxTotalUsd: 0.01 })).rejects.toThrow(/estimate again/);
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
      expect(key).toBe('desc-0192f1b0000070008000000000000001-1');

      expect(mocks.mediaOperation.setRemoteJobId).toHaveBeenCalledWith(batch.id, 'claim-1', admitted.jobId);
      expect(mocks.mlDestination.recordAccounting).toHaveBeenCalledWith(
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

    it('fails closed on 503 capacity: one retry, never another destination', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.DestinationUnhealthy, 503, 'Frameleaf Cloud has no capacity now'),
      );
      const batch = operation();

      await sut.step(batch, 'claim-1', now);

      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        batch.id,
        'claim-1',
        { error: 'Frameleaf Cloud has no capacity now', errorCode: 'cloud_description_destination_unhealthy' },
        { retry: true },
      );
      expect(mocks.machineLearning.describeImage).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.setRemoteJobId).not.toHaveBeenCalled();
    });

    it('retries a submission with the same idempotency key and estimate, without estimating again', async () => {
      const batch = operation({
        result: {
          ...emptyCloudDescriptionResult(['a-1', 'a-2']),
          phase: CloudDescriptionPhase.Estimated,
          estimates: 1,
          items: [
            { assetId: 'a-1', inputId: 'p1', sha256: 'ab'.repeat(32), bytes: 1000, contentType: 'image/jpeg' },
            { assetId: 'a-2', inputId: 'p2', sha256: 'ab'.repeat(32), bytes: 1000, contentType: 'image/jpeg' },
          ],
          submission: {
            idempotencyKey: 'desc-0192f1b0000070008000000000000001-1',
            estimate: sealed.estimate,
            expiresAt: sealed.expiresAt,
            modelRev: sealed.modelRev,
            computeSku: sealed.computeSku,
            p50Usd: 0.021,
            p90Usd: 0.024,
            holdUsd: 0.05,
            startupUsd: 0.02,
          },
        },
      });

      await sut.step(batch, 'claim-1', now);

      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ estimate: sealed.estimate }),
        'desc-0192f1b0000070008000000000000001-1',
      );
    });

    it('estimates again under a new key when the sealed estimate was spent or expired', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValueOnce(
        new FrameleafCloudError(MlAdmissionRefusal.ModelMismatch, 409, 'The estimate was already used'),
      );
      const batch = operation();

      await sut.step(batch, 'claim-1', now);

      expect(written()).toMatchObject({ phase: CloudDescriptionPhase.Queued, submission: null });
      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(batch.id, 'claim-1', {
        delayMs: 0,
        returnAttempt: true,
      });
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
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
      const batch = operation();

      await sut.step(batch, 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        batch.id,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_wallet_insufficient' }),
        { retry: false },
      );
    });

    it('refuses a batch estimated well above its approval', async () => {
      const batch = operation({ snapshot: { approvedP90Usd: 0.01 } });

      await sut.step(batch, 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        batch.id,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_estimate_increased' }),
        { retry: false },
      );
    });

    it('refuses when the destination budget has no room for the hold', async () => {
      mocks.mlDestination.getById.mockResolvedValue({ ...cloud, budgetLimitUsd: 1 });
      mocks.mlDestination.getSpend.mockResolvedValue(0.99);
      const batch = operation();

      await sut.step(batch, 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        batch.id,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_budget_exceeded' }),
        { retry: false },
      );
    });

    it('ends a batch whose photos were all left out without sending anything', async () => {
      mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set(['a-1', 'a-2']));
      mocks.mediaOperation.beginValidation.mockResolvedValue(true);
      mocks.mediaOperation.complete.mockResolvedValue(true);
      const batch = operation();

      await sut.step(batch, 'claim-1', now);

      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.complete).toHaveBeenCalledWith(batch.id, 'claim-1', { resultAssetId: null });
    });
  });

  describe('automatic batches and the daily budget', () => {
    const automatic = (overrides: Partial<Record<string, unknown>> = {}) =>
      operation({ snapshot: { origin: 'automatic', approvedP90Usd: null }, ...overrides });

    const admittedBatch = (admittedAt: string, holdUsd: number) =>
      operation({
        row: { id: `other-${admittedAt}`, status: MediaOperationStatus.Queued },
        snapshot: { origin: 'automatic', approvedP90Usd: null },
        result: {
          ...emptyCloudDescriptionResult([]),
          phase: CloudDescriptionPhase.Submitted,
          job: {
            jobId: admitted.jobId,
            status: 'running',
            holdUsd,
            ceilingUsd: holdUsd,
            admittedAt,
            meteredSeconds: null,
          },
        },
      });

    beforeEach(() => {
      addAssets(photos(ownerA, 2, 'a'));
    });

    it('waits for the next day once the budget is spent and tells administrators once', async () => {
      configure({ autoDescribe: true, dailyBudgetUsd: 0.5 });
      mocks.mediaOperation.listRecentOfKind.mockResolvedValue([admittedBatch(now.toISOString(), 0.49)]);
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

    it("resumes the next day: yesterday's spend does not count", async () => {
      configure({ autoDescribe: true, dailyBudgetUsd: 0.5 });
      const yesterday = new Date(nextServerDay(now).getTime() - 2 * 24 * 60 * 60 * 1000 + 60_000);
      mocks.mediaOperation.listRecentOfKind.mockResolvedValue([admittedBatch(yesterday.toISOString(), 5)]);

      await sut.step(automatic(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledTimes(1);
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AdminNotify', expect.anything());
    });

    it('starts no new automatic batch once the budget is spent', async () => {
      configure({ autoDescribe: true, dailyBudgetUsd: 0.5 });
      mocks.mediaOperation.listRecentOfKind.mockResolvedValue([admittedBatch(now.toISOString(), 0.6)]);
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
      const usage = cloudContractFixture<{ items: Array<Record<string, unknown>> }>('ml/usage.json');
      const item = { ...usage.items[0], clientRef: 'batch-0192f1b0-0000-7000-8000-000000000001' };
      mocks.frameleafCloudMl.getUsage.mockResolvedValue({ items: [item as never], refused: 0 });
      mocks.mediaOperation.getForWorker.mockResolvedValue(
        operation({
          row: { status: MediaOperationStatus.Failed, remoteJobId: item.jobId },
          result: {
            ...emptyCloudDescriptionResult(['a-1', 'a-2']),
            phase: CloudDescriptionPhase.Finished,
            items: [
              { assetId: 'a-1', inputId: 'p1', sha256: 'ab'.repeat(32), bytes: 10, contentType: 'image/jpeg' },
              { assetId: 'a-2', inputId: 'p2', refused: 'locked' },
            ],
          },
        }),
      );
      mocks.mediaOperation.setFinishedResult.mockResolvedValue(true);

      await sut.settle(now, true);

      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledWith([
        { cloudJobId: item.jobId, costUsd: 0.0244, credits: null },
      ]);
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
    it('releases the cloud job of a batch cancelled while it waited', async () => {
      mocks.mediaOperation.getUnreleasedRemoteOperations.mockResolvedValue([
        operation({ row: { status: MediaOperationStatus.Cancelled, remoteJobId: admitted.jobId } }),
        { ...operation(), kind: MediaOperationKind.Restoration, remoteJobId: 'other' } as MediaOperation,
      ]);

      await sut.runPass(now);

      expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledTimes(1);
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.mediaOperation.markRemoteReleased).toHaveBeenCalledWith('0192f1b0-0000-7000-8000-000000000001');
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
