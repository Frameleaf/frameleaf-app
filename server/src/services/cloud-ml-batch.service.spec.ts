import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  JobStatus,
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
import { queueExecution, deferJobAdoption } from 'src/queue/context.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import type { QueueExecution } from 'src/queue/types.js';
import { CloudTransferError } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { CloudMlBatchService } from 'src/services/cloud-ml-batch.service.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
import {
  CLOUD_DESCRIPTION_POLL_MS,
  CloudDescriptionPhase,
  emptyCloudDescriptionResult,
  nextServerDay,
  serverDayStart,
} from 'src/utils/cloud-description-batch.js';
import {
  FrameleafCloudError,
  catalogSchema,
  errorEnvelopeSchema,
  estimateResponseSchema,
  jobAdmittedSchema,
  jobCreateRequestSchema,
  jobViewSchema,
  uploadTargetSchema,
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
/** The job's views (FC-39, FC-42, FC-43): running, ended with its cost, and a completed one with its outputs. */
const runningView = jobViewSchema.parse(cloudContractFixture('ml/job-running.json'));
const failedView = jobViewSchema.parse(cloudContractFixture('ml/job-failed.json'));
const completedWithResult = cloudContractFixture<Record<string, any>>('ml/storage/job-completed-result.json');
/** A completed batch job: one output per photo (`p1`, `p2`) and its settled cost (0.2026 USD). */
const completedView = jobViewSchema.parse({
  ...cloudContractFixture<Record<string, unknown>>('ml/job-completed.json'),
  result: {
    ...completedWithResult.result,
    outputs: completedWithResult.result.outputs.map((output: Record<string, unknown>, index: number) => ({
      ...output,
      outputId: `p${index + 1}`,
    })),
  },
});
/** An FC-44 result document for one input. */
const resultDocument = (name: string, inputId: string) => {
  const document = cloudContractFixture<{ items: Array<Record<string, unknown>> }>(`ml/descriptions/${name}`);
  return JSON.stringify({ ...document, items: document.items.map((item) => ({ ...item, inputId })) });
};
const inlineTarget = cloudContractFixture<{ uploads: Array<Record<string, unknown>> }>(
  'ml/storage/upload-targets.json',
).uploads.find((target) => target.method === 'inline')!;
/** The storage target of one prepared photo (every prepared copy digests to `ab…`, 1000 bytes). */
const uploadTarget = (inputId: string) =>
  uploadTargetSchema.parse({
    ...inlineTarget,
    inputId,
    sha256: 'ab'.repeat(32),
    bytes: 1000,
    uploaded: false,
    expiresAt: '2026-09-26T05:00:00.000Z',
  });

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
      items: Array<{ assetId: string; refused?: string; sha256?: string; costShareUsd?: number; outcome?: string }>;
      submission: { idempotencyKey: string; attemptedAt?: string | null } | null;
      job: { jobId: string } | null;
      waiting: { refusal: string } | null;
    };

  const estimates = () =>
    (metadata.get(SystemMetadataKey.FrameleafCloudDescriptionEstimates) as
      { records: CloudDescriptionEstimateRecord[] } | undefined) ?? { records: [] };

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
    mocks.frameleafCloudMl.getUploads.mockResolvedValue(['p1', 'p2', 'p3'].map((id) => uploadTarget(id)));
    mocks.frameleafCloudMl.uploadInput.mockResolvedValue();
    mocks.frameleafCloudMl.startJob.mockResolvedValue({ ...runningView, status: 'queued' });
    mocks.frameleafCloudMl.getJobView.mockResolvedValue({
      notModified: false,
      data: runningView,
      etag: '"v2"',
      retryAfterSeconds: null,
    } as never);

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

    it.each([
      ['a queued batch', () => operation(), 'createEstimate'],
      ['an estimated batch', () => estimated(), 'createJob'],
    ] as const)(
      'sends nothing for %s once its consent is older than the version the cloud requires (FL-201)',
      async (_label, batch, call) => {
        addAssets(photos(ownerA, 2, 'a'));
        mocks.mlDestination.getById.mockResolvedValue({ ...cloud, consentVersion: '2026-09-01.1' });

        await sut.step(batch(), 'claim-1', now);

        expect(mocks.frameleafCloudMl[call]).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
        expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
          BATCH_ID,
          'claim-1',
          expect.objectContaining({ errorCode: 'cloud_description_consent_version_outdated' }),
          { retry: false },
        );
      },
    );

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

      const error = await sut.estimateBackfill(admin, now).catch((error_: unknown) => error_);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'consent-missing',
        message: expect.stringContaining('processing terms'),
      });

      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.getCatalog).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
    });

    it('refuses when admission refuses (an outdated consent), before the catalogue is read', async () => {
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        cloud: { ...facts, consentRequiredVersion: '2026-10-01.1' },
      });

      const error = await sut.estimateBackfill(admin, now).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(BadRequestException);
      // FL-201: the refusal is machine-readable, not only in the message
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'consent-version-outdated',
        message: expect.stringContaining('consent'),
      });
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

      // the Locked photo is never prepared or sent (each other photo is prepared to be digested, then
      // again to be uploaded, and must match its digest)
      expect(mocks.media.writeCloudUpload.mock.calls.map(([preview]) => preview)).toEqual([
        '/thumbs/a-1.webp',
        '/thumbs/a-2.webp',
        '/thumbs/a-1.webp',
        '/thumbs/a-2.webp',
      ]);
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
        // prompts stay in the cloud; names and health signals are off, as the recorded consent says
        request: { length: 'standard', features: { identityNames: false, medicalSignals: false } },
      });
      // the job carries exactly the request its estimate was sealed with
      expect(body.request).toEqual(estimateRequest.request);
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
      // the two photos go to the job's storage, and only then is the job started
      expect(mocks.frameleafCloudMl.uploadInput).toHaveBeenCalledTimes(2);
      expect(mocks.frameleafCloudMl.uploadInput.mock.calls.map(([, target]) => target.inputId)).toEqual(['p1', 'p2']);
      expect(mocks.frameleafCloudMl.startJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(written()).toMatchObject({
        phase: CloudDescriptionPhase.Submitted,
        job: { jobId: admitted.jobId, started: true },
      });
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

    it('asks for names and health signals only when the recorded consent allows them', async () => {
      const allowed = {
        ...cloud,
        lastProbeCloud: { ...facts, features: { identityNames: true, medicalSignals: false, ocrAddon: false } },
      };
      mocks.mlDestination.getById.mockResolvedValue(allowed);

      await sut.step(operation({ assetIds: ['a-1', 'a-2'] }), 'claim-1', now);

      const request = { length: 'standard', features: { identityNames: true, medicalSignals: false } };
      expect(mocks.frameleafCloudMl.createEstimate.mock.calls[0][1].request).toEqual(request);
      expect(mocks.frameleafCloudMl.createJob.mock.calls[0][1].request).toEqual(request);
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

    it('fails a batch whose idempotency key was reused with another body, never sending it again (FC-43)', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.RequestInvalid,
          422,
          'Frameleaf Cloud refused the job: its idempotency key was already used for a different job.',
          errorEnvelopeSchema.parse(cloudContractFixture('errors/idempotency-key-reused.json')),
        ),
      );

      await sut.step(operation(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledTimes(1);
      expect(mocks.logger.error).toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_idempotency_key_reused' }),
        { retry: false },
      );
    });

    it('waits and replays the same key while it is still in flight, never estimating again (FC-43)', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          409,
          'still in flight',
          errorEnvelopeSchema.parse(cloudContractFixture('errors/idempotency-in-flight.json')),
        ),
      );

      await sut.step(operation(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledTimes(1);
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_cloud_unavailable' }),
        { retry: true },
      );
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
    const job = (overrides: Record<string, unknown> = {}) => ({
      jobId: admitted.jobId,
      status: 'running',
      holdUsd: 0.2,
      ceilingUsd: 0.22,
      admittedAt: admitted.createdAt,
      meteredSeconds: null,
      started: true,
      etag: '"v1"',
      ...overrides,
    });
    const submitted = (overrides: Record<string, unknown> = {}) =>
      operation({
        row: { remoteJobId: admitted.jobId },
        result: {
          ...emptyCloudDescriptionResult(['a-1', 'a-2']),
          phase: CloudDescriptionPhase.Submitted,
          items: inputs,
          job: job(overrides),
        },
      });
    const answer = (data: unknown, retryAfterSeconds: number | null = null) =>
      ({ notModified: false, data, etag: '"v2"', retryAfterSeconds }) as never;
    let publish: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      addAssets(photos(ownerA, 2, 'a'));
      publish = vi
        .spyOn(ImageEnrichmentService.prototype, 'publishCloudDescription')
        .mockResolvedValue({ status: JobStatus.Success });
      mocks.mediaOperation.beginValidation.mockResolvedValue(true);
      mocks.mediaOperation.complete.mockResolvedValue(true as never);
      mocks.storage.checkFileExists.mockResolvedValue(false);
      mocks.storage.unlink.mockResolvedValue();
      mocks.storage.readFile.mockImplementation((file) =>
        Promise.resolve(
          Buffer.from(
            file.endsWith('p1.json')
              ? resultDocument('result.json', 'p1')
              : resultDocument('result-failed-item.json', 'p2'),
          ),
        ),
      );
    });

    afterEach(() => {
      publish.mockRestore();
    });

    it("is read again with its ETag after the cloud's Retry-After while the cloud runs it", async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(runningView, 30));

      await expect(sut.step(submitted(), 'claim-1', now)).resolves.toBe(false);

      expect(mocks.frameleafCloudMl.getJobView).toHaveBeenCalledWith(expect.anything(), admitted.jobId, '"v1"');
      expect(mocks.mediaOperation.reportProgress).toHaveBeenCalledWith(BATCH_ID, 'claim-1', {
        status: MediaOperationStatus.Rendering,
        processedUnits: 1,
        totalUnits: 2,
        progress: 50,
      });
      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(BATCH_ID, 'claim-1', {
        delayMs: 30_000,
        returnAttempt: true,
      });
      expect(written().job).toMatchObject({ status: 'running', etag: '"v2"' });
      expect(mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
    });

    it('waits without writing anything when nothing changed (304)', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: true,
        etag: '"v1"',
        retryAfterSeconds: 20,
      } as never);

      await sut.step(submitted(), 'claim-1', now);

      expect(mocks.mediaOperation.setBulkResult).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(BATCH_ID, 'claim-1', {
        delayMs: 20_000,
        returnAttempt: true,
      });
    });

    it('uploads the photos of a job it has not started, resuming what is up, then starts it', async () => {
      const batch = operation({
        row: { remoteJobId: admitted.jobId },
        result: {
          ...emptyCloudDescriptionResult(['a-1', 'a-2']),
          phase: CloudDescriptionPhase.Submitted,
          items: inputs,
          job: job({ status: 'admitted', started: false, etag: null }),
          uploads: { p1: { done: true, parts: [] } },
        },
      });

      await sut.step(batch, 'claim-1', now);

      // the photo already up is neither prepared nor sent again
      expect(mocks.media.writeCloudUpload).toHaveBeenCalledTimes(1);
      expect(mocks.frameleafCloudMl.uploadInput).toHaveBeenCalledTimes(1);
      expect(mocks.frameleafCloudMl.uploadInput.mock.calls[0][1]).toMatchObject({ inputId: 'p2' });
      expect(mocks.frameleafCloudMl.startJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(written()).toMatchObject({ job: { started: true }, uploads: { p2: { done: true } } });
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining(`${BATCH_ID}-upload`), {
        recursive: true,
        force: true,
      });
    });

    it('sends no photo when the cloud refused its own status check before consent could be compared (FL-201 review P2)', async () => {
      mocks.mlDestination.getById.mockResolvedValue({ ...cloud, consentVersion: '2026-09-01.1' });
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        cloud: {
          ...facts,
          consentRequiredVersion: null,
          refusal: { refusal: MlAdmissionRefusal.WalletInsufficient, detail: 'The AI Wallet is empty' },
        },
      });

      await sut.step(submitted({ status: 'admitted', started: false, etag: null }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_consent_unconfirmed' }),
        { retry: true },
      );
    });

    it('still uploads when /capabilities offers no workloads because its own hold used the free balance (FL-201, FC contract)', async () => {
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        workloads: [],
        cloud: { ...facts, balanceUsd: 5, heldUsd: 5 },
      });

      await sut.step(submitted({ status: 'admitted', started: false, etag: null }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.uploadInput).toHaveBeenCalled();
    });

    it('still uploads a created batch whose own hold took the rest of the AI Wallet (FL-201 review P1)', async () => {
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        cloud: { ...facts, balanceUsd: 5, heldUsd: 5 },
      });

      await sut.step(submitted({ status: 'admitted', started: false, etag: null }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.uploadInput).toHaveBeenCalled();
    });

    it.each([
      [
        'older than the version the cloud now requires',
        { consentVersion: '2026-09-01.1' },
        'cloud_description_consent_version_outdated',
      ],
      ['withdrawn', { consentAcknowledgedAt: null, consentVersion: null }, 'cloud_description_consent_missing'],
    ])(
      'sends no photo and cancels the cloud job when consent is %s before its uploads (FL-201)',
      async (_case, change, code) => {
        mocks.mlDestination.getById.mockResolvedValue({ ...cloud, ...change });

        await sut.step(submitted({ status: 'admitted', started: false, etag: null }), 'claim-1', now);

        expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
        expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
          BATCH_ID,
          'claim-1',
          expect.objectContaining({ errorCode: code }),
          { retry: false },
        );
      },
    );

    it.each(['withdrawn', 'version bumped'])(
      'stops between active files when consent is %s (FL-201)',
      async (reason) => {
        const requests: string[] = [];
        mocks.frameleafCloudMl.uploadInput.mockImplementation((_gateway, target) => {
          requests.push(target.inputId);
          if (reason === 'withdrawn') {
            mocks.mlDestination.getById.mockResolvedValue({
              ...cloud,
              consentAcknowledgedAt: null,
              consentVersion: null,
            });
          } else {
            mocks.machineLearning.probe.mockResolvedValue({
              ...mlProbeStub.frameleafCloud,
              cloud: { ...facts, consentRequiredVersion: '2026-10-01.1' },
            });
          }
          return Promise.resolve();
        });
        await sut.step(submitted({ status: 'admitted', started: false, etag: null }), 'claim-1', now);
        expect(requests).toEqual(['p1']);
        expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      },
    );

    it('never uploads a photo that was Locked after the batch was sent', async () => {
      mocks.mediaOperation.getLockedAssetIds.mockResolvedValue(new Set(['a-2']));

      await sut.step(submitted({ status: 'admitted', started: false, etag: null }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_photos_changed' }),
        { retry: false },
      );
    });

    it('refuses to upload a photo that no longer matches what the job was admitted with', async () => {
      mocks.crypto.hashFileDigests.mockResolvedValue({
        sha1: Buffer.alloc(20, 1),
        sha256: Buffer.alloc(32, 0xcd),
        sizeInBytes: 1000,
      });

      await sut.step(submitted({ status: 'admitted', started: false, etag: null }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_photos_changed' }),
        { retry: false },
      );
    });

    it('writes each photo its own result with the model and cost share; one failure does not fail the batch', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(completedView));
      const order: string[] = [];
      publish.mockImplementation((assetId: string) => {
        order.push(`publish ${assetId}`);
        return Promise.resolve({ status: JobStatus.Success });
      });
      mocks.frameleafCloudMl.deleteJob.mockImplementation(() => {
        order.push('release');
        return Promise.resolve();
      });

      await expect(sut.step(submitted(), 'claim-1', now)).resolves.toBe(true);

      // every output is downloaded with the result's headers and checked against its SHA-256
      expect(mocks.frameleafCloudMl.downloadOutput).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledWith(
        'a-1',
        expect.objectContaining({ description: expect.stringContaining('golden retriever'), confidence: 0.87 }),
        expect.objectContaining({ destinationId: cloud.id, modelName: DEFAULT_SKU, failure: undefined }),
      );
      expect(publish).toHaveBeenCalledWith(
        'a-2',
        expect.anything(),
        expect.objectContaining({
          destinationId: cloud.id,
          modelName: DEFAULT_SKU,
          failure: 'Frameleaf Cloud could not describe this photo (input-too-large)',
        }),
      );
      // released only once every photo is written, so a crash before it reads the results again
      expect(order).toEqual(['publish a-1', 'publish a-2', 'release']);
      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      // ml_workload_accounting is settled once for the batch, from the job's own cost
      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledWith([
        { cloudJobId: admitted.jobId, costUsd: 0.2026, credits: null },
      ]);
      expect(written()).toMatchObject({
        phase: CloudDescriptionPhase.Finished,
        settledUsd: 0.2026,
        items: [
          { assetId: 'a-1', outcome: 'described', modelRev: 'mr_B2H147RBJBQ0', costShareUsd: 0.1013 },
          { assetId: 'a-2', outcome: 'failed', warnings: ['input-too-large'], costShareUsd: 0.1013 },
        ],
      });
      expect(mocks.mediaOperation.complete).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        { resultAssetId: null },
        undefined,
        true,
      );
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
    });

    describe('parent queue adoption', () => {
      const execution = (signal = new AbortController().signal): QueueExecution => ({
        claim: {} as QueueExecution['claim'],
        signal,
        progress: () => {},
        progressUnits: 0,
        buffering: true,
        followups: [],
        adoptions: [],
      });
      const adopt = (context: QueueExecution) =>
        queueExecution.run(context, () =>
          publicationTransaction.run({} as never, async () => {
            for (const publish of context.adoptions) await publish({} as never);
            context.signal.throwIfAborted();
          }),
        );

      beforeEach(() => {
        mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(completedView));
        publish.mockImplementation((_id, _item, source) => {
          deferJobAdoption(async () => source.onPublished({ status: JobStatus.Success }));
          return Promise.resolve({ status: JobStatus.Success });
        });
      });

      it('persists outcomes and completes only at adoption, then releases after commit', async () => {
        const context = execution();
        await queueExecution.run(context, () => sut.step(submitted(), 'claim-1', now));
        expect(written().phase).toBe(CloudDescriptionPhase.Submitted);
        expect(written().items.every((item) => !item.outcome)).toBe(true);
        expect(mocks.mediaOperation.complete).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
        await adopt(context);
        expect(written().phase).toBe(CloudDescriptionPhase.Finished);
        expect(mocks.mediaOperation.complete).toHaveBeenCalledWith(
          BATCH_ID,
          'claim-1',
          { resultAssetId: null },
          expect.anything(),
          true,
        );
        expect(mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
        for (const observe of context.afterCommit ?? []) await observe();
        expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledTimes(1);
      });

      it('uses each actual adoption outcome, retaining another eligible photo', async () => {
        mocks.storage.readFile.mockImplementation((file) =>
          Promise.resolve(Buffer.from(resultDocument('result.json', file.endsWith('p1.json') ? 'p1' : 'p2'))),
        );
        publish.mockImplementation((id, _item, source) => {
          deferJobAdoption(async () =>
            source.onPublished(
              id === 'a-1' ? { status: JobStatus.Skipped, reasonKey: 'not-eligible' } : { status: JobStatus.Success },
            ),
          );
          return Promise.resolve({ status: JobStatus.Success });
        });
        const context = execution();
        await queueExecution.run(context, () => sut.step(submitted(), 'claim-1', now));
        await adopt(context);
        expect(written().items).toMatchObject([{ outcome: 'failed', error: 'not-eligible' }, { outcome: 'described' }]);
        expect(mocks.mediaOperation.complete).toHaveBeenCalledTimes(1);
      });

      it('retains the paid job when the media lease is lost before adoption', async () => {
        const context = execution();
        await queueExecution.run(context, () => sut.step(submitted(), 'claim-1', now));
        mocks.mediaOperation.beginValidation.mockResolvedValue(false);
        await expect(adopt(context)).rejects.toThrow('claim changed before adoption');
        expect(written().items.every((item) => !item.outcome)).toBe(true);
        expect(mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
        await context.failureSettlements![0]({} as never, 'lease lost', false);
        expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(
          BATCH_ID,
          'claim-1',
          { delayMs: CLOUD_DESCRIPTION_POLL_MS, returnAttempt: true },
          undefined,
          expect.anything(),
        );
      });

      it('keeps completion when post-commit release fails, and cleanup retries release', async () => {
        const context = execution();
        await queueExecution.run(context, () => sut.step(submitted(), 'claim-1', now));
        await adopt(context);
        mocks.frameleafCloudMl.deleteJob.mockRejectedValueOnce(new Error('offline'));
        for (const observe of context.afterCommit ?? []) await observe();
        expect(mocks.mediaOperation.complete).toHaveBeenCalledTimes(1);
        expect(mocks.mediaOperation.markRemoteReleased).not.toHaveBeenCalled();
        mocks.mediaOperation.getUnreleasedRemoteOperations.mockResolvedValue([
          { ...submitted(), status: MediaOperationStatus.Completed },
        ]);
        await sut.runPass(now);
        expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledTimes(2);
        expect(mocks.mediaOperation.markRemoteReleased).toHaveBeenCalledWith(BATCH_ID);
        expect(publish).toHaveBeenCalledTimes(2);
      });
    });

    it('records the model by its name when the batch knows it', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(completedView));
      const batch = submitted();
      (batch.snapshot as Record<string, unknown>).modelName = 'Qwen3.5-9B';

      await sut.step(batch, 'claim-1', now);

      expect(publish).toHaveBeenCalledWith(
        'a-1',
        expect.anything(),
        expect.objectContaining({ modelName: 'Qwen3.5-9B' }),
      );
    });

    it('fails only the photo whose result names another model or cannot be read', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(completedView));
      mocks.storage.readFile.mockImplementation((file) =>
        Promise.resolve(
          Buffer.from(
            file.endsWith('p1.json')
              ? resultDocument('result.json', 'p1')
              : JSON.stringify({ ...JSON.parse(resultDocument('result.json', 'p2')), modelSku: 'ms_NME7RZQ1' }),
          ),
        ),
      );

      await sut.step(submitted(), 'claim-1', now);

      expect(publish).toHaveBeenCalledWith(
        'a-2',
        expect.anything(),
        expect.objectContaining({
          failure: 'Frameleaf Cloud returned no readable description for this photo',
        }),
      );
      expect(written().items.map(({ outcome }) => outcome)).toEqual(['described', 'failed']);
      expect(mocks.mediaOperation.complete).toHaveBeenCalled();
    });

    it('never reads an output larger than 16,384 bytes, and fails only that photo', async () => {
      const oversized = {
        ...completedView,
        result: {
          ...completedView.result!,
          outputs: completedView.result!.outputs.map((output) =>
            output.outputId === 'p2' ? { ...output, bytes: 16_385 } : output,
          ),
        },
      };
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(oversized));

      await sut.step(submitted(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.downloadOutput).toHaveBeenCalledTimes(1);
      expect(mocks.frameleafCloudMl.downloadOutput.mock.calls[0][1]).toMatchObject({ outputId: 'p1' });
      expect(written().items.map(({ outcome }) => outcome)).toEqual(['described', 'failed']);
    });

    it('fails a photo whose output holds no item for its own input', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(completedView));
      mocks.storage.readFile.mockImplementation(() =>
        Promise.resolve(Buffer.from(resultDocument('result.json', 'p1'))),
      );

      await sut.step(submitted(), 'claim-1', now);

      // p2's document describes p1: it is never written to the photo of p2
      expect(publish).toHaveBeenCalledWith(
        'a-2',
        expect.anything(),
        expect.objectContaining({ failure: 'Frameleaf Cloud returned no readable description for this photo' }),
      );
      expect(written().items.map(({ outcome }) => outcome)).toEqual(['described', 'failed']);
    });

    it('keeps one photo failing to be written from failing the others', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(completedView));
      mocks.storage.readFile.mockImplementation((file) =>
        Promise.resolve(Buffer.from(resultDocument('result.json', file.endsWith('p1.json') ? 'p1' : 'p2'))),
      );
      publish.mockRejectedValueOnce(new Error('database unavailable'));

      await sut.step(submitted(), 'claim-1', now);

      expect(written().items).toMatchObject([
        { assetId: 'a-1', outcome: 'failed', error: 'database unavailable' },
        { assetId: 'a-2', outcome: 'described' },
      ]);
      expect(mocks.mediaOperation.complete).toHaveBeenCalled();
    });

    it('fails the batch, after releasing its job, when no photo could be described', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(completedView));
      mocks.storage.readFile.mockResolvedValue(Buffer.from('not json'));

      await sut.step(submitted(), 'claim-1', now);

      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_nothing_described' }),
        { retry: false, executor: undefined },
      );
    });

    it('reads an ended job afresh, without its ETag, so its result addresses are current', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(completedView));

      await sut.step(submitted({ status: 'completed' }), 'claim-1', now);

      expect(mocks.frameleafCloudMl.getJobView).toHaveBeenCalledWith(expect.anything(), admitted.jobId, null);
    });

    it('keeps nothing from an output whose SHA-256 does not match, and tries again later', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(completedView));
      mocks.frameleafCloudMl.downloadOutput.mockRejectedValue(
        new CloudTransferError('sha256-mismatch', 'The output did not match its SHA-256', null),
      );

      await sut.step(submitted(), 'claim-1', now);

      expect(publish).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_description_output_sha256_mismatch' }),
        { retry: true },
      );
    });

    it("releases a job that failed and writes nothing, with the cloud's own reason", async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(failedView));

      await expect(sut.step(submitted(), 'claim-1', now)).resolves.toBe(true);

      expect(publish).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), admitted.jobId);
      expect(mocks.mediaOperation.markRemoteReleased).toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        BATCH_ID,
        'claim-1',
        { errorCode: 'cloud_description_job_worker_unavailable', error: failedView.error!.message },
        { retry: false, executor: undefined },
      );
    });

    it('cancels and releases the cloud job when its owner cancels the batch', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue(answer(runningView));
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
    it('leaves stopped-parent settlement in charge when collection is aborted', async () => {
      const abort = new AbortController();
      const context: QueueExecution = {
        claim: {} as QueueExecution['claim'],
        signal: abort.signal,
        progress: () => {},
        progressUnits: 0,
        buffering: true,
        followups: [],
        adoptions: [],
      };
      mocks.mediaOperation.claimNext.mockResolvedValueOnce({ operation: operation(), claimToken: 'claim-1' });
      const step = vi.spyOn(sut, 'step').mockImplementation(async () => {
        abort.abort(new Error('parent stopped'));
        abort.signal.throwIfAborted();
        return false;
      });
      await expect(queueExecution.run(context, () => sut.runPass(now))).rejects.toThrow('parent stopped');
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
      step.mockRestore();
    });

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

    it('still releases a job that had ended when its cancel answers job-ended', async () => {
      mocks.mediaOperation.getUnreleasedRemoteOperations.mockResolvedValue([
        operation({ row: { status: MediaOperationStatus.Completed, remoteJobId: admitted.jobId } }),
      ]);
      mocks.frameleafCloudMl.cancelJob.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.RequestInvalid, 409, 'This job already ended.', {
          code: 'job-ended',
          message: 'This job already ended.',
          retryable: false,
          refusal: null,
          detail: null,
          data: null,
          requestId: null,
        }),
      );

      await sut.runPass(now);

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
