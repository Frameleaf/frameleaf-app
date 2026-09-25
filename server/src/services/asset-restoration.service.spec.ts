import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssetRestorationFileKind,
  AssetRestorationMode,
  AssetRestorationStatus,
  DEFAULT_RESTORATION_REGION,
} from 'src/dtos/asset-restoration.dto.js';
import {
  AssetType,
  JobName,
  MediaOperationDestination,
  MediaOperationKind,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
} from 'src/enum.js';
import { AssetRestoration, AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { AssetRestorationService, parseDurationSeconds } from 'src/services/asset-restoration.service.js';
import { MlDestinationRefusedError } from 'src/utils/ml-destination.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

// eslint-friendly alias: a mock whose implementation may return anything, promises included.
type AnyMock = Mock<(...args: any[]) => any>;

const RESTORATION_ID = '0195e2a0-0000-7000-8000-000000000010';
const OPERATION_ID = '0195e2a0-0000-7000-8000-000000000020';

describe(AssetRestorationService.name, () => {
  let sut: AssetRestorationService;
  let mocks: ServiceMocks;
  let restorations: { [K in keyof AssetRestorationRepository]: AnyMock };
  let operations: Pick<{ [K in keyof MediaOperationRepository]: AnyMock }, 'create' | 'requestCancel'>;

  const asset = AssetFactory.from({ ownerId: authStub.user1.user.id, type: AssetType.Image })
    .exif({ exifImageWidth: 6000, exifImageHeight: 4000, orientation: '1', fileSizeInByte: 12_000_000 })
    .build();

  const row = (overrides: Partial<AssetRestoration> = {}): AssetRestoration =>
    ({
      id: RESTORATION_ID,
      assetId: asset.id,
      ownerId: asset.ownerId,
      revision: 1,
      status: AssetRestorationStatus.PreviewReady,
      mode: AssetRestorationMode.Faithful,
      upscale: 2,
      keepGrain: false,
      workload: MlWorkload.RestorationFaithful,
      destinationId: mlDestinationStub.lan.id,
      destinationKind: MlDestinationKind.Lan,
      destinationName: mlDestinationStub.lan.name,
      sourceType: 'image',
      sourceChecksum: asset.checksum,
      sourceWidth: 6000,
      sourceHeight: 4000,
      sourceDurationSeconds: null,
      previewRegion: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      previewOperationId: OPERATION_ID,
      fullOperationId: null,
      previewBeforePath: '/data/thumbs/before.jpg',
      previewAfterPath: '/data/thumbs/after.png',
      resultPath: null,
      resultPreviewPath: null,
      outputWidth: null,
      outputHeight: null,
      modelName: 'faithful-v1',
      modelVersion: null,
      provenance: {},
      estimate: null,
      error: null,
      isCurrent: false,
      previewReadyAt: new Date('2026-09-22T10:00:00Z'),
      reviewedAt: null,
      restoredAt: null,
      previewExpiresAt: null,
      resultExpiresAt: null,
      createdAt: new Date('2026-09-22T09:00:00Z'),
      updatedAt: new Date('2026-09-22T10:00:00Z'),
      updateId: 'update-id',
      ...overrides,
    }) as unknown as AssetRestoration;

  beforeEach(() => {
    mocks = getMocks();
    restorations = {
      create: vi
        .fn()
        .mockImplementation((input) => Promise.resolve(row({ ...input, id: RESTORATION_ID, status: input.status }))),
      get: vi.fn(),
      getForOwner: vi.fn(),
      listByAsset: vi.fn().mockResolvedValue([]),
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
      setCurrent: vi.fn().mockResolvedValue(void 0),
      listExpiredPreviews: vi.fn().mockResolvedValue([]),
      listExpiredResults: vi.fn().mockResolvedValue([]),
      clearExpiredResult: vi.fn(),
      alignWithOperations: vi.fn().mockResolvedValue({ preview: 0, full: 0 }),
      getFilePaths: vi.fn().mockResolvedValue([]),
      deleteByAsset: vi.fn().mockResolvedValue(void 0),
    };
    operations = {
      create: vi.fn().mockImplementation((input) => Promise.resolve({ ...input, id: OPERATION_ID, status: 'queued' })),
      requestCancel: vi.fn().mockResolvedValue(undefined),
    };

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getById.mockResolvedValue(asset as never);
    // A LAN worker that is allowed to and reports that it serves faithful restoration.
    mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.lan);
    mocks.mlDestination.getAll.mockResolvedValue([
      mlDestinationStub.local,
      mlDestinationStub.lan,
      mlDestinationStub.runPodVideo,
    ]);
    // No library routes by default; the FL-72 case below sets one.
    mocks.mlDestination.getRoutes.mockResolvedValue([]);
    mocks.mlDestination.getThroughput.mockResolvedValue({ sampleCount: 0, bytesSent: 0, durationMs: 0, spentUsd: 0 });
    mocks.machineLearning.probe.mockResolvedValue({
      ...mlProbeStub.healthy,
      workloads: [MlWorkload.RestorationFaithful],
    });

    sut = new AssetRestorationService(
      mocks.logger as never,
      mocks.access as never,
      mocks.asset as never,
      restorations as unknown as AssetRestorationRepository,
      operations as unknown as MediaOperationRepository,
      mocks.mlDestination as never,
      mocks.machineLearning as never,
      mocks.job as never,
      mocks.storage as never,
    );
  });

  describe('access', () => {
    it('refuses every operation on an asset the user cannot edit, before anything is created', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      const request = {
        mode: AssetRestorationMode.Faithful,
        upscale: 2 as const,
        keepGrain: false,
        destinationId: mlDestinationStub.lan.id,
        region: DEFAULT_RESTORATION_REGION,
      };
      await expect(sut.list(authStub.user1, asset.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.getOptions(authStub.user1, asset.id, {})).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.requestPreview(authStub.user1, asset.id, request)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.setCurrent(authStub.user1, asset.id, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(restorations.create).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    });

    it('answers not found for a restoration that belongs to another account or does not exist', async () => {
      restorations.getForOwner.mockResolvedValue(undefined);
      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        sut.getFile(authStub.user1, asset.id, RESTORATION_ID, AssetRestorationFileKind.After),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(restorations.getForOwner).toHaveBeenCalledWith(RESTORATION_ID, asset.id, authStub.user1.user.id);
    });
  });

  describe('getOptions', () => {
    it('lists every destination with the admission verdict from the persisted probe and a per-destination estimate', async () => {
      mocks.mlDestination.getThroughput.mockImplementation((id: string) =>
        Promise.resolve(
          id === mlDestinationStub.lan.id
            ? { sampleCount: 3, bytesSent: 6_000_000, durationMs: 3000, spentUsd: 0 }
            : { sampleCount: 0, bytesSent: 0, durationMs: 0, spentUsd: 0 },
        ),
      );

      const options = await sut.getOptions(authStub.user1, asset.id, {
        mode: AssetRestorationMode.Faithful,
        upscale: 2,
      });

      expect(options).toMatchObject({
        sourceType: 'image',
        outputWidth: 3240,
        outputHeight: 2160,
        previewSeconds: null,
        adapterInstalled: true,
      });
      const local = options.destinations.find((item) => item.id === mlDestinationStub.local.id);
      const lan = options.destinations.find((item) => item.id === mlDestinationStub.lan.id);
      const runPod = options.destinations.find((item) => item.id === mlDestinationStub.runPodVideo.id);
      expect(local).toMatchObject({
        available: false,
        refusal: MlAdmissionRefusal.WorkloadNotAllowed,
        leavesNetwork: false,
      });
      expect(lan).toMatchObject({ available: true, refusal: null, leavesNetwork: false });
      expect(lan?.estimate.fullSeconds).toBe(6);
      expect(lan?.estimate.previewSeconds).not.toBeNull();
      // Without recorded consent the cloud destination is shown as refused, never hidden and never chosen.
      expect(runPod).toMatchObject({
        available: false,
        refusal: MlAdmissionRefusal.ConsentMissing,
        leavesNetwork: true,
        consentGranted: false,
      });
      expect(runPod?.estimate.fullSeconds).toBeNull();
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    });

    it('never offers an endpoint library analysis is routed to (FL-72)', async () => {
      const sameUrl = { ...mlDestinationStub.lan, url: mlDestinationStub.local.url };
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, sameUrl]);
      mocks.mlDestination.getRoutes.mockResolvedValue([
        { workload: MlWorkload.Face, destinationId: mlDestinationStub.local.id, updatedAt: new Date() },
      ]);
      mocks.mlDestination.getById.mockImplementation((id: string) =>
        Promise.resolve(id === mlDestinationStub.local.id ? mlDestinationStub.local : sameUrl),
      );

      const options = await sut.getOptions(authStub.user1, asset.id, {
        mode: AssetRestorationMode.Faithful,
        upscale: 2,
      });

      expect(options.destinations.find((item) => item.id === sameUrl.id)).toMatchObject({
        available: false,
        refusal: MlAdmissionRefusal.RoleConflict,
      });
    });
  });

  describe('requestPreview', () => {
    const request = {
      mode: AssetRestorationMode.Faithful,
      upscale: 2 as const,
      keepGrain: false,
      destinationId: mlDestinationStub.lan.id,
      region: DEFAULT_RESTORATION_REGION,
    };

    it('refuses restoration on the library-analysis pod up front and creates nothing (FL-72)', async () => {
      const legacyPod = { ...mlDestinationStub.runPodConsented, workloads: [MlWorkload.RestorationFaithful] };
      mocks.mlDestination.getById.mockResolvedValue(legacyPod);

      const error = await sut
        .requestPreview(authStub.user1, asset.id, { ...request, destinationId: legacyPod.id })
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MlDestinationRefusedError);
      expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.RoleConflict);
      expect(restorations.create).not.toHaveBeenCalled();
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    });

    it('refuses a cloud destination without consent and creates nothing', async () => {
      mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.runPodVideo);

      await expect(
        sut.requestPreview(authStub.user1, asset.id, { ...request, destinationId: mlDestinationStub.runPodVideo.id }),
      ).rejects.toBeInstanceOf(MlDestinationRefusedError);
      expect(restorations.create).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    });

    it('creates the next revision and a preview job bound to the named destination', async () => {
      restorations.update.mockImplementation((id: string, patch: Partial<AssetRestoration>) =>
        Promise.resolve(row({ id, status: AssetRestorationStatus.PreviewQueued, ...patch })),
      );
      const response = await sut.requestPreview(authStub.user1, asset.id, {
        ...request,
        region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      });

      expect(restorations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: asset.id,
          ownerId: asset.ownerId,
          status: AssetRestorationStatus.PreviewQueued,
          workload: MlWorkload.RestorationFaithful,
          destinationId: mlDestinationStub.lan.id,
          destinationKind: MlDestinationKind.Lan,
          sourceChecksum: asset.checksum,
          sourceWidth: 6000,
          sourceHeight: 4000,
          previewRegion: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
        }),
      );
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.RestorationPreview,
          destination: MediaOperationDestination.Lan,
          destinationDetail: mlDestinationStub.lan.name,
          assetId: asset.id,
          revisionId: RESTORATION_ID,
          snapshot: expect.objectContaining({
            stage: 'preview',
            restorationId: RESTORATION_ID,
            destinationId: mlDestinationStub.lan.id,
            sourceChecksumHex: asset.checksum.toString('hex'),
            output: { width: 3240, height: 2160, scale: 0.54, capped: true },
          }),
          settings: expect.objectContaining({ mode: 'Faithful', upscale: 2, preview: true }),
          // Nothing was measured, so no estimate is stored rather than an invented one.
          estimate: null,
        }),
      );
      expect(restorations.update).toHaveBeenCalledWith(RESTORATION_ID, { previewOperationId: OPERATION_ID });
      expect(response.status).toBe(AssetRestorationStatus.PreviewQueued);
      expect(response.activeOperationId).toBe(OPERATION_ID);
    });

    it('refuses an offline original and unsupported media', async () => {
      mocks.asset.getById.mockResolvedValue({ ...asset, isOffline: true } as never);
      await expect(sut.requestPreview(authStub.user1, asset.id, request)).rejects.toBeInstanceOf(BadRequestException);
      mocks.asset.getById.mockResolvedValue({ ...asset, originalFileName: 'sticker.gif' } as never);
      await expect(sut.requestPreview(authStub.user1, asset.id, request)).rejects.toBeInstanceOf(BadRequestException);
      expect(restorations.create).not.toHaveBeenCalled();
    });

    it('marks the row failed when the job cannot be recorded', async () => {
      operations.create.mockRejectedValue(new Error('database gone'));
      await expect(sut.requestPreview(authStub.user1, asset.id, request)).rejects.toThrow('database gone');
      expect(restorations.update).toHaveBeenCalledWith(
        RESTORATION_ID,
        expect.objectContaining({ status: AssetRestorationStatus.PreviewFailed, error: 'database gone' }),
      );
    });
  });

  describe('accept', () => {
    it('binds the full render to the previewed destination, mode and size', async () => {
      restorations.getForOwner.mockResolvedValue(row());

      const response = await sut.accept(authStub.user1, asset.id, RESTORATION_ID);

      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.Restoration,
          destination: MediaOperationDestination.Lan,
          revisionId: RESTORATION_ID,
          snapshot: expect.objectContaining({
            stage: 'full',
            destinationId: mlDestinationStub.lan.id,
            mode: AssetRestorationMode.Faithful,
            upscale: 2,
            sourceChecksumHex: asset.checksum.toString('hex'),
            output: { width: 3240, height: 2160, scale: 0.54, capped: true },
            // The model the reviewed preview ran (FL-115).
            model: { name: 'faithful-v1', version: null },
          }),
          settings: expect.objectContaining({ preview: false }),
        }),
      );
      expect(restorations.transition).toHaveBeenCalledWith(
        RESTORATION_ID,
        [AssetRestorationStatus.PreviewReady],
        expect.objectContaining({
          status: AssetRestorationStatus.Accepted,
          fullOperationId: OPERATION_ID,
          previewExpiresAt: expect.any(Date),
        }),
      );
      expect(response.status).toBe(AssetRestorationStatus.Accepted);
      expect(response.activeOperationId).toBe(OPERATION_ID);
    });

    it('refuses when the original changed since the preview', async () => {
      restorations.getForOwner.mockResolvedValue(row({ sourceChecksum: Buffer.from('somebody else') }));
      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('refuses when the destination was removed or no longer admits the workload', async () => {
      restorations.getForOwner.mockResolvedValue(row({ destinationId: null }));
      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toBeInstanceOf(BadRequestException);

      restorations.getForOwner.mockResolvedValue(row());
      mocks.mlDestination.getById.mockResolvedValue({ ...mlDestinationStub.lan, enabled: false });
      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toBeInstanceOf(
        MlDestinationRefusedError,
      );
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('refuses anything that is not a ready preview', async () => {
      restorations.getForOwner.mockResolvedValue(row({ status: AssetRestorationStatus.Restored }));
      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancels the job it just queued when another tab decided first', async () => {
      restorations.getForOwner.mockResolvedValue(row());
      restorations.transition.mockResolvedValue(undefined);
      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(operations.requestCancel).toHaveBeenCalledWith(OPERATION_ID, asset.ownerId);
    });
  });

  describe('reject and discard', () => {
    it('records a rejection with a retention date for the preview files', async () => {
      restorations.getForOwner.mockResolvedValue(row());
      const response = await sut.reject(authStub.user1, asset.id, RESTORATION_ID);
      expect(restorations.transition).toHaveBeenCalledWith(
        RESTORATION_ID,
        [AssetRestorationStatus.PreviewReady],
        expect.objectContaining({
          status: AssetRestorationStatus.Rejected,
          reviewedAt: expect.any(Date),
          previewExpiresAt: expect.any(Date),
        }),
      );
      expect(response.status).toBe(AssetRestorationStatus.Rejected);
    });

    it('discard cancels a running job, drops the playback choice and removes every file', async () => {
      restorations.getForOwner.mockResolvedValue(
        row({
          status: AssetRestorationStatus.Restoring,
          fullOperationId: OPERATION_ID,
          isCurrent: true,
          resultPath: '/data/thumbs/result.png',
          resultPreviewPath: '/data/thumbs/result_preview.jpg',
        }),
      );

      await sut.discard(authStub.user1, asset.id, RESTORATION_ID);

      expect(operations.requestCancel).toHaveBeenCalledWith(OPERATION_ID, asset.ownerId);
      expect(restorations.setCurrent).toHaveBeenCalledWith(asset.id, null);
      expect(restorations.update).toHaveBeenCalledWith(
        RESTORATION_ID,
        expect.objectContaining({
          status: AssetRestorationStatus.Discarded,
          resultPath: null,
          previewAfterPath: null,
          isCurrent: false,
        }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: {
          files: [
            '/data/thumbs/before.jpg',
            '/data/thumbs/after.png',
            '/data/thumbs/result.png',
            '/data/thumbs/result_preview.jpg',
          ],
        },
      });
    });
  });

  describe('setCurrent', () => {
    it('only lets a finished result become the playback version, and only by explicit choice', async () => {
      restorations.getForOwner.mockResolvedValue(row({ status: AssetRestorationStatus.PreviewReady }));
      await expect(sut.setCurrent(authStub.user1, asset.id, { restorationId: RESTORATION_ID })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      restorations.getForOwner.mockResolvedValue(
        row({ status: AssetRestorationStatus.Restored, resultPath: '/data/thumbs/result.png' }),
      );
      await sut.setCurrent(authStub.user1, asset.id, { restorationId: RESTORATION_ID });
      expect(restorations.setCurrent).toHaveBeenCalledWith(asset.id, RESTORATION_ID);

      await sut.setCurrent(authStub.user1, asset.id, {});
      expect(restorations.setCurrent).toHaveBeenCalledWith(asset.id, null);
    });
  });

  describe('getFile', () => {
    it('serves the result only once the restoration is finished', async () => {
      restorations.getForOwner.mockResolvedValue(row({ resultPath: '/data/thumbs/result.png' }));
      await expect(
        sut.getFile(authStub.user1, asset.id, RESTORATION_ID, AssetRestorationFileKind.Result),
      ).rejects.toBeInstanceOf(NotFoundException);
      const after = await sut.getFile(authStub.user1, asset.id, RESTORATION_ID, AssetRestorationFileKind.After);
      expect(after.path).toBe('/data/thumbs/after.png');
    });
  });

  describe('asset deletion', () => {
    it('removes the rows and queues the files for deletion', async () => {
      restorations.getFilePaths.mockResolvedValue(['/data/thumbs/before.jpg']);
      await sut.onAssetDelete({ assetId: asset.id, userId: asset.ownerId });
      expect(restorations.deleteByAsset).toHaveBeenCalledWith(asset.id);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/data/thumbs/before.jpg'] },
      });
    });
  });

  describe('parseDurationSeconds', () => {
    it('reads seconds and interval strings, and refuses nonsense', () => {
      expect(parseDurationSeconds(12.5)).toBe(12.5);
      expect(parseDurationSeconds('00:01:30.500')).toBe(90.5);
      expect(parseDurationSeconds('45')).toBe(45);
      expect(parseDurationSeconds(null)).toBeNull();
      expect(parseDurationSeconds('abc')).toBeNull();
      expect(parseDurationSeconds(0)).toBeNull();
    });
  });
  describe('getPlaybackChoice (FL-115)', () => {
    const restored = (overrides: Record<string, unknown> = {}) => ({
      id: RESTORATION_ID,
      isCurrent: true,
      resultPath: '/data/thumbs/result.mp4',
      resultPreviewPath: '/data/thumbs/result-preview.jpg',
      sourceType: 'video',
      ...overrides,
    });

    it('serves the chosen restored video to its owner, revalidated', async () => {
      restorations.listRestoredForPlayback.mockResolvedValue([restored()]);

      const choice = await sut.getPlaybackChoice(authStub.user1, asset.id, 'video');

      expect(restorations.listRestoredForPlayback).toHaveBeenCalledWith(asset.id, authStub.user1.user.id);
      expect(choice.revalidate).toBe(true);
      expect(choice.file).toEqual(
        expect.objectContaining({ path: '/data/thumbs/result.mp4', cacheControl: 'private_without_cache' }),
      );
    });

    it('serves a restored photo as its preview and full-size view, never its thumbnail', async () => {
      restorations.listRestoredForPlayback.mockResolvedValue([
        restored({ sourceType: 'image', resultPath: '/r.png', resultPreviewPath: '/r.jpg' }),
      ]);

      expect((await sut.getPlaybackChoice(authStub.user1, asset.id, 'preview')).file?.path).toBe('/r.jpg');
      expect((await sut.getPlaybackChoice(authStub.user1, asset.id, 'fullsize')).file?.path).toBe('/r.png');
      expect((await sut.getPlaybackChoice(authStub.user1, asset.id, 'video')).file).toBeNull();
    });

    it('keeps the ordinary version, revalidated, while a restoration exists but the original is chosen', async () => {
      restorations.listRestoredForPlayback.mockResolvedValue([restored({ isCurrent: false })]);

      expect(await sut.getPlaybackChoice(authStub.user1, asset.id, 'video')).toEqual({ file: null, revalidate: true });
    });

    it('changes nothing when there is no finished restoration', async () => {
      expect(await sut.getPlaybackChoice(authStub.user1, asset.id, 'video')).toEqual({
        file: null,
        revalidate: false,
      });
    });

    it('never serves the AI version through a shared link', async () => {
      restorations.listRestoredForPlayback.mockResolvedValue([restored()]);

      expect(await sut.getPlaybackChoice(authStub.adminSharedLink, asset.id, 'video')).toEqual({
        file: null,
        revalidate: false,
      });
      expect(restorations.listRestoredForPlayback).not.toHaveBeenCalled();
    });

    it('refuses a session that may not view the asset', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set());

      await expect(sut.getPlaybackChoice(authStub.user1, asset.id, 'video')).rejects.toThrow();
      expect(restorations.listRestoredForPlayback).not.toHaveBeenCalled();
    });
  });
});
