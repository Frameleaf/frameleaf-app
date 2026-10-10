import { BadRequestException, ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { MediaOperation } from 'src/repositories/media-operation.repository.js';
import type { CloudJobView, CloudUploadTarget } from 'src/utils/frameleaf-cloud.js';
import { defaults } from 'src/config.js';
import { AssetRestorationMode, AssetRestorationStatus } from 'src/dtos/asset-restoration.dto.js';
import { CloudMlJobEstimateRequestDto } from 'src/dtos/cloud-ml-job.dto.js';
import {
  AssetType,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  SystemMetadataKey,
} from 'src/enum.js';
import { AssetRestoration, AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { CloudTransferError } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { CloudMlJobService } from 'src/services/cloud-ml-job.service.js';
import {
  CloudMlJobEstimateRecord,
  CloudMlJobPhase,
  CloudMlJobResult,
  cloudMlJobActivity,
  cloudMlJobCanPause,
  cloudMlJobSpentUsd,
  emptyCloudMlJobResult,
} from 'src/utils/cloud-ml-job.js';
import * as cloudDisclosure from 'src/utils/frameleaf-cloud.js';
import {
  CloudCatalogEntry,
  FrameleafCloudError,
  catalogSchema,
  errorEnvelopeSchema,
  estimateResponseSchema,
  jobAdmittedSchema,
  jobViewSchema,
} from 'src/utils/frameleaf-cloud.js';
import { stripsVideoMetadata } from 'src/utils/media-privacy.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const identitySigner = {
  kid: 'kid-1',
  publicJwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x: 'x' },
  sign: () => 'header.payload.signature',
};

/** The restoration catalogue: ms_YS60DAXB (Faithful, the default, 0.1 USD start fee) and ms_F1SSRED6 (Creative). */
const restorationCatalog = catalogSchema.parse(cloudContractFixture('ml/catalog-restoration.json'));
const FAITHFUL = 'ms_YS60DAXB';
const FAITHFUL_REV = 'mr_4H8QZ2N7C1TX';
/** A Smooth motion (interpolation) model beside them, shaped like the published entries. */
const SMOOTH = 'ms_RFM4N2T8';
const SMOOTH_REV = 'mr_7Q2W9E4R6T8Y';
const smoothModel: CloudCatalogEntry = {
  ...restorationCatalog.models[0],
  sku: SMOOTH,
  rev: SMOOTH_REV,
  workload: 'interpolation',
  mode: null,
  label: 'Smooth motion',
};
const catalog = { ...restorationCatalog, models: [...restorationCatalog.models, smoothModel] };

/** A sealed estimate for the faithful model, planned on five workers (five 0.1 USD start fees). */
const sealed = {
  ...estimateResponseSchema.parse(cloudContractFixture('ml/estimate-response.json')),
  modelSku: FAITHFUL,
  modelRev: FAITHFUL_REV,
  cost: { p50: 1.2, p90: 1.6, startup: 0.5, hold: 2, minimum: 0.1 },
};
const admitted = {
  ...jobAdmittedSchema.parse(cloudContractFixture('ml/job-admitted.json')),
  modelSku: FAITHFUL,
  modelRev: FAITHFUL_REV,
};
const JOB_ID = admitted.jobId;
/** Before the sealed estimate's `expiresAt` (04:15). */
const now = new Date('2026-09-26T04:05:00.000Z');
const ESTIMATE_ID = '5f0c6f8e-2b1a-4c3d-9e8f-1a2b3c4d5e6f';
const OPERATION_ID = '0195e2a0-0000-7000-8000-00000000c162';
const RESTORATION_ID = '0195e2a0-0000-7000-8000-00000000a162';
const SHA = 'ab'.repeat(32);
const BYTES = 9_000_000;

const workloads = [MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative, MlWorkload.Interpolation];
const facts = {
  ...mlDestinationStub.frameleafCloudConsented.lastProbeCloud!,
  modelIds: [FAITHFUL, 'ms_F1SSRED6', SMOOTH],
  modelWorkloads: {
    [FAITHFUL]: MlWorkload.RestorationFaithful,
    ms_F1SSRED6: MlWorkload.RestorationCreative,
    [SMOOTH]: MlWorkload.Interpolation,
  },
  defaultModels: { 'restoration-faithful': FAITHFUL, 'restoration-creative': 'ms_F1SSRED6', interpolation: SMOOTH },
  modelGroups: { [FAITHFUL]: 'restoration-faithful', ms_F1SSRED6: 'restoration-creative', [SMOOTH]: 'interpolation' },
};
const cloud = {
  ...mlDestinationStub.frameleafCloudConsented,
  budgetLimitUsd: null,
  workloads,
  lastProbeWorkloads: workloads,
  lastProbeCloud: facts,
};

/** A restoration preview of the video, on Frameleaf Cloud. */
const preview = (overrides: Partial<CloudMlJobEstimateRequestDto> = {}): CloudMlJobEstimateRequestDto => ({
  assetId: 'asset-1',
  purpose: 'restoration',
  stage: 'preview',
  destinationId: cloud.id,
  ...overrides,
});

const owner = { user: { id: 'owner-1', isAdmin: false }, session: undefined } as unknown as AuthDto;

const source = {
  id: 'asset-1',
  ownerId: 'owner-1',
  type: AssetType.Video,
  visibility: 'timeline',
  originalFileName: 'Holiday.mp4',
  originalPath: '/library/owner-1/Holiday.mp4',
  checksum: Buffer.alloc(20, 7),
  exifInfo: { exifImageWidth: 1920, exifImageHeight: 1080, orientation: null },
  format: { formatName: 'mp4', formatLongName: 'mp4', duration: '00:01:00.000', bitrate: 0 },
  files: [],
};

/** Every multipart target for the one input: two parts, the second one short. */
const target = (overrides: Partial<CloudUploadTarget> = {}): CloudUploadTarget => ({
  inputId: 'v1',
  bytes: BYTES,
  contentType: 'video/mp4',
  sha256: SHA,
  method: 'multipart',
  headers: { 'x-amz-server-side-encryption-customer-algorithm': 'AES256', 'content-type': 'video/mp4' },
  inline: null,
  multipart: {
    partBytes: 8_388_608,
    parts: [
      { partNumber: 1, url: 'https://storage.eu.cloud.test/in/v1?partNumber=1', bytes: 8_388_608 },
      { partNumber: 2, url: 'https://storage.eu.cloud.test/in/v1?partNumber=2', bytes: BYTES - 8_388_608 },
    ],
    completeUrl: 'https://storage.eu.cloud.test/in/v1?uploadId=u1',
  },
  uploaded: false,
  expiresAt: '2026-09-26T04:20:00.000Z',
  ...overrides,
});

/** A job view built from the published fixtures, for this job. */
const view = (name: string, overrides: Partial<CloudJobView> = {}): CloudJobView => ({
  ...jobViewSchema.parse(cloudContractFixture(`ml/${name}`)),
  jobId: JOB_ID,
  modelSku: FAITHFUL,
  modelRev: FAITHFUL_REV,
  ...overrides,
});

/** One output of a chunked video, by shard. */
const output = (outputId: string) => ({
  outputId,
  url: `https://storage.eu.cloud.test/out/${outputId}`,
  sha256: SHA,
  bytes: 10,
  contentType: 'video/mp4',
});

const completedWithOutputs = () =>
  view('job-completed.json', {
    // shard 1 is listed first: the outputs are joined by shard, not in the order given
    result: {
      outputs: [output('v1-s1'), output('v1-s0')],
      headers: { 'x-amz-server-side-encryption-customer-algorithm': 'AES256' },
      expiresAt: '2026-09-26T04:30:00.000Z',
      modelSku: FAITHFUL,
      modelRev: FAITHFUL_REV,
    },
  });

/** A cloud job the worker already follows. */
const runningRecord = (): NonNullable<CloudMlJobResult['job']> => ({
  jobId: JOB_ID,
  status: 'running',
  holdUsd: 2,
  ceilingUsd: 2.2,
  meteredUsd: 0.1,
  meteredSeconds: 10,
  workers: 1,
  startFees: 1,
  progress: null,
  etag: null,
  admittedAt: now.toISOString(),
  startedAt: now.toISOString(),
  error: null,
});

const wallet = (balanceUsd: number) => ({
  balanceUsd,
  heldUsd: 0,
  dailyCapUsd: 20,
  spentTodayUsd: 0,
  topUpUrl: null,
  autoTopUp: false,
  settingsUrl: null,
});

describe(CloudMlJobService.name, () => {
  let sut: CloudMlJobService;
  let mocks: ServiceMocks;
  let metadata: Map<string, unknown>;
  let restorations: Record<keyof AssetRestorationRepository, ReturnType<typeof vi.fn>>;
  let rows: Map<string, AssetRestoration>;
  let created: MediaOperation | undefined;

  type Spender = { userId: string; monthlyCapUsd: number | null };
  const configure = ({
    enabled = true,
    restoration = 'both',
    spenders = [{ userId: 'owner-1', monthlyCapUsd: null }],
  }: { enabled?: boolean; restoration?: string; spenders?: Spender[] } = {}) => {
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        (key === SystemMetadataKey.SystemConfig
          ? {
              frameleafCloud: {
                cloudMl: {
                  ...defaults.frameleafCloud.cloudMl,
                  enabled,
                  routing: {
                    ...defaults.frameleafCloud.cloudMl.routing,
                    restoration,
                    interpolation: 'both',
                    upscale: 'both',
                  },
                  spenders,
                },
              },
            }
          : (metadata.get(key) ?? null)) as never,
      ),
    );
  };

  /** The last result the worker wrote, as the next claim reads it. */
  const written = (): CloudMlJobResult =>
    mocks.mediaOperation.setBulkResult.mock.calls.at(-1)?.[2].result as unknown as CloudMlJobResult;

  /** The confirmed job's result as it was created. */
  const confirmed = (): CloudMlJobResult => created!.result as unknown as CloudMlJobResult;

  /** The confirmed job as the worker claims it, with the result given. */
  const claimed = (result: Partial<CloudMlJobResult> = {}): MediaOperation =>
    ({
      ...created!,
      id: OPERATION_ID,
      status: MediaOperationStatus.Preparing,
      result: { ...confirmed(), ...result },
      remoteJobId: null,
      claimToken: 'claim',
      cancelRequestedAt: null,
      pauseRequestedAt: null,
    }) as unknown as MediaOperation;

  /** A job the worker started on Frameleaf Cloud, which it now follows. */
  const following = () => claimed({ phase: CloudMlJobPhase.Started, job: runningRecord() });

  const estimates = () =>
    (metadata.get(SystemMetadataKey.FrameleafCloudMlJobEstimates) as { records: CloudMlJobEstimateRecord[] }).records;

  const estimateAndConfirm = async () => {
    const estimate = await sut.estimate(owner, preview({ upscale: 2 }), now);
    await sut.create(
      owner,
      { estimateId: estimate.estimateId, consentVersion: estimate.consent.version, acknowledgeDataLeaves: true },
      now,
    );
    return estimate;
  };

  /** The version the job renders, as its worker finds it once running. */
  const rendering = () => {
    rows.set(RESTORATION_ID, { ...rows.get(RESTORATION_ID)!, status: AssetRestorationStatus.PreviewRendering });
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks = getMocks();
    metadata = new Map();
    rows = new Map();
    created = undefined;
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

    // the fake gateway: the published contract shapes, for one job
    mocks.frameleafCloudMl.getCatalog.mockResolvedValue(catalog);
    mocks.frameleafCloudMl.createEstimate.mockResolvedValue(sealed);
    mocks.frameleafCloudMl.createJob.mockResolvedValue(admitted);
    mocks.frameleafCloudMl.getWallet.mockResolvedValue(wallet(10));
    mocks.frameleafCloudMl.getConsent.mockResolvedValue({
      requiredVersion: '2026-09-26.1',
      recordedVersion: '2026-09-26.1',
      recordedAt: '2026-09-26T00:00:00.000Z',
      features: { identityNames: false, medicalSignals: false, ocrAddon: false },
      summary: 'Previews leave this server; metadata is removed; nothing is kept after the job.',
      textSha256: 'cd'.repeat(32),
      documentUrl: null,
    });
    mocks.frameleafCloudMl.getUploads.mockResolvedValue([target()]);
    mocks.frameleafCloudMl.refreshUpload.mockResolvedValue(target({ expiresAt: '2026-09-26T05:00:00.000Z' }));
    mocks.frameleafCloudMl.uploadInput.mockImplementation(async (_gateway, uploadTarget, _file, options) => {
      for (const part of uploadTarget.multipart?.parts ?? []) {
        if (!options?.done?.some((entry) => entry.partNumber === part.partNumber)) {
          await options?.onPart?.({ partNumber: part.partNumber, etag: `"e${part.partNumber}"` });
        }
      }
    });
    mocks.frameleafCloudMl.startJob.mockResolvedValue(view('job-queued.json'));
    mocks.frameleafCloudMl.getJobView.mockResolvedValue({
      notModified: false,
      data: view('job-running.json', { progress: { done: 2, total: 5, unit: 'segments', etaSeconds: 30 } }),
      etag: '"e1"',
      retryAfterSeconds: 7,
    });
    mocks.frameleafCloudMl.downloadOutput.mockResolvedValue();
    mocks.frameleafCloudMl.cancelJob.mockResolvedValue();
    mocks.frameleafCloudMl.deleteJob.mockResolvedValue();

    mocks.mlDestination.getAll.mockResolvedValue([cloud]);
    mocks.mlDestination.getById.mockResolvedValue(cloud);
    mocks.mlDestination.getSpend.mockResolvedValue(0);
    mocks.mlDestination.getCloudModelChoice.mockResolvedValue(null);
    mocks.mlDestination.applySettlements.mockResolvedValue(1);
    mocks.mlDestination.recordCloudJobAccounting.mockResolvedValue(true);
    mocks.machineLearning.probe.mockResolvedValue({ ...mlProbeStub.frameleafCloud, workloads, cloud: facts });

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([source.id]));
    mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(source as never);
    mocks.media.probe.mockResolvedValue({
      format: { formatName: 'mp4', formatLongName: 'mp4', duration: 5, bitrate: 0 },
      videoStreams: [{ width: 960, height: 540, codecName: 'h264' }],
      audioStreams: [],
    } as never);
    mocks.crypto.hashFileDigests.mockResolvedValue({
      sha1: Buffer.alloc(20),
      sha256: Buffer.from(SHA, 'hex'),
      sizeInBytes: BYTES,
    });
    mocks.crypto.randomUUID.mockReturnValue(ESTIMATE_ID);
    mocks.storage.stat.mockResolvedValue({ size: BYTES } as never);
    mocks.storage.checkFileExists.mockResolvedValue(true);

    mocks.mediaOperation.create.mockImplementation((row) => {
      created = { ...row, id: OPERATION_ID, status: MediaOperationStatus.Queued } as unknown as MediaOperation;
      return Promise.resolve(created);
    });
    // the transaction of a confirmation: its rows, then the job, then the link, as one
    mocks.mediaOperation.createWithin.mockImplementation(async (bind, after) => {
      const { operation, value } = await bind({} as never);
      const inserted = await mocks.mediaOperation.create(operation);
      await after({} as never, inserted, value);
      return { operation: inserted, value };
    });
    mocks.mediaOperation.getLatestBySubject.mockResolvedValue([]);
    mocks.mediaOperation.listUnacknowledgedCloudMlJobs.mockResolvedValue([]);
    mocks.mediaOperation.listUnfinishedCloudMlJobSnapshots.mockResolvedValue([]);
    mocks.mediaOperation.listCloudMlJobSpend.mockResolvedValue([]);
    mocks.mediaOperation.listUnreconciledCancelledCloudMlJobs.mockResolvedValue([]);
    mocks.mediaOperation.getForWorker.mockImplementation(() => Promise.resolve(created));
    mocks.mediaOperation.getForOwner.mockImplementation(() => Promise.resolve(created));
    mocks.mediaOperation.setBulkResult.mockResolvedValue({
      status: MediaOperationStatus.Preparing,
      cancelRequestedAt: null,
      pauseRequestedAt: null,
    });
    mocks.mediaOperation.setRemoteJobId.mockResolvedValue(true);
    mocks.mediaOperation.requeue.mockResolvedValue(true);
    mocks.mediaOperation.fail.mockResolvedValue('failed');
    mocks.mediaOperation.reportProgress.mockResolvedValue(true);
    mocks.mediaOperation.heartbeat.mockResolvedValue(true);
    mocks.mediaOperation.beginValidation.mockResolvedValue(true);
    mocks.mediaOperation.markRemoteReleased.mockResolvedValue();
    mocks.mediaOperation.acknowledgeCancel.mockResolvedValue(true);
    mocks.mediaOperation.settlePause.mockResolvedValue(true);
    mocks.mediaOperation.getUnreleasedRemoteOperations.mockResolvedValue([]);
    mocks.mediaOperation.listCloudMlJobsAwaitingCost.mockResolvedValue([]);
    mocks.mediaOperation.setFinishedResult.mockResolvedValue(true);
    mocks.mediaOperation.publishValidated.mockImplementation(async (_id, _token, publish) =>
      (await publish({} as never)) ? 'completed' : 'rejected',
    );

    const row = (input: Partial<AssetRestoration>): AssetRestoration =>
      ({
        id: RESTORATION_ID,
        revision: 1,
        status: AssetRestorationStatus.PreviewQueued,
        provenance: {},
        ...input,
      }) as unknown as AssetRestoration;
    restorations = {
      create: vi.fn().mockImplementation((input: Partial<AssetRestoration>) => {
        const inserted = row(input);
        rows.set(inserted.id, inserted);
        return Promise.resolve(inserted);
      }),
      get: vi.fn().mockImplementation((id: string) => Promise.resolve(rows.get(id))),
      getForOwner: vi.fn().mockImplementation((id: string) => Promise.resolve(rows.get(id))),
      listByAsset: vi.fn(),
      getCurrent: vi.fn(),
      listRestoredForPlayback: vi.fn(),
      update: vi.fn().mockImplementation((id: string, patch: Partial<AssetRestoration>) => {
        const updated = { ...rows.get(id)!, ...patch } as AssetRestoration;
        rows.set(id, updated);
        return Promise.resolve(updated);
      }),
      transition: vi
        .fn()
        .mockImplementation((id: string, from: AssetRestorationStatus[], patch: Partial<AssetRestoration>) => {
          const current = rows.get(id);
          if (!current || !from.includes(current.status as AssetRestorationStatus)) {
            return Promise.resolve();
          }
          const updated = { ...current, ...patch } as AssetRestoration;
          rows.set(id, updated);
          return Promise.resolve(updated);
        }),
      setCurrent: vi.fn(),
      listExpiredPreviews: vi.fn(),
      listExpiredResults: vi.fn(),
      clearExpiredResult: vi.fn(),
      alignWithOperations: vi.fn(),
      getFilePaths: vi.fn(),
      deleteByAsset: vi.fn(),
    };

    sut = new CloudMlJobService(
      mocks.logger as never,
      mocks.access as never,
      mocks.assetJob as never,
      mocks.config as never,
      mocks.crypto as never,
      mocks.database as never,
      mocks.event as never,
      mocks.frameleafCloud as never,
      mocks.frameleafCloudMl as never,
      mocks.instanceIdentity as never,
      mocks.job as never,
      mocks.machineLearning as never,
      mocks.mediaOperation as never,
      mocks.media as never,
      mocks.mlDestination as never,
      restorations as unknown as AssetRestorationRepository,
      mocks.storage as never,
      mocks.systemMetadata as never,
    );
  });

  describe('estimate', () => {
    it('estimates approved restoration through the real disclosure policy and current consent (FL-286)', async () => {
      vi.restoreAllMocks();
      expect(vi.isMockFunction(cloudDisclosure.hasPendingCloudDisclosure)).toBe(false);
      const estimate = await sut.estimate(owner, preview(), now);
      expect(estimate).toMatchObject({ estimateId: ESTIMATE_ID, consent: { version: '2026-09-26.1' } });
      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledOnce();
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
      expect(metadata.has(SystemMetadataKey.FrameleafCloudMlJobEstimates)).toBe(true);
    });

    it('prepares and sends nothing when the consent is older than the version the cloud requires (FL-201)', async () => {
      const stale = { ...cloud, consentVersion: '2026-09-01.1' };
      mocks.mlDestination.getAll.mockResolvedValue([stale]);
      mocks.mlDestination.getById.mockResolvedValue(stale);

      const error = await sut.estimate(owner, preview(), now).catch((error_: unknown) => error_);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        statusCode: 400,
        code: 'consent-version-outdated',
        message: expect.stringContaining('consent-version-outdated'),
      });
      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
    });

    it('shows GPU time × rate + start fees as p50–p90, a per-minute estimate, the workers and the wallet', async () => {
      const estimate = await sut.estimate(owner, preview({ upscale: 2 }), now);

      expect(estimate).toMatchObject({
        estimateId: ESTIMATE_ID,
        expiresAt: sealed.expiresAt,
        workload: MlWorkload.RestorationFaithful,
        model: { sku: FAITHFUL, rev: FAITHFUL_REV, label: 'Restore · Faithful', rank: 1 },
        p50Usd: 1.2,
        p90Usd: 1.6,
        startupUsd: 0.5,
        startFeeUsd: 0.1,
        perSecondUsd: 0.001301,
        holdUsd: 2,
        plannedWorkers: 5,
        availableUsd: 10,
        consent: { version: '2026-09-26.1' },
        refusal: null,
      });
      // five seconds of preview, as a per-minute estimate with the start fees included, never a price
      expect(estimate.perUnit).toEqual({ unit: 'minute', quantity: 0.08, p50Usd: 14.4, p90Usd: 19.2 });
      // the slider offers every model of this work's group, light to heavy, and never a model name
      expect(estimate.models).toEqual([
        {
          sku: FAITHFUL,
          rev: FAITHFUL_REV,
          label: 'Restore · Faithful',
          gpu: 'L40S-class, 48 GB',
          rank: 1,
          perSecondUsd: 0.001301,
          startFeeUsd: 0.1,
        },
      ]);
      // the sealed estimate names the model on the slider and the prepared input by its digest only
      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledWith(expect.anything(), {
        workload: 'restoration',
        modelSku: FAITHFUL,
        inputs: [{ inputId: 'v1', contentType: 'video/mp4', bytes: BYTES, sha256: SHA }],
        request: { mode: 'faithful', scale: 2 },
      });
      expect(estimates()[0]).toMatchObject({ id: ESTIMATE_ID, expiresAt: sealed.expiresAt, operationId: null });
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
    });

    it('never plans more than five workers, one start fee each', async () => {
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({ ...sealed, cost: { ...sealed.cost, startup: 0.8 } });

      const estimate = await sut.estimate(owner, preview(), now);
      expect(estimate.plannedWorkers).toBe(5);
    });

    it('prepares the preview without metadata: only the video stream is uploaded, never the original', async () => {
      await sut.estimate(owner, preview(), now);

      const [first, second] = mocks.media.transcode.mock.calls;
      expect(first[0]).toBe(source.originalPath);
      expect(stripsVideoMetadata(first[2].outputOptions)).toBe(true);
      // the uploaded copy is cut from the stripped before clip, with no audio and no metadata
      expect(second[0]).toBe(first[1]);
      expect(second[2].outputOptions).toEqual(expect.arrayContaining(['-map', '0:v:0', '-an']));
      expect(stripsVideoMetadata(second[2].outputOptions)).toBe(true);
      const [record] = estimates();
      expect(record.inputs[0].path).toBe(second[1]);
      expect(record.inputs[0].path).not.toBe(source.originalPath);
      expect(record.beforePath).toBe(first[1]);
    });

    it('refuses to send a job the AI Wallet cannot hold, without offering a lighter model', async () => {
      mocks.frameleafCloudMl.getWallet.mockResolvedValue(wallet(1));

      const estimate = await sut.estimate(owner, preview(), now);
      expect(estimate.refusal).toMatchObject({ code: 'insufficient-credits' });
      expect(estimate.model.sku).toBe(FAITHFUL);
    });

    it('sends the owner back to the model slider when the chosen model is not offered (model-mismatch)', async () => {
      const error = await sut
        .estimate(owner, preview({ modelSku: 'ms_NME7RZQ1' }), now)
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'model-mismatch' });
      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
    });

    it('answers 402 when the cloud refuses the estimate for money, keeping no prepared copy', async () => {
      mocks.frameleafCloudMl.createEstimate.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.WalletInsufficient, 402, 'Your AI Wallet balance is too low'),
      );

      const error = await sut.estimate(owner, preview(), now).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(402);
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining(`cloud_ml_${ESTIMATE_ID}`), {
        recursive: true,
        force: true,
      });
    });

    it('never moves work to Frameleaf Cloud that Where each job runs keeps on this server', async () => {
      configure({ restoration: 'local' });

      await expect(sut.estimate(owner, preview(), now)).rejects.toThrow('keeps this work on this server');
      expect(mocks.frameleafCloudMl.createEstimate).not.toHaveBeenCalled();
    });

    it('estimates Smooth motion as interpolation with its frame-rate factor, and only for videos', async () => {
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({ ...sealed, modelSku: SMOOTH, modelRev: SMOOTH_REV });

      const estimate = await sut.estimate(owner, preview({ purpose: 'smooth-motion', factor: 4 }), now);
      expect(estimate.workload).toBe(MlWorkload.Interpolation);
      expect(estimate.model.sku).toBe(SMOOTH);
      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workload: 'interpolation', modelSku: SMOOTH, request: { factor: 4 } }),
      );

      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({ ...source, type: AssetType.Image } as never);
      await expect(sut.estimate(owner, preview({ purpose: 'smooth-motion' }), now)).rejects.toThrow(
        'Smooth motion is for videos',
      );
    });
  });

  describe('estimate of a whole video', () => {
    const files = new Map<string, Buffer>();

    beforeEach(() => {
      files.clear();
      rows.set(RESTORATION_ID, {
        id: RESTORATION_ID,
        revision: 1,
        assetId: source.id,
        ownerId: source.ownerId,
        status: AssetRestorationStatus.PreviewReady,
        mode: AssetRestorationMode.Faithful,
        upscale: 2,
        keepGrain: false,
        previewRegion: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        destinationKind: MlDestinationKind.FrameleafCloud,
        destinationId: cloud.id,
        provenance: { preview: { modelSku: FAITHFUL, modelRev: FAITHFUL_REV } },
      } as unknown as AssetRestoration);
      mocks.storage.createOrOverwriteFile.mockImplementation((file: string, buffer: Buffer) => {
        files.set(file, buffer);
        return Promise.resolve();
      });
      mocks.storage.readJsonFile.mockImplementation((file: string) =>
        files.has(file)
          ? Promise.resolve(JSON.parse(files.get(file)!.toString()))
          : Promise.reject(new Error('ENOENT')),
      );
    });

    const full = () => preview({ stage: 'full', restorationId: RESTORATION_ID });
    const prepared = () =>
      Promise.all((sut as unknown as { preparing: Map<string, Promise<void>> }).preparing.values());

    it('prepares the video once, in the background, and reuses the copy for every estimate of it', async () => {
      await expect(sut.estimate(owner, full(), now)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'input-preparing', retryAfterSeconds: 5 }),
      });
      await prepared();

      const first = await sut.estimate(owner, full(), now);
      await sut.estimate(owner, full(), now);

      // one re-encode for three estimates; the full stage offers only the model its preview ran
      expect(mocks.media.transcode).toHaveBeenCalledTimes(1);
      expect(first.models.map((model) => model.sku)).toEqual([FAITHFUL]);
      const [input] = estimates().at(-1)!.inputs;
      expect(input.path).toContain('cloud_ml_input_');
      // a stream copy drops the camera's own SEI data too
      const options = mocks.media.transcode.mock.calls[0][2];
      expect(options.outputOptions).toEqual(expect.arrayContaining(['-bsf:v', 'filter_units=remove_types=6']));
      expect(stripsVideoMetadata(options.outputOptions)).toBe(true);
    });

    it('quotes the whole file without a reviewed preview, and refuses to confirm the quote (FL-348)', async () => {
      const quote = () => preview({ stage: 'full', mode: AssetRestorationMode.Faithful, upscale: 2 });
      await expect(sut.estimate(owner, quote(), now)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'input-preparing' }),
      });
      await prepared();

      const estimate = await sut.estimate(owner, quote(), now);
      expect(estimate.quoteOnly).toBe(true);
      // no preview decided the model, so the whole slider is offered
      expect(estimate.models.length).toBeGreaterThanOrEqual(1);
      expect(estimates().at(-1)!.restorationId).toBeNull();
      const confirmed = await sut
        .create(
          owner,
          { estimateId: estimate.estimateId, consentVersion: '2026-09-26.1', acknowledgeDataLeaves: true },
          now,
        )
        .catch((error_: unknown) => error_);
      expect(confirmed).toBeInstanceOf(ConflictException);
      expect((confirmed as ConflictException).getResponse()).toMatchObject({ code: 'quote-only' });
      expect(mocks.mediaOperation.createWithin).not.toHaveBeenCalled();

      const reviewed = await sut.estimate(owner, full(), now);
      expect(reviewed.quoteOnly).toBe(false);
    });

    it('prepares one video per person at a time', async () => {
      // the first video is still being prepared while the second is asked for
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      mocks.media.transcode.mockImplementationOnce(() => held);
      await expect(sut.estimate(owner, full(), now)).rejects.toBeInstanceOf(ConflictException);
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...source,
        id: 'asset-2',
        checksum: Buffer.alloc(20, 9),
      } as never);
      // the owner may edit the second video too; access answers with exactly the ids asked about
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-2']));
      rows.set(RESTORATION_ID, { ...rows.get(RESTORATION_ID)!, assetId: 'asset-2' });

      await expect(sut.estimate(owner, { ...full(), assetId: 'asset-2' }, now)).rejects.toMatchObject({
        status: 429,
      });
      release();
      await prepared();
    });
  });

  describe('who may spend the AI Wallet', () => {
    const admin = { user: { id: 'admin-1', isAdmin: true }, session: undefined } as unknown as AuthDto;
    const confirm = (auth: AuthDto, estimateId: string) =>
      sut.create(auth, { estimateId, consentVersion: '2026-09-26.1', acknowledgeDataLeaves: true }, now);
    /** A settled job, one still running (its hold counts), and one cancelled before anything was sent. */
    const month = [
      { status: MediaOperationStatus.Completed, remoteJobId: 'job-a', result: {}, holdUsd: 2, settledUsd: 1.5 },
      { status: MediaOperationStatus.Rendering, remoteJobId: 'job-b', result: {}, holdUsd: 3, settledUsd: null },
      { status: MediaOperationStatus.Cancelled, remoteJobId: null, result: {}, holdUsd: 4, settledUsd: null },
    ];

    it('lets an administrator confirm without being on the list', async () => {
      configure({ spenders: [] });

      const estimate = await sut.estimate(owner, preview({ upscale: 2 }), now);
      expect(estimate.permission).toEqual({
        canConfirm: false,
        reason: 'not-allowed',
        monthlyCapUsd: null,
        spentThisMonthUsd: null,
      });
      await expect(sut.spendPermission(admin, 2, now)).resolves.toMatchObject({ canConfirm: true, reason: null });
      expect(mocks.mediaOperation.listCloudMlJobSpend).not.toHaveBeenCalled();
    });

    it('lets an allowed person confirm while the job fits their monthly limit, counting running holds', async () => {
      configure({ spenders: [{ userId: 'owner-1', monthlyCapUsd: 7 }] });
      mocks.mediaOperation.listCloudMlJobSpend.mockResolvedValue(month);

      const estimate = await sut.estimate(owner, preview({ upscale: 2 }), now);
      // 1.50 settled + 3.30 for the job not sent yet (its 3.00 hold, with room for a reseal 10 % higher);
      // the cancelled one sent nothing; + 2.20 for this job, the same way: 7.00 in all
      expect(estimate.permission).toEqual({
        canConfirm: true,
        reason: null,
        monthlyCapUsd: 7,
        spentThisMonthUsd: 4.8,
      });
      await expect(confirm(owner, estimate.estimateId)).resolves.toMatchObject({ operationId: OPERATION_ID });
      expect(mocks.mediaOperation.listCloudMlJobSpend).toHaveBeenCalledWith(
        'owner-1',
        new Date('2026-09-01T00:00:00.000Z'),
      );
    });

    it('refuses an allowed person past their monthly limit, at confirmation as well as in the estimate', async () => {
      configure({ spenders: [{ userId: 'owner-1', monthlyCapUsd: 6 }] });
      mocks.mediaOperation.listCloudMlJobSpend.mockResolvedValue(month);

      const estimate = await sut.estimate(owner, preview({ upscale: 2 }), now);
      expect(estimate.permission).toMatchObject({ canConfirm: false, reason: 'monthly-cap', spentThisMonthUsd: 4.8 });
      await expect(confirm(owner, estimate.estimateId)).rejects.toMatchObject({
        status: 403,
        response: expect.objectContaining({ code: 'monthly-cap' }),
      });
      expect(mocks.mediaOperation.createWithin).not.toHaveBeenCalled();
    });

    it('lets anyone else see the estimate but never confirm it', async () => {
      configure({ spenders: [{ userId: 'someone-else', monthlyCapUsd: null }] });

      const estimate = await sut.estimate(owner, preview({ upscale: 2 }), now);
      expect(estimate.p90Usd).toBe(1.6);
      expect(estimate.permission).toMatchObject({ canConfirm: false, reason: 'not-allowed' });
      await expect(confirm(owner, estimate.estimateId)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.mediaOperation.createWithin).not.toHaveBeenCalled();
    });

    it('counts settled charges, the holds of unsettled jobs, and nothing for a job never sent', () => {
      expect(cloudMlJobSpentUsd(month)).toBe(4.8);
      const settledLater = {
        status: MediaOperationStatus.Completed,
        remoteJobId: 'job-c',
        result: {
          ...emptyCloudMlJobResult(),
          cost: {
            outcome: 'charged',
            totalUsd: 0.25,
            heldUsd: 2,
            releasedUsd: 1.75,
            note: '',
            settledAt: '2026-09-26T05:00:00.000Z',
            lines: [],
          },
        },
        holdUsd: 2,
        settledUsd: null,
      };
      // a finished job whose cost was read but whose accounting row is not settled yet counts that cost
      expect(cloudMlJobSpentUsd([settledLater])).toBe(0.25);
      // one not sent yet counts the most a reseal could hold
      expect(cloudMlJobSpentUsd([{ ...settledLater, status: MediaOperationStatus.Queued, result: {} }])).toBe(2.2);
      // one sent counts what the AI Wallet actually holds for it, a resealed hold included
      const sent = {
        ...emptyCloudMlJobResult(),
        submission: {
          idempotencyKey: OPERATION_ID,
          estimate: sealed.estimate,
          expiresAt: sealed.expiresAt,
          modelRev: FAITHFUL_REV,
          computeSku: sealed.computeSku,
          p50Usd: 1.2,
          p90Usd: 1.6,
          holdUsd: 2.1,
          startupUsd: 0.5,
          attemptedAt: '2026-09-26T04:00:00.000Z',
        },
        job: { ...runningRecord(), holdUsd: 2.15 },
      };
      expect(cloudMlJobSpentUsd([{ ...settledLater, status: MediaOperationStatus.Rendering, result: sent }])).toBe(
        2.15,
      );
    });
  });

  describe('create', () => {
    it('answers with the job a confirmation created even when the estimate did not record it', async () => {
      const estimate = await sut.estimate(owner, preview({ upscale: 2 }), now);
      mocks.mediaOperation.getLatestBySubject.mockResolvedValue([
        { id: OPERATION_ID, revisionId: RESTORATION_ID } as unknown as MediaOperation,
      ]);

      await expect(
        sut.create(
          owner,
          { estimateId: estimate.estimateId, consentVersion: estimate.consent.version, acknowledgeDataLeaves: true },
          now,
        ),
      ).resolves.toEqual({ operationId: OPERATION_ID, restorationId: RESTORATION_ID, stage: 'preview' });
      expect(mocks.mediaOperation.createWithin).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.getLatestBySubject).toHaveBeenCalledWith(
        MediaOperationKind.CloudMlJob,
        'estimateId',
        [estimate.estimateId],
      );
      expect(estimates().at(-1)).toMatchObject({ operationId: OPERATION_ID });
    });

    it('confirms a kept estimate with its consent: one new version, one job, the consent stored with it', async () => {
      await estimateAndConfirm();

      expect(restorations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AssetRestorationStatus.PreviewQueued,
          mode: AssetRestorationMode.Faithful,
          destinationKind: MlDestinationKind.FrameleafCloud,
        }),
        expect.anything(),
      );
      expect(created).toMatchObject({
        kind: MediaOperationKind.CloudMlJob,
        destination: MediaOperationDestination.FrameleafCloud,
        revisionId: RESTORATION_ID,
        snapshot: expect.objectContaining({
          consent: expect.objectContaining({ version: '2026-09-26.1', acknowledgeDataLeaves: true }),
          approved: expect.objectContaining({ p50Usd: 1.2, p90Usd: 1.6, plannedWorkers: 5 }),
        }),
      });
      expect(confirmed().submission).toMatchObject({ estimate: sealed.estimate, idempotencyKey: null });
      expect(rows.get(RESTORATION_ID)?.previewOperationId).toBe(OPERATION_ID);
    });

    it('answers a repeated confirmation with the same job', async () => {
      const estimate = await estimateAndConfirm();
      const again = await sut.create(
        owner,
        { estimateId: estimate.estimateId, consentVersion: estimate.consent.version, acknowledgeDataLeaves: true },
        now,
      );

      expect(again.operationId).toBe(OPERATION_ID);
      expect(mocks.mediaOperation.create).toHaveBeenCalledTimes(1);
    });

    it('refuses an expired estimate with estimate-expired: it is estimated again, never reused', async () => {
      const estimate = await sut.estimate(owner, preview(), now);

      const error = await sut
        .create(
          owner,
          { estimateId: estimate.estimateId, consentVersion: estimate.consent.version, acknowledgeDataLeaves: true },
          new Date('2026-09-26T04:15:00.000Z'),
        )
        .catch((error_: unknown) => error_);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'estimate-expired' });
      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
    });

    it('refuses a confirmation under another consent version than the one shown', async () => {
      const estimate = await sut.estimate(owner, preview(), now);

      const outdated = {
        estimateId: estimate.estimateId,
        consentVersion: '2026-09-01.1',
        acknowledgeDataLeaves: true as const,
      };
      const error = await sut.create(owner, outdated, now).catch((error_: unknown) => error_);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'consent-version-outdated' });
      expect(mocks.mediaOperation.create).not.toHaveBeenCalled();
    });
  });

  describe('FL-201 pending disclosure at historical job boundaries', () => {
    // A future unapproved workload must still stop before confirmation, new input or start.
    it('refuses confirmation of a kept estimate without creating an operation', async () => {
      const estimate = await sut.estimate(owner, preview({ upscale: 2 }), now);
      vi.restoreAllMocks();
      vi.spyOn(cloudDisclosure, 'hasPendingCloudDisclosure').mockReturnValue(true);
      const error = await sut
        .create(
          owner,
          { estimateId: estimate.estimateId, consentVersion: estimate.consent.version, acknowledgeDataLeaves: true },
          now,
        )
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'disclosure-pending' });
      expect(mocks.mediaOperation.createWithin).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
    });

    it.each(['queued', 'partially uploaded', 'ready to start'])(
      'stops a historical %s job before new input or start',
      async (boundary) => {
        await estimateAndConfirm();
        vi.restoreAllMocks();
        vi.spyOn(cloudDisclosure, 'hasPendingCloudDisclosure').mockReturnValue(true);
        const operation =
          boundary === 'queued'
            ? claimed()
            : claimed({
                phase: CloudMlJobPhase.Uploading,
                submission: {
                  ...confirmed().submission!,
                  idempotencyKey: OPERATION_ID,
                  attemptedAt: now.toISOString(),
                },
                job: { ...runningRecord(), status: 'awaiting_upload' },
                uploads: { v1: { done: boundary === 'ready to start', parts: [{ partNumber: 1, etag: '"e1"' }] } },
              });
        await sut.step(operation, 'claim', now);
        expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
        expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
          OPERATION_ID,
          'claim',
          expect.objectContaining({ errorCode: 'cloud_ml_disclosure_pending' }),
          { retry: false },
        );
        if (boundary !== 'queued') {
          expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
        }
      },
    );

    it.each([CloudMlJobPhase.Started, CloudMlJobPhase.Ending])(
      'drains an already admitted %s lease without new admission or input',
      async (phase) => {
        await estimateAndConfirm();
        vi.restoreAllMocks();
        expect(vi.isMockFunction(cloudDisclosure.hasPendingCloudDisclosure)).toBe(false);
        if (phase === CloudMlJobPhase.Ending) {
          mocks.frameleafCloudMl.getJobView.mockResolvedValue({
            notModified: false,
            data: completedWithOutputs(),
            etag: '"e9"',
            retryAfterSeconds: null,
          });
          rendering();
        }
        await sut.step(claimed({ phase, job: runningRecord() }), 'claim', now);
        expect(mocks.frameleafCloudMl.getJobView).toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
        expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
      },
    );
  });

  describe('step', () => {
    beforeEach(async () => {
      await estimateAndConfirm();
    });

    it('submits once, keyed by the operation id and recorded before the request, then uploads and starts', async () => {
      const order: string[] = [];
      mocks.mediaOperation.setBulkResult.mockImplementation((_id, _token, patch) => {
        const result = patch.result as unknown as CloudMlJobResult;
        if (result.submission?.attemptedAt && !result.job) {
          order.push('attempt recorded');
        }
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

      await sut.step(claimed(), 'claim', now);

      expect(order.slice(0, 2)).toEqual(['attempt recorded', 'POST /v2/jobs']);
      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledTimes(1);
      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ estimate: sealed.estimate, modelSku: FAITHFUL, modelRev: FAITHFUL_REV }),
        OPERATION_ID,
      );
      expect(mocks.mediaOperation.setRemoteJobId).toHaveBeenCalledWith(OPERATION_ID, 'claim', JOB_ID);
      expect(mocks.mlDestination.recordCloudJobAccounting).toHaveBeenCalledWith(
        expect.objectContaining({ cloudJobId: JOB_ID, jobName: MediaOperationKind.CloudMlJob, costUsd: null }),
      );
      // both 8 MiB parts were recorded as they finished, then the job was started
      expect(written().uploads.v1).toEqual({
        done: true,
        parts: [
          { partNumber: 1, etag: '"e1"' },
          { partNumber: 2, etag: '"e2"' },
        ],
      });
      expect(mocks.frameleafCloudMl.startJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      expect(written().phase).toBe(CloudMlJobPhase.Started);
      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(OPERATION_ID, 'claim', {
        delayMs: expect.any(Number),
        returnAttempt: true,
      });
      expect(rows.get(RESTORATION_ID)?.status).toBe(AssetRestorationStatus.PreviewRendering);
    });

    it('resumes an interrupted upload by the cloud job id, sending only the parts it does not have', async () => {
      await sut.step(
        claimed({
          phase: CloudMlJobPhase.Uploading,
          submission: { ...confirmed().submission!, idempotencyKey: OPERATION_ID, attemptedAt: now.toISOString() },
          job: { ...runningRecord(), status: 'awaiting_upload' },
          uploads: { v1: { done: false, parts: [{ partNumber: 1, etag: '"e1"' }] } },
        }),
        'claim',
        now,
      );

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.uploadInput).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ inputId: 'v1' }),
        expect.stringContaining('input.mp4'),
        expect.objectContaining({ done: [{ partNumber: 1, etag: '"e1"' }] }),
      );
      expect(written().uploads.v1.parts).toHaveLength(2);
      expect(mocks.frameleafCloudMl.startJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
    });

    it('never submits a queued job once its consent is older than the version the cloud requires (FL-201)', async () => {
      const stale = { ...cloud, consentVersion: '2026-09-01.1' };
      mocks.mlDestination.getAll.mockResolvedValue([stale]);
      mocks.mlDestination.getById.mockResolvedValue(stale);

      await sut.step(claimed(), 'claim', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_consent_version_outdated' }),
        { retry: false },
      );
    });

    const resumedUpload = () =>
      claimed({
        phase: CloudMlJobPhase.Uploading,
        submission: { ...confirmed().submission!, idempotencyKey: OPERATION_ID, attemptedAt: now.toISOString() },
        job: { ...runningRecord(), status: 'awaiting_upload' },
        uploads: { v1: { done: false, parts: [{ partNumber: 1, etag: '"e1"' }] } },
      });

    it.each([
      ['its own hold took the rest of the AI Wallet', { balanceUsd: 5, heldUsd: 5 }],
      ["today's AI Wallet limit was reached after it was created", { dailyCapUsd: 20, spentTodayUsd: 20 }],
    ])('still uploads a created job when %s: consent is in force (FL-201 review P1)', async (_case, wallet) => {
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        workloads,
        cloud: { ...facts, ...wallet },
      });

      await sut.step(resumedUpload(), 'claim', now);

      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.uploadInput).toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.startJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
    });

    it('sends nothing when the cloud refused its own status check before consent could be compared (FL-201 review P2)', async () => {
      // the destination's consent is outdated too, but the probe's own 402 comes first
      const stale = { ...cloud, consentVersion: '2026-09-01.1' };
      mocks.mlDestination.getAll.mockResolvedValue([stale]);
      mocks.mlDestination.getById.mockResolvedValue(stale);
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        workloads,
        cloud: {
          ...facts,
          consentRequiredVersion: null,
          refusal: { refusal: MlAdmissionRefusal.WalletInsufficient, detail: 'The AI Wallet is empty' },
        },
      });

      await sut.step(resumedUpload(), 'claim', now);

      expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      // it waits and asks again later, never failing the job for good on this alone
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.requeue).toHaveBeenCalled();
      expect(written()).toMatchObject({ waiting: { detail: expect.stringContaining('could not be confirmed') } });
    });

    it('still uploads when /capabilities offers no workloads because its own hold used the free balance (FL-201, FC contract)', async () => {
      // frameleaf-cloud: /capabilities never answers 402; with no free balance it answers 200 with
      // `workloads: []`, and a job's own hold counts against that balance. Empty workloads only mean
      // "no new work": an admitted job keeps going.
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        workloads: [],
        cloud: { ...facts, balanceUsd: 5, heldUsd: 5 },
      });

      await sut.step(resumedUpload(), 'claim', now);

      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.uploadInput).toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.startJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
    });

    it('keeps the consent refusal when cancelling the cloud job fails (FL-201 review P3)', async () => {
      const stale = { ...cloud, consentVersion: '2026-09-01.1' };
      mocks.mlDestination.getAll.mockResolvedValue([stale]);
      mocks.mlDestination.getById.mockResolvedValue(stale);
      mocks.frameleafCloudMl.cancelJob.mockRejectedValue(new Error('network down'));

      await sut.step(resumedUpload(), 'claim', now);

      expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_consent_version_outdated' }),
        { retry: false },
      );
    });

    it.each([
      [
        'older than the version the cloud now requires',
        { consentVersion: '2026-09-01.1' },
        'cloud_ml_consent_version_outdated',
      ],
      ['withdrawn', { consentAcknowledgedAt: null, consentVersion: null }, 'cloud_ml_consent_missing'],
    ])(
      'sends nothing more and cancels the cloud job when a resumed upload finds consent %s (FL-201)',
      async (_case, change, code) => {
        const stale = { ...cloud, ...change };
        mocks.mlDestination.getAll.mockResolvedValue([stale]);
        mocks.mlDestination.getById.mockResolvedValue(stale);

        await sut.step(
          claimed({
            phase: CloudMlJobPhase.Uploading,
            submission: { ...confirmed().submission!, idempotencyKey: OPERATION_ID, attemptedAt: now.toISOString() },
            job: { ...runningRecord(), status: 'awaiting_upload' },
            uploads: { v1: { done: false, parts: [{ partNumber: 1, etag: '"e1"' }] } },
          }),
          'claim',
          now,
        );

        expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
        expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
          OPERATION_ID,
          'claim',
          expect.objectContaining({ errorCode: code }),
          { retry: false },
        );
      },
    );

    it.each(['withdrawn', 'version bumped'])(
      'sends no input when consent is %s after job admission (FL-201)',
      async (reason) => {
        mocks.frameleafCloudMl.createJob.mockImplementation(() => {
          if (reason === 'withdrawn') {
            mocks.mlDestination.getById.mockResolvedValue({
              ...cloud,
              consentAcknowledgedAt: null,
              consentVersion: null,
            });
          } else {
            mocks.machineLearning.probe.mockResolvedValue({
              ...mlProbeStub.frameleafCloud,
              workloads,
              cloud: { ...facts, consentRequiredVersion: '2026-10-01.1' },
            });
          }
          return Promise.resolve(admitted);
        });
        await sut.step(claimed(), 'claim', now);
        expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledTimes(1);
        expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      },
    );

    it.each(['withdrawn', 'version bumped'])(
      'stops later active requests when consent is %s (FL-201)',
      async (reason) => {
        const requests: number[] = [];
        mocks.frameleafCloudMl.uploadInput.mockImplementation(async (_gateway, uploadTarget, _file, options) => {
          for (const part of uploadTarget.multipart?.parts ?? []) {
            requests.push(part.partNumber);
            if (reason === 'withdrawn') {
              mocks.mlDestination.getById.mockResolvedValue({
                ...cloud,
                consentAcknowledgedAt: null,
                consentVersion: null,
              });
            } else {
              mocks.machineLearning.probe.mockResolvedValue({
                ...mlProbeStub.frameleafCloud,
                workloads,
                cloud: { ...facts, consentRequiredVersion: '2026-10-01.1' },
              });
            }
            await options?.onPart?.({ partNumber: part.partNumber, etag: `"e${part.partNumber}"` });
          }
        });
        await sut.step(
          claimed({
            phase: CloudMlJobPhase.Uploading,
            submission: { ...confirmed().submission!, idempotencyKey: OPERATION_ID, attemptedAt: now.toISOString() },
            job: { ...runningRecord(), status: 'awaiting_upload' },
          }),
          'claim',
          now,
        );
        expect(requests).toEqual([1]);
        expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      },
    );

    it.each(['withdrawn', 'version bumped'])(
      'does not retry an active upload when consent is %s (FL-201)',
      async (reason) => {
        mocks.frameleafCloudMl.uploadInput.mockImplementation(() => {
          if (reason === 'withdrawn') {
            mocks.mlDestination.getById.mockResolvedValue({
              ...cloud,
              consentAcknowledgedAt: null,
              consentVersion: null,
            });
          } else {
            mocks.machineLearning.probe.mockResolvedValue({
              ...mlProbeStub.frameleafCloud,
              workloads,
              cloud: { ...facts, consentRequiredVersion: '2026-10-01.1' },
            });
          }
          return Promise.reject(new CloudTransferError('storage-unreachable', 'connection reset'));
        });
        await sut.step(
          claimed({
            phase: CloudMlJobPhase.Uploading,
            submission: { ...confirmed().submission!, idempotencyKey: OPERATION_ID, attemptedAt: now.toISOString() },
            job: { ...runningRecord(), status: 'awaiting_upload' },
          }),
          'claim',
          now,
        );
        expect(mocks.frameleafCloudMl.uploadInput).toHaveBeenCalledTimes(1);
        expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      },
    );

    it.each(['withdrawn', 'version bumped'])(
      'rechecks consent %s after saving the completed upload and before start (FL-201)',
      async (reason) => {
        mocks.mediaOperation.setBulkResult.mockImplementation((_id, _claim, update) => {
          if ((update.result as CloudMlJobResult).uploads.v1?.done) {
            if (reason === 'withdrawn') {
              mocks.mlDestination.getById.mockResolvedValue({
                ...cloud,
                consentAcknowledgedAt: null,
                consentVersion: null,
              });
            } else {
              mocks.machineLearning.probe.mockResolvedValue({
                ...mlProbeStub.frameleafCloud,
                workloads,
                cloud: { ...facts, consentRequiredVersion: '2026-10-01.1' },
              });
            }
          }
          return Promise.resolve({
            status: MediaOperationStatus.Preparing,
            cancelRequestedAt: null,
            pauseRequestedAt: null,
          });
        });
        await sut.step(
          claimed({
            phase: CloudMlJobPhase.Uploading,
            submission: { ...confirmed().submission!, idempotencyKey: OPERATION_ID, attemptedAt: now.toISOString() },
            job: { ...runningRecord(), status: 'awaiting_upload' },
          }),
          'claim',
          now,
        );
        expect(mocks.frameleafCloudMl.uploadInput).toHaveBeenCalledTimes(1);
        expect(mocks.frameleafCloudMl.startJob).not.toHaveBeenCalled();
        expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      },
    );

    it('waits to be admitted while the region takes no new jobs, then fails with the cloud’s own words (FC-62)', async () => {
      const paused = () =>
        new FrameleafCloudError(
          MlAdmissionRefusal.DestinationUnhealthy,
          503,
          'Processing in the EU is paused until 18:00 UTC.',
          errorEnvelopeSchema.parse({
            code: 'capacity',
            message: 'Processing in the EU is paused until 18:00 UTC.',
            retryable: true,
          }),
          null,
          300,
        );
      mocks.frameleafCloudMl.createJob.mockRejectedValue(paused());

      await sut.step(claimed(), 'claim', now);

      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.requeue).toHaveBeenLastCalledWith(OPERATION_ID, 'claim', {
        delayMs: 300_000,
        returnAttempt: true,
      });
      expect(written()).toMatchObject({
        transientFailures: 1,
        waiting: { detail: 'Processing in the EU is paused until 18:00 UTC.' },
      });

      // the waits are limited: then the job fails with the message, and gets its automatic retry
      await sut.step(claimed({ transientFailures: 8 }), 'claim', now);
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        { error: 'Processing in the EU is paused until 18:00 UTC.', errorCode: 'cloud_ml_destination_unhealthy' },
        { retry: true },
      );
    });

    it('answers an estimate refused while new jobs are paused with a 503 and the cloud’s message (FC-62)', async () => {
      mocks.frameleafCloudMl.createEstimate.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          503,
          'Processing is paused.',
          errorEnvelopeSchema.parse({ code: 'service-paused', message: 'Processing is paused.', retryable: true }),
          null,
          300,
        ),
      );
      const error = await sut.estimate(owner, preview(), now).catch((error_: unknown) => error_);
      expect((error as HttpException).getStatus()).toBe(503);
      expect((error as HttpException).getResponse()).toMatchObject({
        message: 'Processing is paused.',
        code: 'service-paused',
      });
    });

    it('refuses a 402 as it is: nothing sent again, and never a lighter model', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.WalletInsufficient, 402, 'Your AI Wallet balance is too low'),
      );

      await sut.step(claimed(), 'claim', now);

      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledTimes(1);
      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledTimes(1);
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_insufficient_credits' }),
        { retry: false },
      );
      expect(rows.get(RESTORATION_ID)?.status).toBe(AssetRestorationStatus.PreviewFailed);
    });

    it('seals an expired estimate again and sends it under a new key while within 10 % of the confirmed high end', async () => {
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({
        ...sealed,
        expiresAt: '2026-09-26T04:35:00.000Z',
        cost: { ...sealed.cost, p90: 1.7 },
      });

      await sut.step(claimed(), 'claim', new Date('2026-09-26T04:20:00.000Z'));

      const key = mocks.frameleafCloudMl.createJob.mock.calls[0][2];
      expect(key).toBe(`${OPERATION_ID}-2`);
    });

    it('sends nothing when a new estimate would hold more than the owner confirmed allows', async () => {
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({
        ...sealed,
        expiresAt: '2026-09-26T04:35:00.000Z',
        cost: { ...sealed.cost, hold: 2.5 },
      });

      await sut.step(claimed(), 'claim', new Date('2026-09-26T04:20:00.000Z'));

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_estimate_increased' }),
        { retry: false },
      );
    });

    it('sends nothing when the new estimate is above what the owner confirmed', async () => {
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({
        ...sealed,
        expiresAt: '2026-09-26T04:35:00.000Z',
        cost: { ...sealed.cost, p90: 2.5 },
      });

      await sut.step(claimed(), 'claim', new Date('2026-09-26T04:20:00.000Z'));

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_estimate_increased' }),
        { retry: false },
      );
    });

    it('seals the estimate again after a 409 estimate-expired, never sending the old one twice', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.ModelMismatch, 409, 'This estimate expired', {
          code: 'estimate-expired',
          message: 'This estimate expired',
          retryable: false,
          refusal: 'model-mismatch',
          detail: null,
          data: null,
          requestId: null,
        }),
      );

      await sut.step(claimed(), 'claim', now);

      expect(written().submission).toBeNull();
      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(OPERATION_ID, 'claim', {
        delayMs: 0,
        returnAttempt: true,
      });
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
    });

    it('never seals again after estimate-mismatch: that estimate may belong to a job this key created', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.RequestInvalid, 409, 'This estimate was used', {
          code: 'estimate-mismatch',
          message: 'This estimate was used',
          retryable: false,
          refusal: 'request-invalid',
          detail: null,
          data: null,
          requestId: null,
        }),
      );

      await sut.step(claimed(), 'claim', now);

      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledTimes(1);
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.anything(),
        expect.objectContaining({ retry: false }),
      );
    });

    it('records the cloud job as a failure and stops it when the claim is lost after admission', async () => {
      mocks.mediaOperation.setRemoteJobId.mockResolvedValue(false);
      mocks.mediaOperation.recordRemoteJobId.mockResolvedValue(true);

      await sut.step(claimed(), 'claim', now);

      expect(mocks.mlDestination.recordCloudJobAccounting).toHaveBeenCalledWith(
        expect.objectContaining({ cloudJobId: JOB_ID, outcome: 'failure' }),
      );
      expect(mocks.mediaOperation.recordRemoteJobId).toHaveBeenCalledWith(OPERATION_ID, JOB_ID);
      expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
    });

    it('resumes a started job by its cloud job id: read, never submitted again', async () => {
      await sut.step(following(), 'claim', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.getJobView).toHaveBeenCalledWith(expect.anything(), JOB_ID, null);
    });

    it('long-polls a started job with its ETag and Retry-After, showing its segments as progress', async () => {
      const started = claimed({ phase: CloudMlJobPhase.Started, job: { ...runningRecord(), etag: '"e0"' } });

      await sut.step(started, 'claim', now);

      expect(mocks.frameleafCloudMl.getJobView).toHaveBeenCalledWith(expect.anything(), JOB_ID, '"e0"');
      expect(mocks.mediaOperation.reportProgress).toHaveBeenCalledWith(OPERATION_ID, 'claim', {
        status: MediaOperationStatus.Rendering,
        processedUnits: 2,
        totalUnits: 5,
        progress: 40,
      });
      expect(written().job).toMatchObject({ etag: '"e1"', status: 'running' });
      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith(OPERATION_ID, 'claim', {
        delayMs: 7000,
        returnAttempt: true,
      });

      // nothing changed: 304, and the next read waits for Retry-After
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({ notModified: true, etag: '"e1"', retryAfterSeconds: 3 });
      await sut.step(started, 'claim', now);
      expect(mocks.mediaOperation.requeue).toHaveBeenLastCalledWith(OPERATION_ID, 'claim', {
        delayMs: 3000,
        returnAttempt: true,
      });
    });

    it('collects a completed job: SHA-256-checked outputs joined by shard, acknowledged, settled once, published', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: completedWithOutputs(),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      rendering();

      await sut.step(following(), 'claim', now);

      const downloaded = mocks.frameleafCloudMl.downloadOutput.mock.calls.map(([, item]) => item.outputId);
      expect(downloaded).toEqual(['v1-s0', 'v1-s1']);
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      expect(mocks.mediaOperation.markRemoteReleased).toHaveBeenCalledWith(OPERATION_ID);
      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledTimes(1);
      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledWith([
        { cloudJobId: JOB_ID, costUsd: 0.2026, credits: null },
      ]);
      // the shards are joined, then the before clip's audio is put back, without metadata
      const [concat, mux] = mocks.media.transcode.mock.calls.slice(-2);
      expect(concat[2].inputOptions).toEqual(['-f', 'concat', '-safe', '0']);
      expect(stripsVideoMetadata(mux[2].outputOptions)).toBe(true);
      expect(mocks.mediaOperation.publishValidated).toHaveBeenCalled();
      expect(rows.get(RESTORATION_ID)).toMatchObject({
        status: AssetRestorationStatus.PreviewReady,
        modelName: 'Restore · Faithful',
        modelVersion: FAITHFUL_REV,
      });
      expect(written().cost).toMatchObject({ outcome: 'charged', totalUsd: 0.2026 });
    });

    it('keeps nothing when an output does not match its SHA-256, and downloads it again later', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: completedWithOutputs(),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      mocks.frameleafCloudMl.downloadOutput.mockRejectedValue(new CloudTransferError('sha256-mismatch', 'mismatch'));

      await sut.step(following(), 'claim', now);

      // waited out without spending the job's automatic retry; the cloud keeps the result meanwhile
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
      expect(written()).toMatchObject({
        phase: CloudMlJobPhase.Ending,
        transientFailures: 1,
        waiting: expect.objectContaining({ code: 'cloud_ml_output_sha256_mismatch' }),
      });
      expect(mocks.mediaOperation.requeue).toHaveBeenLastCalledWith(OPERATION_ID, 'claim', {
        delayMs: 5000,
        returnAttempt: true,
      });
      expect(mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.publishValidated).not.toHaveBeenCalled();
    });

    it('acknowledges a job only once its result is published, never before', async () => {
      const order: string[] = [];
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: completedWithOutputs(),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      mocks.mediaOperation.publishValidated.mockImplementation(async (_id, _token, publish) => {
        order.push('published');
        return (await publish({} as never)) ? 'completed' : 'rejected';
      });
      mocks.frameleafCloudMl.deleteJob.mockImplementation(() => {
        order.push('DELETE /v2/jobs');
        return Promise.resolve();
      });
      rendering();

      await sut.step(following(), 'claim', now);

      expect(order).toEqual(['published', 'DELETE /v2/jobs']);
      expect(mocks.mediaOperation.setFinishedResult).toHaveBeenCalledWith(
        OPERATION_ID,
        expect.objectContaining({ acknowledged: true }),
      );
    });

    it('keeps the result on Frameleaf Cloud when publishing fails for a moment, and tries again', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: completedWithOutputs(),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      mocks.mediaOperation.publishValidated.mockRejectedValue(new Error('connection reset'));
      rendering();

      await sut.step(following(), 'claim', now);

      expect(mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
      expect(mocks.storage.unlinkDir).not.toHaveBeenCalledWith(expect.stringContaining('cloud_ml_'), expect.anything());
      expect(written()).toMatchObject({ phase: CloudMlJobPhase.Ending, transientFailures: 1 });
    });

    it('waits out a read that fails without spending the automatic retry, honouring Retry-After', async () => {
      mocks.frameleafCloudMl.getJobView.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.CloudUnavailable, 503, 'Frameleaf Cloud is busy', null, null, 20),
      );

      await sut.step(following(), 'claim', now);
      await sut.step(
        claimed({ phase: CloudMlJobPhase.Started, job: runningRecord(), transientFailures: 1 }),
        'claim',
        now,
      );

      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      const delays = mocks.mediaOperation.requeue.mock.calls.map((call) => call[2].delayMs);
      // never sooner than Retry-After (20 s), doubling from 5 s otherwise
      expect(delays).toEqual([20_000, 20_000]);
      expect(written()).toMatchObject({ phase: CloudMlJobPhase.Started, transientFailures: 2 });

      // a running job keeps being read however long the cloud stays away
      await sut.step(
        claimed({ phase: CloudMlJobPhase.Started, job: runningRecord(), transientFailures: 50 }),
        'claim',
        now,
      );
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.requeue).toHaveBeenLastCalledWith(OPERATION_ID, 'claim', {
        delayMs: 60_000,
        returnAttempt: true,
      });
    });

    it('refuses a video stopped at its hold before every part was done, publishing nothing', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: view('job-settled-budget.json', {
          progress: { done: 2, total: 3, unit: 'segments', etaSeconds: null },
          result: { ...completedWithOutputs().result!, outputs: [output('v1-s0'), output('v1-s2')] },
        }),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      rendering();

      await sut.step(following(), 'claim', now);

      expect(mocks.frameleafCloudMl.downloadOutput).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.publishValidated).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_budget_reached' }),
        { retry: false },
      );
    });

    const inFlight = () =>
      new FrameleafCloudError(
        MlAdmissionRefusal.CloudUnavailable,
        409,
        'still in flight',
        errorEnvelopeSchema.parse(cloudContractFixture('errors/idempotency-in-flight.json')),
        null,
        30,
      );

    it('waits for a key still in flight and sends the same key again, never a new estimate (FC-43)', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValue(inFlight());

      await sut.step(claimed(), 'claim', now);

      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.requeue).toHaveBeenLastCalledWith(OPERATION_ID, 'claim', {
        delayMs: 30_000,
        returnAttempt: true,
      });
      expect(written()).toMatchObject({ transientFailures: 1, submission: { idempotencyKey: OPERATION_ID } });

      // the replay sends the recorded submission: the same key and body, nothing estimated again
      mocks.frameleafCloudMl.createJob.mockResolvedValue(admitted);
      await sut.step(claimed(written()), 'claim', now);
      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledTimes(1);
      const [first, second] = mocks.frameleafCloudMl.createJob.mock.calls;
      expect(second[2]).toBe(first[2]);
      expect(second[1]).toEqual(first[1]);
      expect(mocks.mediaOperation.setRemoteJobId).toHaveBeenCalledWith(OPERATION_ID, 'claim', JOB_ID);
    });

    it('fails a job whose idempotency key was reused with another body, logging it and never sending it again (FC-43)', async () => {
      mocks.frameleafCloudMl.createJob.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.RequestInvalid,
          422,
          'reused',
          errorEnvelopeSchema.parse(cloudContractFixture('errors/idempotency-key-reused.json')),
        ),
      );

      await sut.step(claimed(), 'claim', now);

      expect(mocks.frameleafCloudMl.createJob).toHaveBeenCalledTimes(1);
      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledTimes(1);
      expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('reused idempotency key'));
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_idempotency_key_reused' }),
        { retry: false },
      );
      expect(rows.get(RESTORATION_ID)?.status).toBe(AssetRestorationStatus.PreviewFailed);
    });

    it('fails a job stopped at the 6-hour runtime cap as charged, never retried, telling the owner to split the clip (FC-47)', async () => {
      const charged = view('job-completed.json').cost!;
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: view('job-failed.json', {
          error: { code: 'runtime-cap', message: 'The job reached its 6-hour limit.', retryable: false },
          cost: charged,
        }),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      rendering();

      await sut.step(following(), 'claim', now);

      expect(mocks.frameleafCloudMl.downloadOutput).not.toHaveBeenCalled();
      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledWith([
        { cloudJobId: JOB_ID, costUsd: charged.totalUsd, credits: null },
      ]);
      expect(written().cost).toMatchObject({ outcome: 'charged', totalUsd: charged.totalUsd });
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        { error: expect.stringMatching(/Split the clip/), errorCode: 'cloud_ml_job_runtime_cap' },
        { retry: false },
      );
      expect(rows.get(RESTORATION_ID)?.status).toBe(AssetRestorationStatus.PreviewFailed);
    });

    it('never uploads a clip that still carries audio (FC-47)', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { formatName: 'mp4', formatLongName: 'mp4', duration: 5, bitrate: 0 },
        videoStreams: [{ width: 960, height: 540, codecName: 'h264' }],
        audioStreams: [{ index: 1, codecName: 'aac', profile: null, bitrate: 0 }],
      } as never);

      await sut.step(claimed(), 'claim', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.uploadInput).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_input_has_audio' }),
        { retry: false },
      );
    });

    describe('audio put back on the returned video (CLD-202)', () => {
      const withAudio = (version: { audio: boolean; audioDuration?: number }) => {
        mocks.media.probe.mockImplementation((file: string) => {
          if (file.endsWith('before.mp4')) {
            // the kept clip: its audio starts 50 ms before its first frame
            return Promise.resolve({
              format: { duration: 5 },
              videoStreams: [{ width: 960, height: 540, startTime: 0.05, duration: 5 }],
              audioStreams: [
                { codecName: 'aac', channels: 2, channelLayout: 'stereo', sampleRate: 48_000, startTime: 0 },
              ],
            } as never);
          }
          return Promise.resolve({
            format: { duration: 5 },
            videoStreams: [{ width: 960, height: 540, duration: 5, frameRate: 30 }],
            audioStreams: version.audio
              ? [
                  {
                    codecName: 'aac',
                    channels: 2,
                    channelLayout: 'stereo',
                    sampleRate: 48_000,
                    duration: version.audioDuration ?? 5.01,
                  },
                ]
              : [],
          } as never);
        });
        mocks.frameleafCloudMl.getJobView.mockResolvedValue({
          notModified: false,
          data: completedWithOutputs(),
          etag: '"e9"',
          retryAfterSeconds: null,
        });
        rendering();
      };

      it('re-attaches the kept audio locally, in step, and checks it with ffprobe before publishing', async () => {
        withAudio({ audio: true });

        await sut.step(following(), 'claim', now);

        const mux = mocks.media.transcode.mock.calls.at(-1)!;
        const options = mux[2].outputOptions;
        expect(options.slice(0, 3)).toEqual(['-itsoffset', '-0.050000', '-i']);
        expect(options[3]).toMatch(/before\.mp4$/);
        expect(options).toEqual(expect.arrayContaining(['-c:a', 'copy', '-shortest']));
        expect(rows.get(RESTORATION_ID)?.status).toBe(AssetRestorationStatus.PreviewReady);
      });

      it('publishes nothing when the audio did not come back, or drifted from the picture', async () => {
        withAudio({ audio: false });
        await sut.step(following(), 'claim', now);
        expect(mocks.mediaOperation.publishValidated).not.toHaveBeenCalled();
        expect(mocks.mediaOperation.fail).toHaveBeenLastCalledWith(
          OPERATION_ID,
          'claim',
          expect.objectContaining({ errorCode: 'cloud_ml_audio_invalid' }),
          { retry: false },
        );

        withAudio({ audio: true, audioDuration: 4.5 });
        await sut.step(following(), 'claim', now);
        expect(mocks.mediaOperation.publishValidated).not.toHaveBeenCalled();
        expect(mocks.mediaOperation.fail).toHaveBeenLastCalledWith(
          OPERATION_ID,
          'claim',
          { error: expect.stringMatching(/drift apart/), errorCode: 'cloud_ml_audio_invalid' },
          { retry: false },
        );
      });
    });

    it('reports a failure on the cloud side with its fixed reason, nothing charged, and acknowledges the job', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: view('job-failed.json'),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      rendering();

      await sut.step(following(), 'claim', now);

      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledWith([
        { cloudJobId: JOB_ID, costUsd: 0, credits: null },
      ]);
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_job_worker_unavailable' }),
        { retry: false },
      );
      expect(rows.get(RESTORATION_ID)?.status).toBe(AssetRestorationStatus.PreviewFailed);
    });

    it('cancels a started job on Frameleaf Cloud when its owner cancels, releasing the hold and settling what ran', async () => {
      mocks.mediaOperation.setBulkResult.mockResolvedValue({
        status: MediaOperationStatus.Cancelling,
        cancelRequestedAt: now,
        pauseRequestedAt: null,
      });
      mocks.frameleafCloudMl.getJobView
        .mockResolvedValueOnce({
          notModified: false,
          data: view('job-running.json'),
          etag: '"e1"',
          retryAfterSeconds: 5,
        })
        .mockResolvedValue({
          notModified: false,
          data: view('job-completed.json', { status: 'cancelled' }),
          etag: '"e2"',
          retryAfterSeconds: null,
        });
      rendering();

      await sut.step(following(), 'claim', now);

      expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      expect(mocks.mediaOperation.acknowledgeCancel).toHaveBeenCalledWith(OPERATION_ID, 'claim', { released: true });
      expect(rows.get(RESTORATION_ID)?.status).toBe(AssetRestorationStatus.PreviewCancelled);
    });

    it('pauses before anything was sent, and never pauses a job already running on Frameleaf Cloud', async () => {
      mocks.mediaOperation.setBulkResult.mockResolvedValue({
        status: MediaOperationStatus.Preparing,
        cancelRequestedAt: null,
        pauseRequestedAt: now,
      });

      await sut.step(claimed(), 'claim', now);
      expect(mocks.mediaOperation.settlePause).toHaveBeenCalledWith(OPERATION_ID, 'claim');
      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();

      await sut.step(following(), 'claim', now);
      expect(mocks.mediaOperation.resume).toHaveBeenCalledWith(OPERATION_ID, 'owner-1');
      expect(mocks.mediaOperation.settlePause).toHaveBeenCalledTimes(1);

      // an admitted job that is uploading holds the AI Wallet: it carries on to its start
      await sut.step(
        claimed({
          phase: CloudMlJobPhase.Uploading,
          submission: { ...confirmed().submission!, idempotencyKey: OPERATION_ID, attemptedAt: now.toISOString() },
          job: { ...runningRecord(), status: 'awaiting_upload' },
        }),
        'claim',
        now,
      );
      expect(mocks.mediaOperation.settlePause).toHaveBeenCalledTimes(1);
    });

    it('puts a full render cancelled before anything was sent back to its reviewed preview', async () => {
      rows.set(RESTORATION_ID, { ...rows.get(RESTORATION_ID)!, status: AssetRestorationStatus.Accepted });
      mocks.mediaOperation.setBulkResult.mockResolvedValue({
        status: MediaOperationStatus.Cancelling,
        cancelRequestedAt: now,
        pauseRequestedAt: null,
      });
      const full = claimed();
      (full as unknown as { snapshot: Record<string, unknown> }).snapshot = { ...created!.snapshot, stage: 'full' };

      await sut.step(full, 'claim', now);

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(rows.get(RESTORATION_ID)).toMatchObject({
        status: AssetRestorationStatus.PreviewReady,
        reviewedAt: null,
        fullOperationId: null,
      });
      expect(mocks.storage.unlinkDir).toHaveBeenCalled();
    });

    it('stops every job when Frameleaf Cloud processing is turned off, cancelling one already sent', async () => {
      configure({ enabled: false });

      await sut.step(following(), 'claim', now);

      expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_turned_off' }),
        { retry: false },
      );
    });
  });

  describe('photo upscale under the 64 MP output cap (FC-46)', () => {
    const UPSCALE = 'ms_54S55W7C';
    const UPSCALE_REV = 'mr_0WNPDD697MT0';
    const photo = {
      ...source,
      type: AssetType.Image,
      originalFileName: 'Garden.jpg',
      originalPath: '/library/owner-1/Garden.jpg',
      exifInfo: { exifImageWidth: 4000, exifImageHeight: 3000, orientation: null },
    };
    const upscaleEstimate = estimateResponseSchema.parse(cloudContractFixture('ml/upscale/estimate-response.json'));
    /** The published result document, for this job's one photo: a3, the 12 MP photo lowered to 2×. */
    const resultDocument = () => {
      const document = cloudContractFixture('ml/upscale/result.json');
      const item = document.items.find((entry: { inputId: string }) => entry.inputId === 'a3');
      return {
        ...document,
        items: [{ ...item, inputId: 'v1', outputs: [{ ...item.outputs[0], outputId: 'v1' }] }],
      };
    };

    beforeEach(() => {
      const upscaleModel = catalogSchema
        .parse(cloudContractFixture('ml/catalog.json'))
        .models.find((model) => model.sku === UPSCALE)!;
      mocks.frameleafCloudMl.getCatalog.mockResolvedValue({ ...catalog, models: [...catalog.models, upscaleModel] });
      const upscaleCloud = {
        ...cloud,
        workloads: [...workloads, MlWorkload.Upscale],
        lastProbeWorkloads: [...workloads, MlWorkload.Upscale],
        lastProbeCloud: {
          ...facts,
          modelIds: [...facts.modelIds, UPSCALE],
          modelWorkloads: { ...facts.modelWorkloads, [UPSCALE]: MlWorkload.Upscale },
          defaultModels: { ...facts.defaultModels, upscale: UPSCALE },
          modelGroups: { ...facts.modelGroups, [UPSCALE]: 'upscale' },
        },
      };
      mocks.mlDestination.getAll.mockResolvedValue([upscaleCloud]);
      mocks.mlDestination.getById.mockResolvedValue(upscaleCloud);
      mocks.machineLearning.probe.mockResolvedValue({
        ...mlProbeStub.frameleafCloud,
        workloads: upscaleCloud.workloads,
        cloud: upscaleCloud.lastProbeCloud,
      });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(photo as never);
      mocks.media.decodeImage.mockResolvedValue({
        data: Buffer.alloc(0),
        info: { width: 4000, height: 3000, channels: 3 },
      } as never);
      // the prepared crop, as the owner chose the whole photo: 4000 × 3000, 12 MP
      mocks.media.getImageMetadata.mockResolvedValue({ width: 4000, height: 3000 } as never);
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({
        ...upscaleEstimate,
        upscale: { scale: 4, items: [{ inputId: 'v1', scale: 2 }], lowered: ['v1'] },
      });
      mocks.frameleafCloudMl.createJob.mockResolvedValue({ ...admitted, modelSku: UPSCALE, modelRev: UPSCALE_REV });
    });

    const estimatePhoto = () =>
      sut.estimate(
        owner,
        preview({ assetId: photo.id, upscale: 4, modelSku: UPSCALE, region: { x: 0, y: 0, w: 1, h: 1 } }),
        now,
      );

    it('declares the photo size, and shows the lowered factor before the owner confirms', async () => {
      const estimate = await estimatePhoto();

      expect(mocks.frameleafCloudMl.createEstimate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          workload: 'upscale',
          request: { scale: 4, items: [{ inputId: 'v1', width: 4000, height: 3000 }] },
        }),
      );
      expect(estimate.upscale).toEqual({
        requestedScale: 4,
        appliedScale: 2,
        lowered: true,
        outputWidth: 8000,
        outputHeight: 6000,
      });
      const [record] = estimates();
      expect(record.upscale).toEqual({
        requestedScale: 4,
        appliedScale: 2,
        lowered: true,
        input: { width: 4000, height: 3000 },
      });
      expect(record.output).toEqual({ width: 8000, height: 6000 });
    });

    it('rejects a cloud quote that exceeds the photo output cap', async () => {
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({
        ...upscaleEstimate,
        upscale: { scale: 4, items: [{ inputId: 'v1', scale: 4 }], lowered: [] },
      });

      await expect(estimatePhoto()).rejects.toThrow(/quoted 4×.*expected at 2×/);
      expect(metadata.has(SystemMetadataKey.FrameleafCloudMlJobEstimates)).toBe(false);
    });

    it('sends nothing when a refreshed estimate changes the approved factor', async () => {
      const estimate = await estimatePhoto();
      await sut.create(
        owner,
        { estimateId: estimate.estimateId, consentVersion: estimate.consent.version, acknowledgeDataLeaves: true },
        now,
      );
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({
        ...upscaleEstimate,
        expiresAt: '2026-09-27T20:35:00.000Z',
        upscale: { scale: 4, items: [{ inputId: 'v1', scale: 4 }], lowered: [] },
      });

      await sut.step(claimed(), 'claim', new Date('2026-09-27T20:20:00.000Z'));

      expect(mocks.frameleafCloudMl.createJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_estimate_unstable' }),
        { retry: false },
      );
    });

    it('rejects a valid cloud result at a factor other than the approved one', async () => {
      const smallPhoto = {
        ...photo,
        exifInfo: { exifImageWidth: 2000, exifImageHeight: 1500, orientation: null },
      };
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(smallPhoto as never);
      mocks.media.decodeImage.mockResolvedValue({
        data: Buffer.alloc(0),
        info: { width: 2000, height: 1500, channels: 3 },
      } as never);
      mocks.media.getImageMetadata.mockResolvedValue({ width: 2000, height: 1500 } as never);
      mocks.frameleafCloudMl.createEstimate.mockResolvedValue({
        ...upscaleEstimate,
        upscale: { scale: 4, items: [{ inputId: 'v1', scale: 4 }], lowered: [] },
      });
      const estimate = await estimatePhoto();
      await sut.create(
        owner,
        { estimateId: estimate.estimateId, consentVersion: estimate.consent.version, acknowledgeDataLeaves: true },
        now,
      );
      const document = resultDocument();
      document.items[0].input = { width: 2000, height: 1500 };
      document.items[0].outputs[0].width = 4000;
      document.items[0].outputs[0].height = 3000;
      mocks.storage.readFile.mockResolvedValue(Buffer.from(JSON.stringify(document)));
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: view('job-completed.json', {
          modelSku: UPSCALE,
          modelRev: UPSCALE_REV,
          result: {
            outputs: [
              { ...output('v1'), contentType: 'image/webp' },
              { ...output('result'), contentType: 'application/json' },
            ],
            headers: { 'x-amz-server-side-encryption-customer-algorithm': 'AES256' },
            expiresAt: '2026-09-26T04:30:00.000Z',
            modelSku: UPSCALE,
            modelRev: UPSCALE_REV,
          },
        }),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      rendering();

      await sut.step(following(), 'claim', now);

      expect(mocks.mediaOperation.publishValidated).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenLastCalledWith(
        OPERATION_ID,
        'claim',
        { error: expect.stringMatching(/says 2×, but the owner approved 4×/), errorCode: 'cloud_ml_output_invalid' },
        { retry: false },
      );
    });

    it('writes the version at the factor its own item got, checked against the photo times that factor', async () => {
      const estimate = await estimatePhoto();
      await sut.create(
        owner,
        { estimateId: estimate.estimateId, consentVersion: estimate.consent.version, acknowledgeDataLeaves: true },
        now,
      );
      expect(rows.get(RESTORATION_ID)?.upscale).toBe(2);
      const document = resultDocument();
      mocks.storage.readFile.mockResolvedValue(Buffer.from(JSON.stringify(document)));
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: view('job-completed.json', {
          modelSku: UPSCALE,
          modelRev: UPSCALE_REV,
          result: {
            outputs: [
              { ...output('v1'), contentType: 'image/webp' },
              { ...output('result'), contentType: 'application/json' },
            ],
            headers: { 'x-amz-server-side-encryption-customer-algorithm': 'AES256' },
            expiresAt: '2026-09-26T04:30:00.000Z',
            modelSku: UPSCALE,
            modelRev: UPSCALE_REV,
          },
        }),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      rendering();
      mocks.media.getImageMetadata.mockResolvedValue({ width: 8000, height: 6000 } as never);

      await sut.step(following(), 'claim', now);

      // the result document is read, never published as a version
      const downloaded = mocks.frameleafCloudMl.downloadOutput.mock.calls.map(([, item]) => item.outputId);
      expect(downloaded).toEqual(['v1', 'result']);
      expect(written().upscaleScale).toBe(2);
      expect(rows.get(RESTORATION_ID)).toMatchObject({ status: AssetRestorationStatus.PreviewReady, upscale: 2 });

      // a photo that is not the input times its own item's factor is never published
      mocks.mediaOperation.publishValidated.mockClear();
      rendering();
      mocks.media.getImageMetadata.mockResolvedValue({ width: 16_000, height: 12_000 } as never);
      await sut.step(following(), 'claim', now);
      expect(mocks.mediaOperation.publishValidated).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).toHaveBeenLastCalledWith(
        OPERATION_ID,
        'claim',
        { error: expect.stringMatching(/not 2× the photo/), errorCode: 'cloud_ml_output_invalid' },
        { retry: false },
      );
    });
  });

  describe('jobs no worker holds', () => {
    beforeEach(async () => {
      await estimateAndConfirm();
    });

    it('cancels and acknowledges a job cancelled between two reads, recording its cost', async () => {
      const cancelled = {
        ...claimed({ phase: CloudMlJobPhase.Started, job: runningRecord() }),
        status: MediaOperationStatus.Cancelled,
        claimToken: null,
        remoteJobId: JOB_ID,
      } as unknown as MediaOperation;
      mocks.mediaOperation.getUnreleasedRemoteOperations.mockResolvedValue([cancelled]);
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: view('job-completed.json', { status: 'cancelled' }),
        etag: '"e2"',
        retryAfterSeconds: null,
      });

      await sut.releaseUnwatched();

      expect(mocks.frameleafCloudMl.cancelJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      expect(mocks.mediaOperation.setFinishedResult).toHaveBeenCalledWith(
        OPERATION_ID,
        expect.objectContaining({ acknowledged: true, cost: expect.objectContaining({ totalUsd: 0.2026 }) }),
      );
      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledTimes(1);
    });

    it('acknowledges a published job whose acknowledgement did not land, cancelling nothing', async () => {
      const published = {
        ...claimed({ phase: CloudMlJobPhase.Ending, job: { ...runningRecord(), status: 'completed' } }),
        status: MediaOperationStatus.Completed,
        claimToken: null,
        remoteJobId: JOB_ID,
      } as unknown as MediaOperation;
      mocks.mediaOperation.listUnacknowledgedCloudMlJobs.mockResolvedValue([published]);

      await sut.cleanup(now);

      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
      expect(mocks.frameleafCloudMl.deleteJob).toHaveBeenCalledWith(expect.anything(), JOB_ID);
      expect(mocks.mediaOperation.markRemoteReleased).toHaveBeenCalledWith(OPERATION_ID);
      expect(mocks.mediaOperation.setFinishedResult).toHaveBeenCalledWith(
        OPERATION_ID,
        expect.objectContaining({ acknowledged: true }),
      );
    });

    it('puts a full render cancelled while queued back up for review, once', async () => {
      rows.set(RESTORATION_ID, {
        ...rows.get(RESTORATION_ID)!,
        status: AssetRestorationStatus.Accepted,
        fullOperationId: OPERATION_ID,
      });
      const cancelled = {
        ...claimed(),
        snapshot: { ...created!.snapshot, stage: 'full' },
        status: MediaOperationStatus.Cancelled,
        claimToken: null,
        remoteJobId: null,
      } as unknown as MediaOperation;
      mocks.mediaOperation.listUnreconciledCancelledCloudMlJobs.mockResolvedValue([cancelled]);

      await sut.cleanup(now);

      expect(rows.get(RESTORATION_ID)).toMatchObject({ status: AssetRestorationStatus.PreviewReady, reviewedAt: null });
      expect(mocks.storage.unlinkDir).toHaveBeenCalled();
      expect(mocks.mediaOperation.setFinishedResult).toHaveBeenCalledWith(
        OPERATION_ID,
        expect.objectContaining({ reconciled: true }),
      );
      expect(mocks.frameleafCloudMl.cancelJob).not.toHaveBeenCalled();
    });

    it('never resets a version a later full render owns when reconciling an old cancel', async () => {
      rows.set(RESTORATION_ID, {
        ...rows.get(RESTORATION_ID)!,
        status: AssetRestorationStatus.Accepted,
        fullOperationId: 'a-later-job',
      });
      const cancelled = {
        ...claimed(),
        snapshot: { ...created!.snapshot, stage: 'full' },
        status: MediaOperationStatus.Cancelled,
        claimToken: null,
        remoteJobId: null,
      } as unknown as MediaOperation;
      mocks.mediaOperation.listUnreconciledCancelledCloudMlJobs.mockResolvedValue([cancelled]);

      await sut.cleanup(now);

      expect(rows.get(RESTORATION_ID)).toMatchObject({
        status: AssetRestorationStatus.Accepted,
        fullOperationId: 'a-later-job',
      });
      expect(mocks.mediaOperation.setFinishedResult).toHaveBeenCalledWith(
        OPERATION_ID,
        expect.objectContaining({ reconciled: true }),
      );
    });

    it('records a job the cloud no longer knows as released, so it is not read again', async () => {
      const failed = {
        ...claimed({ phase: CloudMlJobPhase.Started, job: runningRecord(), cancelSent: true }),
        status: MediaOperationStatus.Failed,
        claimToken: null,
        remoteJobId: JOB_ID,
      } as unknown as MediaOperation;
      mocks.mediaOperation.getUnreleasedRemoteOperations.mockResolvedValue([failed]);
      mocks.frameleafCloudMl.getJobView.mockRejectedValue(
        new FrameleafCloudError(MlAdmissionRefusal.RequestInvalid, 404, 'Not found'),
      );

      await sut.releaseUnwatched();

      expect(mocks.mediaOperation.markRemoteReleased).toHaveBeenCalledWith(OPERATION_ID);
    });

    it('keeps a prepared copy an unfinished job still needs', async () => {
      const dir = '/upload/thumbs/owner-1/as/se/cloud_ml_input_abc';
      metadata.set(SystemMetadataKey.FrameleafCloudMlJobEstimates, {
        records: [],
        prepared: [{ dir, ownerId: 'owner-1', at: '2026-09-20T00:00:00.000Z' }],
      });
      mocks.mediaOperation.listUnfinishedCloudMlJobSnapshots.mockResolvedValue([
        { inputs: [{ path: `${dir}/input.mp4` }] },
      ]);

      await sut.pruneEstimates(now);
      expect(mocks.storage.unlinkDir).not.toHaveBeenCalledWith(dir, expect.anything());

      mocks.mediaOperation.listUnfinishedCloudMlJobSnapshots.mockResolvedValue([]);
      await sut.pruneEstimates(now);
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(dir, expect.anything());
    });

    it('records the cost of a finished job once it is settled', async () => {
      const finished = {
        ...claimed({ phase: CloudMlJobPhase.Started, job: runningRecord() }),
        status: MediaOperationStatus.Completed,
        claimToken: null,
        remoteJobId: JOB_ID,
      } as unknown as MediaOperation;
      mocks.mediaOperation.listCloudMlJobsAwaitingCost.mockResolvedValue([finished]);
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: view('job-completed.json'),
        etag: '"e3"',
        retryAfterSeconds: null,
      });

      await sut.settleFinished(now);

      expect(mocks.mediaOperation.setFinishedResult).toHaveBeenCalledWith(
        OPERATION_ID,
        expect.objectContaining({ costReads: 1, cost: expect.objectContaining({ outcome: 'charged' }) }),
      );
      expect(mocks.mlDestination.applySettlements).toHaveBeenCalledWith([
        { cloudJobId: JOB_ID, costUsd: 0.2026, credits: null },
      ]);
    });
  });

  describe('Activity view', () => {
    beforeEach(async () => {
      await estimateAndConfirm();
    });

    it('shows each stage: queued, starting (a cold start), running, then done, failed, cancelled or paused', () => {
      const at = (status: MediaOperationStatus, cloudStatus: NonNullable<CloudMlJobResult['job']>['status'] | null) =>
        cloudMlJobActivity({
          kind: MediaOperationKind.CloudMlJob,
          status,
          snapshot: created!.snapshot,
          result: { ...confirmed(), job: cloudStatus ? { ...runningRecord(), status: cloudStatus } : null },
        })?.activityStage;

      expect(at(MediaOperationStatus.Queued, null)).toBe('queued');
      expect(at(MediaOperationStatus.Queued, 'awaiting_upload')).toBe('queued');
      expect(at(MediaOperationStatus.Queued, 'starting')).toBe('starting');
      expect(at(MediaOperationStatus.Rendering, 'running')).toBe('running');
      expect(at(MediaOperationStatus.Paused, null)).toBe('paused');
      expect(at(MediaOperationStatus.Completed, 'completed')).toBe('done');
      expect(at(MediaOperationStatus.Failed, 'failed')).toBe('failed');
      expect(at(MediaOperationStatus.Cancelled, 'cancelled')).toBe('cancelled');
    });

    it('shows the estimate, what was metered so far and the settled cost, with the model', () => {
      const running = cloudMlJobActivity({
        kind: MediaOperationKind.CloudMlJob,
        status: MediaOperationStatus.Rendering,
        snapshot: created!.snapshot,
        result: { ...confirmed(), job: { ...runningRecord(), meteredUsd: 0.4 } },
      });
      expect(running).toMatchObject({
        model: 'Restore · Faithful',
        plannedWorkers: 5,
        cost: { estimatedP50Usd: 1.2, estimatedP90Usd: 1.6, soFarUsd: 0.4, settledUsd: null, outcome: null },
      });

      const settled = cloudMlJobActivity({
        kind: MediaOperationKind.CloudMlJob,
        status: MediaOperationStatus.Completed,
        snapshot: created!.snapshot,
        result: {
          ...confirmed(),
          job: runningRecord(),
          cost: {
            outcome: 'charged',
            totalUsd: 0.2026,
            heldUsd: 2,
            releasedUsd: 1.7974,
            note: 'Charged for the GPU time and worker starts this job used.',
            settledAt: '2026-09-26T04:10:00.000Z',
            lines: [],
          },
        },
      });
      expect(settled?.cost).toMatchObject({ soFarUsd: 0.2026, settledUsd: 0.2026, outcome: 'charged' });
      const bulk = { kind: MediaOperationKind.Bulk, status: 'queued', snapshot: {}, result: {} };
      expect(cloudMlJobActivity(bulk)).toBeNull();
    });

    it('offers pausing only until the job was sent to Frameleaf Cloud', () => {
      const kind = MediaOperationKind.CloudMlJob;
      expect(cloudMlJobCanPause({ kind, result: confirmed() })).toBe(true);
      expect(cloudMlJobCanPause({ kind, result: { ...confirmed(), phase: CloudMlJobPhase.Uploading } })).toBe(false);
      expect(cloudMlJobCanPause({ kind, result: { ...confirmed(), phase: CloudMlJobPhase.Started } })).toBe(false);
      expect(cloudMlJobCanPause({ kind: MediaOperationKind.Bulk, result: null })).toBe(true);
    });
  });
});
