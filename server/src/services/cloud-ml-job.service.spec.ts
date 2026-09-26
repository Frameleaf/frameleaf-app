import { ConflictException, HttpException } from '@nestjs/common';
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
} from 'src/utils/cloud-ml-job.js';
import {
  CloudCatalogEntry,
  FrameleafCloudError,
  catalogSchema,
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

  const configure = ({ enabled = true, restoration = 'both' }: { enabled?: boolean; restoration?: string } = {}) => {
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        (key === SystemMetadataKey.SystemConfig
          ? {
              frameleafCloud: {
                cloudMl: {
                  ...defaults.frameleafCloud.cloudMl,
                  enabled,
                  routing: { ...defaults.frameleafCloud.cloudMl.routing, restoration, interpolation: 'both' },
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

  describe('create', () => {
    it('confirms a kept estimate with its consent: one new version, one job, the consent stored with it', async () => {
      await estimateAndConfirm();

      expect(restorations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AssetRestorationStatus.PreviewQueued,
          mode: AssetRestorationMode.Faithful,
          destinationKind: MlDestinationKind.FrameleafCloud,
        }),
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

      const [, , key] = mocks.frameleafCloudMl.createJob.mock.calls[0];
      expect(key).toBe(`${OPERATION_ID}-2`);
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

    it('keeps nothing and retries once when an output does not match its SHA-256', async () => {
      mocks.frameleafCloudMl.getJobView.mockResolvedValue({
        notModified: false,
        data: completedWithOutputs(),
        etag: '"e9"',
        retryAfterSeconds: null,
      });
      mocks.frameleafCloudMl.downloadOutput.mockRejectedValue(new CloudTransferError('sha256-mismatch', 'mismatch'));

      await sut.step(following(), 'claim', now);

      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        'claim',
        expect.objectContaining({ errorCode: 'cloud_ml_output_sha256_mismatch' }),
        { retry: true },
      );
      expect(mocks.frameleafCloudMl.deleteJob).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.publishValidated).not.toHaveBeenCalled();
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

    it('offers pausing only until the job was started on Frameleaf Cloud', () => {
      const kind = MediaOperationKind.CloudMlJob;
      expect(cloudMlJobCanPause({ kind, result: confirmed() })).toBe(true);
      expect(cloudMlJobCanPause({ kind, result: { ...confirmed(), phase: CloudMlJobPhase.Uploading } })).toBe(true);
      expect(cloudMlJobCanPause({ kind, result: { ...confirmed(), phase: CloudMlJobPhase.Started } })).toBe(false);
      expect(cloudMlJobCanPause({ kind: MediaOperationKind.Bulk, result: null })).toBe(true);
    });
  });
});
