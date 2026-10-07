import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetRestorationMode,
  AssetRestorationSourceType,
  AssetRestorationStatus,
} from 'src/dtos/asset-restoration.dto.js';
import {
  AssetType,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlDestinationKind,
  MlWorkload,
  QueueName,
} from 'src/enum.js';
import { AssetRestoration, AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { RESTORATION_LEASE_MS, RestorationWorkerService } from 'src/services/restoration-worker.service.js';
import { stripsVideoMetadata } from 'src/utils/media-privacy.js';
import {
  RESTORATION_ABANDONED_RESULT_DAYS,
  RestorationErrorCode,
  RestorationInferenceResult,
  RestorationSnapshot,
  restorationAdmissionOf,
} from 'src/utils/restoration.js';

const DAY_MS = 24 * 60 * 60 * 1000;
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { AutoMocked, ServiceMocks, automock, getMocks } from 'test/utils.js';

const RESTORATION_ID = '0195e2a0-0000-7000-8000-000000000010';
const OPERATION_ID = '0195e2a0-0000-7000-8000-000000000020';
const CLAIM = 'claim-token';
/** Stands in for the transaction `publishValidated` hands its callback (FL-43). */
const TRX = { transaction: 'publish' } as never;

describe(RestorationWorkerService.name, () => {
  let sut: RestorationWorkerService;
  let mocks: ServiceMocks;
  let restorations: { [K in keyof AssetRestorationRepository]: ReturnType<typeof vi.fn> };
  let operations: AutoMocked<MediaOperationRepository>;
  let restore: ReturnType<typeof vi.fn>;

  const asset = AssetFactory.from({ ownerId: authStub.user1.user.id, type: AssetType.Image })
    .exif({ exifImageWidth: 4000, exifImageHeight: 3000, orientation: null, colorspace: 'sRGB' })
    .build();

  const snapshot = (overrides: Partial<RestorationSnapshot> = {}): RestorationSnapshot => ({
    version: 1,
    stage: 'preview',
    restorationId: RESTORATION_ID,
    assetId: asset.id,
    ownerId: asset.ownerId,
    sourceType: AssetRestorationSourceType.Image,
    sourceChecksumHex: asset.checksum.toString('hex'),
    sourceWidth: 4000,
    sourceHeight: 3000,
    sourceDurationSeconds: null,
    mode: AssetRestorationMode.Faithful,
    upscale: 2,
    keepGrain: false,
    workload: MlWorkload.RestorationFaithful,
    destinationId: mlDestinationStub.lan.id,
    destinationKind: MlDestinationKind.Lan,
    region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    output: { width: 3840, height: 2880 },
    ...overrides,
  });

  const operation = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
    ({
      id: OPERATION_ID,
      ownerId: asset.ownerId,
      kind: MediaOperationKind.RestorationPreview,
      status: MediaOperationStatus.Preparing,
      destination: MediaOperationDestination.Lan,
      destinationDetail: mlDestinationStub.lan.name,
      label: asset.originalFileName,
      assetId: asset.id,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: RESTORATION_ID,
      snapshot: snapshot(),
      settings: {},
      estimate: null,
      progress: 0,
      processedUnits: '0',
      totalUnits: null,
      attempt: 1,
      maxAttempts: 3,
      claimToken: CLAIM,
      claimedBy: 'worker',
      claimExpiresAt: new Date(),
      heartbeatAt: new Date(),
      cancelRequestedAt: null,
      cancelAcknowledgedAt: null,
      remoteJobId: null,
      remoteReleasedAt: null,
      error: null,
      errorCode: null,
      startedAt: new Date(),
      finishedAt: null,
      dismissedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: 'update',
      ...overrides,
    }) as unknown as MediaOperation;

  const row = (overrides: Partial<AssetRestoration> = {}): AssetRestoration =>
    ({
      id: RESTORATION_ID,
      assetId: asset.id,
      ownerId: asset.ownerId,
      revision: 1,
      status: AssetRestorationStatus.PreviewQueued,
      mode: AssetRestorationMode.Faithful,
      upscale: 2,
      keepGrain: false,
      workload: MlWorkload.RestorationFaithful,
      destinationId: mlDestinationStub.lan.id,
      destinationKind: MlDestinationKind.Lan,
      destinationName: mlDestinationStub.lan.name,
      sourceType: 'image',
      sourceChecksum: asset.checksum,
      sourceWidth: 4000,
      sourceHeight: 3000,
      sourceDurationSeconds: null,
      previewRegion: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      previewOperationId: OPERATION_ID,
      fullOperationId: null,
      previewBeforePath: null,
      previewAfterPath: null,
      resultPath: null,
      resultPreviewPath: null,
      outputWidth: null,
      outputHeight: null,
      modelName: null,
      modelVersion: null,
      provenance: {},
      estimate: null,
      error: null,
      isCurrent: false,
      previewReadyAt: null,
      reviewedAt: null,
      restoredAt: null,
      previewExpiresAt: null,
      resultExpiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: 'update',
      ...overrides,
    }) as unknown as AssetRestoration;

  beforeEach(() => {
    mocks = getMocks();
    restorations = {
      create: vi.fn(),
      get: vi.fn().mockResolvedValue(row()),
      getForOwner: vi.fn(),
      listByAsset: vi.fn(),
      getCurrent: vi.fn(),
      listRestoredForPlayback: vi.fn().mockResolvedValue([]),
      update: vi
        .fn()
        .mockImplementation((id: string, patch: Partial<AssetRestoration>) => Promise.resolve(row({ id, ...patch }))),
      transition: vi
        .fn()
        .mockImplementation((id: string, _from: unknown, patch: Partial<AssetRestoration>) =>
          Promise.resolve(row({ id, ...patch })),
        ),
      setCurrent: vi.fn(),
      listExpiredPreviews: vi.fn().mockResolvedValue([]),
      listExpiredResults: vi.fn().mockResolvedValue([]),
      clearExpiredResult: vi.fn().mockImplementation((id: string) => Promise.resolve(row({ id }))),
      alignWithOperations: vi.fn().mockResolvedValue({ preview: 0, full: 0 }),
      getFilePaths: vi.fn(),
      deleteByAsset: vi.fn(),
    };
    // Automocked so newly added MediaOperationRepository methods (e.g. the FL-162/FL-163 Frameleaf
    // Cloud job queries below, which restoration never reaches) don't need a literal entry here.
    operations = automock(MediaOperationRepository, { strict: false });
    Object.assign(operations, {
      getForOwner: vi.fn().mockResolvedValue(operation()),
      getCheckpoints: vi.fn().mockResolvedValue([]),
      claimNext: vi.fn().mockResolvedValue(undefined),
      heartbeat: vi.fn().mockResolvedValue(true),
      reportProgress: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      // The real one runs `publish` inside a transaction holding the job's row (FL-43); `TRX`
      // stands in for that transaction so the spec can see the row writes went through it.
      publishValidated: vi
        .fn()
        .mockImplementation(async (id: string, token: string, publish: (trx: unknown) => Promise<boolean>) => {
          if (!(await publish(TRX))) {
            return 'rejected';
          }
          const complete = operations.complete as unknown as (...args: unknown[]) => Promise<boolean>;
          return (await complete(id, token, { resultAssetId: null })) ? 'completed' : 'lost';
        }),
      isPublishableResult: vi.fn().mockResolvedValue(true),
      beginValidation: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('failed'),
      requeue: vi.fn().mockResolvedValue(true),
      listUnfinishedForProjects: vi.fn().mockResolvedValue([]),
      countLockedAssets: vi.fn().mockResolvedValue(0),
      getDateTimeOriginals: vi.fn().mockResolvedValue(new Map()),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
      recoverExpiredClaims: vi.fn().mockResolvedValue({ requeued: 0, retried: 0, failed: 0, abandonedCancels: 0 }),
      upsertCheckpoint: vi.fn().mockResolvedValue(true),
      completeCheckpoint: vi.fn().mockResolvedValue(true),
      invalidateCheckpointsFrom: vi.fn().mockResolvedValue(undefined),
    });

    mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
    mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.lan);
    // FL-72: no library routes on the restoration worker's endpoint and nothing shares its GPU.
    mocks.mlDestination.getRoutes.mockResolvedValue([]);
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.lan]);
    mocks.machineLearning.probe.mockResolvedValue({
      ...mlProbeStub.healthy,
      workloads: [MlWorkload.RestorationFaithful],
    });
    mocks.media.decodeImage.mockResolvedValue({
      data: Buffer.alloc(12, 128),
      info: { width: 4000, height: 3000, channels: 3 },
    } as never);
    mocks.media.getImageMetadata
      .mockResolvedValueOnce({ width: 1024, height: 768, isTransparent: false })
      .mockResolvedValueOnce({ width: 2048, height: 1536, isTransparent: false });
    mocks.storage.checkFileExists.mockResolvedValue(true);

    // MachineLearningRepository.restore (FL-114): `restore(selection, input, options)`, mocked here.
    restore = vi.fn().mockImplementation((_selection, _input, options) =>
      Promise.resolve({
        outputPath: options.outputPath,
        width: 2048,
        height: 1536,
        modelName: 'faithful-v1',
        modelVersion: '1.0',
      }),
    );
    (mocks.machineLearning as unknown as { restore: unknown }).restore = restore;

    sut = new RestorationWorkerService(
      mocks.logger as never,
      mocks.config as never,
      mocks.systemMetadata as never,
      mocks.assetJob as never,
      restorations as unknown as AssetRestorationRepository,
      operations as unknown as MediaOperationRepository,
      mocks.mlDestination as never,
      mocks.machineLearning as never,
      mocks.media as never,
      mocks.storage as never,
      mocks.crypto as never,
      mocks.job as never,
    );
  });

  describe('run: still preview', () => {
    it('crops, downsizes, restores on the admitted destination and publishes both preview files atomically', async () => {
      await sut.run(operation(), CLAIM);

      // The stage was bound to this job before any work started.
      expect(restorations.update).toHaveBeenCalledWith(
        RESTORATION_ID,
        expect.objectContaining({ status: AssetRestorationStatus.PreviewRendering, previewOperationId: OPERATION_ID }),
      );
      // The crop is the requested region of the decoded frame; the input is bounded to the preview edge.
      expect(mocks.media.renderDevelopGeometry).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ width: 4000, height: 3000 }),
        expect.objectContaining({ extract: { left: 1000, top: 750, width: 2000, height: 1500 } }),
      );
      expect(mocks.media.encodeDevelopOutput).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.anything(),
        expect.objectContaining({ size: 1024 }),
        expect.stringContaining('/before-'),
      );
      // Exactly the named destination; the cap is the preview's own size times the upscale.
      expect(restore).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationId: mlDestinationStub.lan.id,
          kind: MlDestinationKind.Lan,
          workload: MlWorkload.RestorationFaithful,
        }),
        expect.objectContaining({ kind: 'image', width: 1024, height: 768 }),
        expect.objectContaining({
          mode: AssetRestorationMode.Faithful,
          upscale: 2,
          maxWidth: 2048,
          maxHeight: 1536,
          jobId: OPERATION_ID,
        }),
      );
      // Validation is recorded on the job before anything is published.
      expect(operations.beginValidation).toHaveBeenCalledWith(OPERATION_ID, CLAIM);
      expect(mocks.storage.rename).toHaveBeenCalledTimes(2);
      expect(mocks.storage.rename).toHaveBeenCalledWith(
        expect.stringContaining('/before-'),
        expect.stringMatching(/_restore_.*_before\.jpg$/),
      );
      expect(mocks.storage.rename).toHaveBeenCalledWith(
        expect.stringContaining('/after-'),
        expect.stringMatching(/_restore_.*_after\.png$/),
      );
      expect(restorations.transition).toHaveBeenCalledWith(
        RESTORATION_ID,
        [AssetRestorationStatus.PreviewRendering],
        expect.objectContaining({
          status: AssetRestorationStatus.PreviewReady,
          modelName: 'faithful-v1',
          previewExpiresAt: expect.any(Date),
          provenance: expect.objectContaining({
            preview: expect.objectContaining({ destinationId: mlDestinationStub.lan.id }),
          }),
        }),
        TRX,
      );
      expect(operations.publishValidated).toHaveBeenCalledWith(OPERATION_ID, CLAIM, expect.any(Function));
      expect(operations.complete).toHaveBeenCalledWith(OPERATION_ID, CLAIM, { resultAssetId: null });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('restores only through a selection admitted for restoration on the owner-named destination', async () => {
      await sut.run(operation(), CLAIM);

      const selection = restore.mock.calls[0][0];
      expect(restorationAdmissionOf(selection)).toEqual({ cloudUploadConfirmed: true });
      expect(mocks.storage.unlink).toHaveBeenCalledWith(expect.stringContaining('/after-'));
    });

    it('leaves the row running while the job waits for its automatic retry (FL-104)', async () => {
      // the adapter always exists since FL-114 (AdapterMissing is no longer raised); a worker failure
      // is what waits for the automatic retry now
      restore.mockRejectedValue(new Error('worker unreachable'));
      operations.fail.mockResolvedValue('retrying');

      await sut.run(operation(), CLAIM);

      expect(operations.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        CLAIM,
        expect.objectContaining({ errorCode: RestorationErrorCode.Failed }),
      );
      expect(restorations.transition).not.toHaveBeenCalledWith(
        RESTORATION_ID,
        [AssetRestorationStatus.PreviewRendering],
        expect.objectContaining({ status: AssetRestorationStatus.PreviewFailed }),
      );
    });

    it('fails in place when the destination refuses, never moving the media elsewhere', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloud);

      await sut.run(
        operation({
          snapshot: snapshot({
            destinationId: mlDestinationStub.frameleafCloud.id,
            destinationKind: MlDestinationKind.FrameleafCloud,
          }),
        }),
        CLAIM,
      );

      expect(restore).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        CLAIM,
        expect.objectContaining({
          errorCode: RestorationErrorCode.DestinationRefused,
          error: expect.stringContaining('consent'),
        }),
      );
    });

    it('refuses to run when the original changed since the preview was requested', async () => {
      await sut.run(operation({ snapshot: snapshot({ sourceChecksumHex: 'deadbeef' }) }), CLAIM);
      expect(restore).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        CLAIM,
        expect.objectContaining({ errorCode: RestorationErrorCode.SourceChanged }),
      );
    });

    it('rejects an output above the cap it gave the adapter', async () => {
      mocks.media.getImageMetadata.mockReset();
      mocks.media.getImageMetadata
        .mockResolvedValueOnce({ width: 1024, height: 768, isTransparent: false })
        .mockResolvedValueOnce({ width: 4096, height: 3072, isTransparent: false });

      await sut.run(operation(), CLAIM);

      expect(operations.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        CLAIM,
        expect.objectContaining({ errorCode: RestorationErrorCode.OutputInvalid }),
      );
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalled();
    });

    it('processes a Locked asset the owner asked for like any other', async () => {
      const locked = { ...getForGenerateThumbnail(asset), visibility: 'locked' };
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(locked as never);
      await sut.run(operation(), CLAIM);
      expect(restore).toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalled();
    });
  });

  describe('run: idempotency and decisions', () => {
    it('does nothing when a retried preview job finds the restoration already decided', async () => {
      restorations.get.mockResolvedValue(row({ status: AssetRestorationStatus.Accepted }));

      await sut.run(operation(), CLAIM);

      expect(restorations.update).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        CLAIM,
        expect.objectContaining({ errorCode: RestorationErrorCode.StageNotRunnable }),
      );
    });

    it('resumes a stage that a previous attempt left running or failed', async () => {
      restorations.get.mockResolvedValue(
        row({ status: AssetRestorationStatus.PreviewFailed, error: 'earlier attempt' }),
      );
      await sut.run(operation({ attempt: 2 }), CLAIM);
      expect(restorations.update).toHaveBeenCalledWith(
        RESTORATION_ID,
        expect.objectContaining({ status: AssetRestorationStatus.PreviewRendering, error: null }),
      );
      expect(operations.complete).toHaveBeenCalled();
    });

    it('refuses a job whose snapshot it cannot read', async () => {
      await sut.run(operation({ snapshot: { version: 7 } }), CLAIM);
      expect(operations.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        CLAIM,
        expect.objectContaining({ errorCode: RestorationErrorCode.SnapshotInvalid }),
      );
      expect(restorations.get).not.toHaveBeenCalled();
    });

    it('removes the published files again when the owner discarded the restoration mid-render', async () => {
      restorations.transition.mockResolvedValue(undefined);
      await sut.run(operation(), CLAIM);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: expect.arrayContaining([expect.stringMatching(/_after\.png$/)]) },
      });
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        CLAIM,
        expect.objectContaining({ errorCode: RestorationErrorCode.StageNotRunnable }),
      );
    });
  });

  describe('run: full render retention (FL-115)', () => {
    const fullOperation = () =>
      operation({ kind: MediaOperationKind.Restoration, snapshot: snapshot({ stage: 'full' }) });

    beforeEach(() => {
      restorations.get.mockResolvedValue(row({ status: AssetRestorationStatus.RestoreFailed }));
    });

    it('takes the leftovers back from retention when a retry starts', async () => {
      await sut.run(fullOperation(), CLAIM);

      expect(restorations.update).toHaveBeenCalledWith(
        RESTORATION_ID,
        expect.objectContaining({
          status: AssetRestorationStatus.Restoring,
          fullOperationId: OPERATION_ID,
          resultExpiresAt: null,
        }),
      );
    });

    it('starts the retention clock when a full render fails for good', async () => {
      restore.mockRejectedValue(new Error('worker unreachable'));
      const before = Date.now();

      await sut.run(fullOperation(), CLAIM);

      const patch = restorations.transition.mock.calls
        .map((call) => call[2] as Partial<AssetRestoration>)
        .find((value) => value.status === AssetRestorationStatus.RestoreFailed)!;
      const expiresAt = patch.resultExpiresAt as unknown as Date;
      expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(RESTORATION_ABANDONED_RESULT_DAYS * DAY_MS - 1000);
      expect(expiresAt.getTime() - before).toBeLessThanOrEqual(RESTORATION_ABANDONED_RESULT_DAYS * DAY_MS + 5000);
    });

    it('starts the retention clock when the owner cancels a full render', async () => {
      operations.reportProgress.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      operations.getForOwner.mockResolvedValue(
        operation({ status: MediaOperationStatus.Cancelling, cancelRequestedAt: new Date() }),
      );

      await sut.run(fullOperation(), CLAIM);

      expect(restorations.transition).toHaveBeenCalledWith(RESTORATION_ID, [AssetRestorationStatus.Restoring], {
        status: AssetRestorationStatus.RestoreCancelled,
        resultExpiresAt: expect.any(Date),
      });
    });

    it('refuses a full render when the destination no longer runs the reviewed model', async () => {
      await sut.run(
        operation({
          kind: MediaOperationKind.Restoration,
          snapshot: snapshot({ stage: 'full', model: { name: 'faithful-v1', version: '0.9' } }),
        }),
        CLAIM,
      );

      expect(operations.fail).toHaveBeenCalledWith(
        OPERATION_ID,
        CLAIM,
        expect.objectContaining({
          errorCode: RestorationErrorCode.ModelChanged,
          error: expect.stringContaining('request a new preview'),
        }),
      );
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('publishes a full render that ran the reviewed model', async () => {
      await sut.run(
        operation({
          kind: MediaOperationKind.Restoration,
          snapshot: snapshot({ stage: 'full', model: { name: 'faithful-v1', version: '1.0' } }),
        }),
        CLAIM,
      );

      expect(restore).toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalledWith(
        OPERATION_ID,
        CLAIM,
        expect.objectContaining({ errorCode: RestorationErrorCode.ModelChanged }),
      );
    });

    it('sends a web-native original to the worker as a copy without EXIF or GPS, its ICC kept (FL-162)', async () => {
      await sut.run(
        operation({
          kind: MediaOperationKind.Restoration,
          snapshot: snapshot({ stage: 'full', model: { name: 'faithful-v1', version: '1.0' } }),
        }),
        CLAIM,
      );

      expect(mocks.media.writeStrippedStill).toHaveBeenCalledWith(
        asset.originalPath,
        expect.stringMatching(/\/input-.*\.jpg$/),
        'jpeg',
      );
      const [, input] = restore.mock.calls[0];
      expect(input.path).not.toBe(asset.originalPath);
      expect(input.path).toBe(mocks.media.writeStrippedStill.mock.calls[0][1]);
    });

    it('never sets a retention date on a preview stage that stops', async () => {
      restorations.get.mockResolvedValue(row());
      restore.mockRejectedValue(new Error('worker unreachable'));

      await sut.run(operation(), CLAIM);

      expect(restorations.transition).toHaveBeenCalledWith(RESTORATION_ID, [AssetRestorationStatus.PreviewRendering], {
        status: AssetRestorationStatus.PreviewFailed,
        error: 'worker unreachable',
      });
    });
  });

  describe('run: video preview (FL-162)', () => {
    it('cuts the preview clip with the video and audio streams only, and no metadata or chapters', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { formatName: 'mp4', formatLongName: 'mp4', duration: 5, bitrate: 0 },
        videoStreams: [{ width: 1920, height: 1080 }],
        audioStreams: [],
      } as never);
      const video = snapshot({
        sourceType: AssetRestorationSourceType.Video,
        sourceWidth: 1920,
        sourceHeight: 1080,
        sourceDurationSeconds: 60,
        output: { width: 3840, height: 2160 },
      });

      await sut.run(operation({ snapshot: video }), CLAIM);

      const [, clip, options] = mocks.media.transcode.mock.calls[0];
      expect(clip).toEqual(expect.stringContaining('/before-'));
      expect(stripsVideoMetadata(options.outputOptions ?? [])).toBe(true);
      expect(options.outputOptions).toEqual(expect.arrayContaining(['-map', '0:v:0', '0:a:0?']));
      expect(restore).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'video', path: clip }),
        expect.anything(),
      );
    });
  });

  describe('run: local Smooth motion (FL-162)', () => {
    const smooth = (stage: 'preview' | 'full') =>
      snapshot({
        stage,
        sourceType: AssetRestorationSourceType.Video,
        sourceWidth: 1920,
        sourceHeight: 1080,
        sourceDurationSeconds: 45,
        mode: AssetRestorationMode.SmoothMotion,
        workload: MlWorkload.Interpolation,
        upscale: 1,
        interpolationFactor: 4,
        output: { width: 1920, height: 1080 },
        ...(stage === 'full' && { model: { name: 'faithful-v1', version: '1.0' } }),
      });

    beforeEach(() => {
      mocks.mlDestination.getById.mockResolvedValue({
        ...mlDestinationStub.lan,
        workloads: [MlWorkload.Interpolation],
      });
      mocks.machineLearning.probe.mockResolvedValue({ ...mlProbeStub.healthy, workloads: [MlWorkload.Interpolation] });
      mocks.media.probe.mockResolvedValue({
        format: { formatName: 'mp4', formatLongName: 'mp4', duration: 20, bitrate: 0 },
        videoStreams: [{ width: 1920, height: 1080, frameRate: 25 }],
        audioStreams: [],
      } as never);
    });

    it('asks the home worker for interpolation at the chosen factor, at the source size', async () => {
      await sut.run(operation({ snapshot: smooth('preview') }), CLAIM);

      expect(restore).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'video', width: 1920, height: 1080 }),
        expect.objectContaining({
          mode: AssetRestorationMode.SmoothMotion,
          upscale: 1,
          interpolationFactor: 4,
          trailingContextFrame: false,
          maxWidth: 1920,
          maxHeight: 1080,
        }),
      );
    });

    it('gives every chunk but the last the next chunk’s first frame as context, so no join is left out', async () => {
      restorations.get.mockResolvedValue(
        row({ status: AssetRestorationStatus.Accepted, mode: AssetRestorationMode.SmoothMotion, upscale: 4 }),
      );
      mocks.storage.stat.mockResolvedValue({ size: 1024 } as never);
      mocks.crypto.hashFile.mockResolvedValue(Buffer.from('chunk'));
      await sut.run(operation({ kind: MediaOperationKind.Restoration, snapshot: smooth('full') }), CLAIM);

      const chunkCuts = mocks.media.transcode.mock.calls.filter(([, output]) => String(output).includes('-in-'));
      // 45 s in 20 s chunks: 20, 20 and 5 seconds; the first two carry one more frame (1/25 s)
      expect(chunkCuts.map((call) => call[2].inputOptions)).toEqual([
        ['-ss', '0.000', '-t', '20.040'],
        ['-ss', '20.000', '-t', '20.040'],
        ['-ss', '40.000', '-t', '5.000'],
      ]);
      expect(restore.mock.calls.map((call) => call[2].trailingContextFrame)).toEqual([true, true, false]);
      expect(restore.mock.calls.every((call) => call[2].interpolationFactor === 4)).toBe(true);
    });
  });

  describe('run: cancellation', () => {
    it('acknowledges an owner cancel and marks the stage cancelled instead of failed', async () => {
      operations.reportProgress.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      operations.getForOwner.mockResolvedValue(
        operation({ status: MediaOperationStatus.Cancelling, cancelRequestedAt: new Date() }),
      );

      await sut.run(operation(), CLAIM);

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(OPERATION_ID, CLAIM, { released: true });
      expect(restorations.transition).toHaveBeenCalledWith(RESTORATION_ID, [AssetRestorationStatus.PreviewRendering], {
        status: AssetRestorationStatus.PreviewCancelled,
      });
      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('hands a paused job back at the interruption and leaves the row running for the resume (FL-104)', async () => {
      operations.reportProgress.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      operations.getForOwner.mockResolvedValue(
        operation({ status: MediaOperationStatus.Rendering, pauseRequestedAt: new Date() } as never),
      );

      await sut.run(operation(), CLAIM);

      expect(operations.settlePause).toHaveBeenCalledWith(OPERATION_ID, CLAIM);
      expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
      expect(restorations.transition).not.toHaveBeenCalled();
    });

    it('requeues at once when the owner resumed before the pause landed (FL-104)', async () => {
      operations.reportProgress.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      operations.getForOwner.mockResolvedValue(operation({ status: MediaOperationStatus.Rendering }));

      await sut.run(operation(), CLAIM);

      expect(operations.settlePause).not.toHaveBeenCalled();
      expect(operations.requeue).toHaveBeenCalledWith(OPERATION_ID, CLAIM, { delayMs: 0, returnAttempt: true });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('publishes nothing when the owner cancelled while the output was being checked (FL-43)', async () => {
      // The claim no longer holds a validating job when publication starts: the cancel won.
      operations.publishValidated.mockResolvedValueOnce('lost');
      operations.getForOwner.mockResolvedValue(
        operation({ status: MediaOperationStatus.Cancelling, cancelRequestedAt: new Date() }),
      );

      await sut.run(operation(), CLAIM);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(restorations.transition).not.toHaveBeenCalledWith(
        RESTORATION_ID,
        expect.anything(),
        expect.objectContaining({ status: AssetRestorationStatus.PreviewReady }),
        expect.anything(),
      );
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(OPERATION_ID, CLAIM, { released: true });
      expect(restorations.transition).toHaveBeenCalledWith(RESTORATION_ID, [AssetRestorationStatus.PreviewRendering], {
        status: AssetRestorationStatus.PreviewCancelled,
      });
      // The rendered output stays scratch and is removed; it was never moved into place.
      expect(mocks.storage.unlink).toHaveBeenCalledWith(expect.stringContaining('/after-'));
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('never touches the published paths when a stale worker finds its claim gone at publication (FL-43)', async () => {
      operations.publishValidated.mockResolvedValueOnce('lost');
      operations.getForOwner.mockResolvedValue(
        operation({ status: MediaOperationStatus.Rendering, claimToken: 'other' }),
      );
      operations.requeue.mockResolvedValueOnce(false);

      await sut.run(operation(), CLAIM);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.FileDelete }));
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(expect.stringMatching(/_restore_.*_after\.png$/));
      expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('leaves a lost lease to recovery: no failure, no cancel, the row stays running', async () => {
      operations.reportProgress.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      operations.getForOwner.mockResolvedValue(operation({ status: MediaOperationStatus.Queued, claimToken: null }));
      // The claim is gone, so handing it back matches nothing.
      operations.requeue.mockResolvedValueOnce(false);

      await sut.run(operation(), CLAIM);

      expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
      expect(restorations.transition).not.toHaveBeenCalled();
    });
  });

  describe('run: lease renewal (FL-344)', () => {
    let signal: AbortSignal;
    let finishRestore: (() => void) | undefined;
    let rendering: ReturnType<typeof Promise.withResolvers<void>>;
    let inference: ReturnType<typeof Promise.withResolvers<RestorationInferenceResult>>;
    let renewal: ReturnType<typeof Promise.withResolvers<boolean>> | undefined;
    let running: Promise<void> | undefined;
    let unhandled: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers();
      rendering = Promise.withResolvers<void>();
      inference = Promise.withResolvers<RestorationInferenceResult>();
      renewal = undefined;
      running = undefined;
      finishRestore = undefined;
      unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      restore.mockImplementation((_selection, _input, options) => {
        signal = options.signal;
        signal.addEventListener('abort', () => inference.reject(signal.reason), { once: true });
        finishRestore = () =>
          inference.resolve({
            outputPath: options.outputPath,
            width: 2048,
            height: 1536,
            modelName: 'faithful-v1',
            modelVersion: '1.0',
          });
        rendering.resolve();
        return inference.promise;
      });
    });

    afterEach(async () => {
      try {
        sut.stop();
        renewal?.resolve(true);
        finishRestore?.();
        await running;
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    const begin = async () => {
      running = sut.run(operation(), CLAIM);
      await rendering.promise;
    };

    it.each(['heartbeat', 'getForOwner'] as const)('interrupts safely when renewal %s rejects', async (method) => {
      const error = new Error(`${method} database unavailable`);
      operations[method].mockRejectedValueOnce(error);
      await begin();

      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS / 3);

      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBeInstanceOf(Error);
      expect(signal.reason.message).toBe('Restoration interrupted');
      await running;
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(error.message));
      expect(operations.requeue).toHaveBeenCalledWith(OPERATION_ID, CLAIM, { delayMs: 0, returnAttempt: true });
      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(expect.stringContaining('/after-'));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS);
      expect(operations.heartbeat).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['cancel', true, operation({ status: MediaOperationStatus.Cancelling, cancelRequestedAt: new Date() })],
      ['pause', true, operation({ status: MediaOperationStatus.Rendering, pauseRequestedAt: new Date() } as never)],
      ['lost claim', false, operation({ status: MediaOperationStatus.Queued, claimToken: null })],
    ] as const)('settles a renewal interrupted by %s without failing the render', async (reason, alive, current) => {
      operations.heartbeat.mockResolvedValue(alive);
      operations.getForOwner.mockResolvedValue(current);
      operations.requeue.mockResolvedValue(false);
      await begin();

      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS / 3);

      expect(signal.aborted).toBe(true);
      await running;
      if (reason === 'cancel') {
        expect(operations.acknowledgeCancel).toHaveBeenCalledWith(OPERATION_ID, CLAIM, { released: true });
        expect(restorations.transition).toHaveBeenCalledWith(
          RESTORATION_ID,
          [AssetRestorationStatus.PreviewRendering],
          { status: AssetRestorationStatus.PreviewCancelled },
        );
      } else if (reason === 'pause') {
        expect(operations.settlePause).toHaveBeenCalledWith(OPERATION_ID, CLAIM);
        expect(restorations.transition).not.toHaveBeenCalled();
      } else {
        expect(operations.requeue).toHaveBeenCalledWith(OPERATION_ID, CLAIM, { delayMs: 0, returnAttempt: true });
        expect(restorations.transition).not.toHaveBeenCalled();
      }
      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps successful renewals serial while inference continues', async () => {
      renewal = Promise.withResolvers<boolean>();
      operations.heartbeat.mockReturnValueOnce(renewal.promise);
      await begin();

      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS);

      expect(operations.heartbeat).toHaveBeenCalledTimes(1);
      expect(operations.heartbeat).toHaveBeenCalledWith(OPERATION_ID, CLAIM, RESTORATION_LEASE_MS);
      expect(operations.getForOwner).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(false);
      renewal.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(operations.getForOwner).toHaveBeenCalledWith(OPERATION_ID, asset.ownerId);
      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS / 3);
      expect(operations.heartbeat).toHaveBeenCalledTimes(2);
      expect(signal.aborted).toBe(false);
      finishRestore!();
      await running;
      expect(operations.complete).toHaveBeenCalledTimes(1);
      expect(operations.fail).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the interval and drains a pending renewal before a completed run returns', async () => {
      renewal = Promise.withResolvers<boolean>();
      operations.heartbeat.mockReturnValueOnce(renewal.promise);
      await begin();
      let returned = false;
      void running!.then(() => (returned = true));
      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS / 3);
      finishRestore!();
      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS);

      expect(operations.complete).toHaveBeenCalledTimes(1);
      expect(returned).toBe(false);
      expect(operations.heartbeat).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      renewal.resolve(true);
      await running;
      expect(returned).toBe(true);
      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS);
      expect(operations.heartbeat).toHaveBeenCalledTimes(1);
    });

    it('aborts on shutdown and drains renewal before handing the claim back', async () => {
      renewal = Promise.withResolvers<boolean>();
      operations.heartbeat.mockReturnValueOnce(renewal.promise);
      await begin();
      let returned = false;
      void running!.then(() => (returned = true));
      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS / 3);

      sut.onShutdown();
      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS);

      expect(signal.aborted).toBe(true);
      expect(returned).toBe(false);
      expect(operations.requeue).not.toHaveBeenCalled();
      expect(operations.heartbeat).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      renewal.resolve(true);
      await running;
      expect(operations.requeue).toHaveBeenCalledWith(OPERATION_ID, CLAIM, { delayMs: 0, returnAttempt: true });
      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(expect.stringContaining('/after-'));
      await vi.advanceTimersByTimeAsync(RESTORATION_LEASE_MS);
      expect(operations.heartbeat).toHaveBeenCalledTimes(1);
    });
  });

  describe('tick', () => {
    it('claims restoration kinds only and runs one job at a time', async () => {
      operations.claimNext.mockResolvedValueOnce({ operation: operation(), claimToken: CLAIM });
      expect(await sut.tick()).toBe(true);
      expect(operations.claimNext).toHaveBeenCalledWith(
        expect.objectContaining({ kinds: [MediaOperationKind.RestorationPreview, MediaOperationKind.Restoration] }),
      );
      expect(await sut.tick()).toBe(false);
    });

    describe('a restoration worker on the GPU library analysis uses (FL-72)', () => {
      const shared = { ...mlDestinationStub.lan, sharesLibraryHardware: true };
      const counts = (active: number, waiting: number) => ({
        active,
        waiting,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      });

      beforeEach(() => {
        mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, shared]);
        mocks.job.isPaused.mockResolvedValue(false);
      });

      it('holds full restorations bound to it while library analysis has work, and never previews', async () => {
        mocks.job.getJobCounts.mockImplementation((queue) =>
          Promise.resolve(queue === QueueName.FaceDetection ? counts(1, 40) : counts(0, 0)),
        );

        await sut.tick();

        expect(operations.claimNext).toHaveBeenCalledWith(
          expect.objectContaining({
            holdBack: { kinds: [MediaOperationKind.Restoration], destinationIds: [shared.id] },
          }),
        );
      });

      it('claims normally once library analysis is idle', async () => {
        mocks.job.getJobCounts.mockResolvedValue(counts(0, 0));

        await sut.tick();

        expect(operations.claimNext).toHaveBeenCalledWith(expect.not.objectContaining({ holdBack: expect.anything() }));
      });

      it('does not wait behind a queue an administrator paused', async () => {
        mocks.job.getJobCounts.mockResolvedValue(counts(0, 500));
        mocks.job.isPaused.mockResolvedValue(true);

        await sut.tick();

        expect(operations.claimNext).toHaveBeenCalledWith(expect.not.objectContaining({ holdBack: expect.anything() }));
      });

      it('never reads the queues when no worker shares hardware', async () => {
        mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.lan]);

        await sut.tick();

        expect(mocks.job.getJobCounts).not.toHaveBeenCalled();
      });
    });
  });

  describe('sweep', () => {
    it('aligns rows with finished jobs and applies preview retention, leaving recovery to the one sweep', async () => {
      restorations.listExpiredPreviews.mockResolvedValue([
        row({ status: AssetRestorationStatus.PreviewReady, previewBeforePath: '/b.jpg', previewAfterPath: '/a.png' }),
        row({
          id: 'other',
          status: AssetRestorationStatus.Rejected,
          previewBeforePath: '/rb.jpg',
          previewAfterPath: null,
        }),
      ]);

      const result = await sut.sweep();

      // Lapsed claims are MediaOperationSweepService's to recover, for every kind (FL-104).
      expect(operations.recoverExpiredClaims).not.toHaveBeenCalled();
      expect(restorations.alignWithOperations).toHaveBeenCalled();
      // An unreviewed preview expires; a decided one only loses its files.
      expect(restorations.update).toHaveBeenCalledWith(
        RESTORATION_ID,
        expect.objectContaining({
          status: AssetRestorationStatus.Expired,
          previewBeforePath: null,
          previewAfterPath: null,
          previewExpiresAt: null,
        }),
      );
      expect(restorations.update).toHaveBeenCalledWith('other', {
        previewBeforePath: null,
        previewAfterPath: null,
        previewExpiresAt: null,
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FileDelete, data: { files: ['/b.jpg', '/a.png'] } });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FileDelete, data: { files: ['/rb.jpg'] } });
      expect(result.removed).toBe(3);
    });

    it('gives aligned full-render failures a retention date', async () => {
      const before = Date.now();
      await sut.sweep();

      const [expiresAt] = restorations.alignWithOperations.mock.calls[0] as [Date];
      expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(RESTORATION_ABANDONED_RESULT_DAYS * DAY_MS - 1000);
    });

    it('removes the leftovers of an abandoned full render once its retention lapses (FL-115)', async () => {
      restorations.listExpiredResults.mockResolvedValue([
        row({ status: AssetRestorationStatus.RestoreCancelled, resultExpiresAt: new Date(0) as never }),
      ]);

      await sut.sweep();

      expect(restorations.listExpiredResults).toHaveBeenCalledWith(expect.any(Date), expect.any(Number));
      expect(restorations.clearExpiredResult).toHaveBeenCalledWith(
        RESTORATION_ID,
        AssetRestorationStatus.RestoreCancelled,
        expect.any(Date),
      );
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining(RESTORATION_ID), {
        recursive: true,
        force: true,
      });
      // Nothing to delete file by file: the checkpoints live in the work folder.
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('leaves the files and work folder alone when the row changed since the read (FL-115)', async () => {
      restorations.listExpiredResults.mockResolvedValue([
        row({
          status: AssetRestorationStatus.RestoreCancelled,
          resultExpiresAt: new Date(0) as never,
          resultPath: '/thumbs/restored.mp4',
        }),
      ]);
      // A retry moved the row on between the read and the write.
      restorations.clearExpiredResult.mockResolvedValue(undefined);

      await sut.sweep();

      expect(mocks.storage.unlinkDir).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });
});
