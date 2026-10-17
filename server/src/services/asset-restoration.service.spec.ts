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
import * as cloudDisclosure from 'src/utils/frameleaf-cloud.js';
import { MlDestinationRefusedError } from 'src/utils/ml-destination.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';
// eslint-friendly alias: a mock whose implementation may return anything, promises included.
type AnyMock = Mock<(...args: any[]) => any>;

const RESTORATION_ID = '0195e2a0-0000-7000-8000-000000000010';
const OPERATION_ID = '0195e2a0-0000-7000-8000-000000000020';
const TRX = { isTransaction: true };

describe(AssetRestorationService.name, () => {
  let sut: AssetRestorationService;
  let mocks: ServiceMocks;
  let restorations: { [K in keyof AssetRestorationRepository]: AnyMock };
  let operations: Pick<{ [K in keyof MediaOperationRepository]: AnyMock }, 'create' | 'createWithin' | 'requestCancel'>;
  let recordedOperations: unknown[];

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
    vi.restoreAllMocks();
    mocks = getMocks();
    recordedOperations = [];
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
      clearExpiredPreview: vi.fn(),
      alignWithOperations: vi.fn().mockResolvedValue({ preview: 0, full: 0 }),
      getFilePaths: vi.fn().mockResolvedValue([]),
      deleteByAsset: vi.fn().mockResolvedValue(void 0),
      discard: vi.fn(),
    };
    operations = {
      create: vi.fn().mockImplementation((input) => {
        const created = { ...input, id: OPERATION_ID, status: 'queued' };
        recordedOperations.push(created);
        return Promise.resolve(created);
      }),
      createWithin: vi.fn(async (bind, after) => {
        const before = [...recordedOperations];
        try {
          const { operation, value } = await bind(TRX);
          const created = await operations.create(operation);
          await after(TRX, created, value);
          return { operation: created, value };
        } catch (error) {
          recordedOperations.splice(0, recordedOperations.length, ...before);
          throw error;
        }
      }),
      requestCancel: vi.fn().mockResolvedValue(undefined),
    };

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getById.mockResolvedValue(asset as never);
    // A LAN worker that is allowed to and reports that it serves faithful restoration.
    mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.lan);
    mocks.mlDestination.getAll.mockResolvedValue([
      mlDestinationStub.local,
      mlDestinationStub.lan,
      mlDestinationStub.frameleafCloud,
    ]);
    // No library routes by default; the FL-72 case below sets one.
    mocks.mlDestination.getRoutes.mockResolvedValue([]);
    mocks.mlDestination.getCloudModelChoices.mockResolvedValue([]);
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
      mocks.config as never,
      mocks.systemMetadata as never,
      mocks.notification as never,
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
    it('requires the administrator Cloud model choice through the approved disclosure policy', async () => {
      expect(vi.isMockFunction(cloudDisclosure.hasPendingCloudDisclosure)).toBe(false);
      const video = AssetFactory.from({ ownerId: authStub.user1.user.id, type: AssetType.Video, duration: 30 })
        .exif({ exifImageWidth: 1920, exifImageHeight: 1080, orientation: '1', fileSizeInByte: 50_000_000 })
        .build();
      mocks.asset.getById.mockResolvedValue(video as never);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([video.id]));
      const facts = mlDestinationStub.frameleafCloudConsented.lastProbeCloud!;
      const cloud = { ...mlDestinationStub.frameleafCloudConsented, lastProbeCloud: { ...facts, defaultModels: {} } };
      mocks.mlDestination.getAll.mockResolvedValue([cloud]);
      mocks.mlDestination.getSpend.mockResolvedValue(0);
      const request = { mode: AssetRestorationMode.Creative, upscale: 2 as const };

      const unchosen = await sut.getOptions(authStub.user1, video.id, request);
      expect(unchosen.destinations[0]).toMatchObject({ available: false, refusal: MlAdmissionRefusal.ModelMismatch });

      mocks.mlDestination.getCloudModelChoices.mockResolvedValue([
        { modelGroup: 'restoration-creative', modelId: 'restore-creative', updatedAt: new Date() },
      ]);
      const chosen = await sut.getOptions(authStub.user1, video.id, request);
      expect(chosen.destinations[0]).toMatchObject({ available: true, refusal: null });
      vi.restoreAllMocks();
    });

    it('judges Frameleaf Cloud for a photo as upscaling, the only way it restores photos (FL-162)', async () => {
      const facts = mlDestinationStub.frameleafCloudConsented.lastProbeCloud!;
      mocks.mlDestination.getAll.mockResolvedValue([
        {
          ...mlDestinationStub.frameleafCloudConsented,
          workloads: [...mlDestinationStub.frameleafCloudConsented.workloads, MlWorkload.Upscale],
          lastProbeWorkloads: [...mlDestinationStub.frameleafCloudConsented.lastProbeWorkloads!, MlWorkload.Upscale],
          lastProbeCloud: {
            ...facts,
            modelIds: [...facts.modelIds, 'photo-upscale'],
            modelGroups: { ...facts.modelGroups, 'photo-upscale': 'upscale' },
            defaultModels: { ...facts.defaultModels, upscale: 'photo-upscale' },
          },
        },
      ]);
      mocks.mlDestination.getSpend.mockResolvedValue(0);
      mocks.mlDestination.getCloudModelChoices.mockResolvedValue([
        { modelGroup: 'restoration-faithful', modelId: 'restore-faithful', updatedAt: new Date() },
      ]);

      const options = await sut.getOptions(authStub.user1, asset.id, {
        mode: AssetRestorationMode.Faithful,
        upscale: 2,
      });

      expect(vi.isMockFunction(cloudDisclosure.hasPendingCloudDisclosure)).toBe(false);
      expect(options.destinations[0]).toMatchObject({
        available: true,
        refusal: null,
      });
    });

    it('lists every destination with the admission verdict from the persisted probe and a per-destination estimate', async () => {
      // FL-162 judges a photo on Frameleaf Cloud as upscaling, so the cloud row is allowed that work; the
      // allow-list is checked before consent (evaluateAdmission), and this case is about the missing consent
      const cloudRow = {
        ...mlDestinationStub.frameleafCloud,
        workloads: [...mlDestinationStub.frameleafCloud.workloads, MlWorkload.Upscale],
      };
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, mlDestinationStub.lan, cloudRow]);
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
      const cloud = options.destinations.find((item) => item.id === mlDestinationStub.frameleafCloud.id);
      expect(local).toMatchObject({
        available: false,
        refusal: MlAdmissionRefusal.WorkloadNotAllowed,
        leavesNetwork: false,
      });
      expect(lan).toMatchObject({ available: true, refusal: null, leavesNetwork: false });
      expect(lan?.estimate.fullSeconds).toBe(6);
      expect(lan?.estimate.previewSeconds).not.toBeNull();
      // Without recorded consent the cloud destination is shown as refused, never hidden and never chosen.
      expect(cloud).toMatchObject({
        available: false,
        refusal: MlAdmissionRefusal.ConsentMissing,
        leavesNetwork: true,
        consentGranted: false,
      });
      expect(cloud?.estimate.fullSeconds).toBeNull();
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    });

    it('never offers an endpoint library analysis is routed to (FL-72)', async () => {
      const sameUrl = { ...mlDestinationStub.lan, url: mlDestinationStub.local.url };
      mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local, sameUrl]);
      mocks.mlDestination.getRoutes.mockResolvedValue([
        { workload: MlWorkload.Face, destinationId: mlDestinationStub.local.id, modelId: null, updatedAt: new Date() },
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

  describe('atomic admission', () => {
    let current: AssetRestoration;
    const request = {
      region: DEFAULT_RESTORATION_REGION,
      mode: AssetRestorationMode.Faithful,
      upscale: 2 as const,
      keepGrain: false,
      destinationId: mlDestinationStub.lan.id,
    };
    beforeEach(() => {
      current = row({ status: AssetRestorationStatus.PreviewQueued, previewOperationId: null });
      restorations.create.mockImplementation((input) => Promise.resolve((current = { ...current, ...input })));
      restorations.getForOwner.mockImplementation(() => Promise.resolve({ ...current }));
      restorations.update.mockImplementation((_id, patch) => Promise.resolve((current = { ...current, ...patch })));
      restorations.transition.mockImplementation((_id, from, patch, _tx, operation) => {
        if (
          !from.includes(current.status) ||
          (operation &&
            current[operation.stage === 'preview' ? 'previewOperationId' : 'fullOperationId'] !== operation.id)
        )
          return Promise.resolve();
        return Promise.resolve((current = { ...current, ...patch }));
      });
    });

    it('keeps failed preview history without a runnable operation when its link write fails', async () => {
      restorations.update.mockRejectedValueOnce(new Error('preview link failed'));
      const transition = restorations.transition.getMockImplementation()!;
      restorations.transition.mockImplementation((...args) =>
        args[2].previewOperationId ? Promise.reject(new Error('preview link failed')) : transition(...args),
      );

      await expect(sut.requestPreview(authStub.user1, asset.id, request)).rejects.toThrow('preview link failed');

      expect(recordedOperations).toEqual([]);
      expect(current).toMatchObject({ status: AssetRestorationStatus.PreviewFailed, previewOperationId: null });
    });

    it('rolls back full-render work when accepting its restoration fails', async () => {
      current.status = AssetRestorationStatus.PreviewReady;
      restorations.transition.mockRejectedValueOnce(new Error('acceptance write failed'));

      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toThrow('acceptance write failed');

      expect(recordedOperations).toEqual([]);
      expect(current.status).toBe(AssetRestorationStatus.PreviewReady);
    });

    it('leaves no queued full render after another tab decided first', async () => {
      current.status = AssetRestorationStatus.PreviewReady;
      restorations.transition.mockResolvedValueOnce(undefined);

      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toBeInstanceOf(ConflictException);

      expect(recordedOperations).toEqual([]);
      expect(operations.requestCancel).not.toHaveBeenCalled();
    });

    it('preserves a discarded preview if its owner decides before binding', async () => {
      const create = operations.create.getMockImplementation()!;
      operations.create.mockImplementationOnce((...args) => {
        current.status = AssetRestorationStatus.Discarded;
        return create(...args);
      });

      await expect(sut.requestPreview(authStub.user1, asset.id, request)).rejects.toBeInstanceOf(ConflictException);

      expect(recordedOperations).toEqual([]);
      expect(current).toMatchObject({ status: AssetRestorationStatus.Discarded, previewOperationId: null });
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

    it('refuses restoration on a worker also allowed library analysis up front and creates nothing (FL-72)', async () => {
      const legacyPod = { ...mlDestinationStub.lan, workloads: [MlWorkload.Face, MlWorkload.RestorationFaithful] };
      mocks.mlDestination.getById.mockResolvedValue(legacyPod);

      const error = await sut
        .requestPreview(authStub.user1, asset.id, { ...request, destinationId: legacyPod.id })
        .catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MlDestinationRefusedError);
      expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.RoleConflict);
      expect(restorations.create).not.toHaveBeenCalled();
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    });

    it('never sends anything to Frameleaf Cloud from here: cloud work is estimated and confirmed first (FL-162)', async () => {
      for (const destination of [mlDestinationStub.frameleafCloud, mlDestinationStub.frameleafCloudConsented]) {
        mocks.mlDestination.getById.mockResolvedValue(destination);

        await expect(
          sut.requestPreview(authStub.user1, asset.id, { ...request, destinationId: destination.id }),
        ).rejects.toThrow('Frameleaf Cloud work is estimated and confirmed first');
      }
      expect(restorations.create).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
      expect(mocks.machineLearning.probe).not.toHaveBeenCalled();
    });

    describe('local Smooth motion (FL-162)', () => {
      const video = AssetFactory.from({ ownerId: authStub.user1.user.id, type: AssetType.Video, duration: 12_000 })
        .exif({ exifImageWidth: 1920, exifImageHeight: 1080, orientation: '1', fileSizeInByte: 40_000_000 })
        .build();
      const smooth = {
        ...request,
        mode: AssetRestorationMode.SmoothMotion,
        upscale: 1 as const,
        smoothMotionFactor: 4 as const,
      };

      beforeEach(() => {
        mocks.access.asset.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(new Set(ids)));
        mocks.asset.getById.mockResolvedValue(video as never);
        mocks.mlDestination.getById.mockResolvedValue({
          ...mlDestinationStub.lan,
          workloads: [MlWorkload.Interpolation],
        });
        mocks.machineLearning.probe.mockResolvedValue({
          ...mlProbeStub.healthy,
          workloads: [MlWorkload.Interpolation],
        });
      });

      it('queues an interpolation preview on the named home worker, keeping the size and the original', async () => {
        await sut.requestPreview(authStub.user1, video.id, smooth);

        expect(restorations.create).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: AssetRestorationMode.SmoothMotion,
            workload: MlWorkload.Interpolation,
            // the factor is kept where a restoration keeps its upscale
            upscale: 4,
            destinationKind: MlDestinationKind.Lan,
          }),
        );
        expect(operations.create).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: MediaOperationKind.RestorationPreview,
            snapshot: expect.objectContaining({
              mode: AssetRestorationMode.SmoothMotion,
              upscale: 1,
              interpolationFactor: 4,
              output: expect.objectContaining({ width: 1920, height: 1080 }),
            }),
          }),
        );
      });

      it('never sends it to Frameleaf Cloud from here, and refuses a photo', async () => {
        mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);
        await expect(sut.requestPreview(authStub.user1, video.id, smooth)).rejects.toThrow(
          'Frameleaf Cloud work is estimated and confirmed first',
        );
        mocks.mlDestination.getById.mockResolvedValue({
          ...mlDestinationStub.lan,
          workloads: [MlWorkload.Interpolation],
        });
        mocks.asset.getById.mockResolvedValue(asset as never);
        await expect(sut.requestPreview(authStub.user1, asset.id, smooth)).rejects.toThrow(
          'Smooth motion needs a video',
        );
        expect(restorations.create).not.toHaveBeenCalled();
      });

      describe('after a Studio export (FL-162)', () => {
        beforeEach(() => {
          mocks.notification.create.mockResolvedValue({} as never);
        });

        const request = {
          ownerId: authStub.user1.user.id,
          assetId: video.id,
          exportName: 'Lake trip',
          factor: 2 as const,
          destinationId: mlDestinationStub.lan.id,
        };

        it('queues a Smooth motion preview of the exported video on the home worker and says so', async () => {
          await expect(sut.queueExportSmoothMotion(request)).resolves.toBeTruthy();

          expect(restorations.create).toHaveBeenCalledWith(
            expect.objectContaining({
              assetId: video.id,
              mode: AssetRestorationMode.SmoothMotion,
              upscale: 2,
              provenance: { requestedBy: authStub.user1.user.id, sessionElevated: false },
            }),
          );
          expect(mocks.notification.create).toHaveBeenCalledWith(
            expect.objectContaining({ userId: authStub.user1.user.id, title: 'Smooth motion preview queued' }),
          );
        });

        it('never sends it to Frameleaf Cloud: the owner confirms that job separately', async () => {
          mocks.mlDestination.getById.mockResolvedValue(mlDestinationStub.frameleafCloudConsented);

          await expect(
            sut.queueExportSmoothMotion({ ...request, destinationId: mlDestinationStub.frameleafCloudConsented.id }),
          ).resolves.toBeNull();

          expect(restorations.create).not.toHaveBeenCalled();
          expect(operations.create).not.toHaveBeenCalled();
          expect(mocks.notification.create).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Confirm Smooth motion on Frameleaf Cloud' }),
          );
        });

        it('tells the owner when it cannot start, and leaves the export alone', async () => {
          mocks.systemMetadata.get.mockResolvedValue({
            frameleafCloud: { cloudMl: { routing: { interpolation: 'cloud' } } },
          } as never);

          await expect(sut.queueExportSmoothMotion(request)).resolves.toBeNull();

          expect(restorations.create).not.toHaveBeenCalled();
          expect(mocks.notification.create).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Smooth motion did not start' }),
          );
        });
      });

      it('follows Where each job runs: Cloud only refuses this server and the home network', async () => {
        mocks.systemMetadata.get.mockResolvedValue({
          frameleafCloud: { cloudMl: { routing: { interpolation: 'cloud' } } },
        } as never);
        const error = await sut.requestPreview(authStub.user1, video.id, smooth).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(MlDestinationRefusedError);
        expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.WorkloadNotAllowed);
        expect(restorations.create).not.toHaveBeenCalled();

        const options = await sut.getOptions(authStub.user1, video.id, { mode: AssetRestorationMode.SmoothMotion });
        expect(options.upscale).toBe(1);
        expect(options.route).toBe('cloud');
        expect(options.outputWidth).toBe(1920);
        expect(options.destinations.find((item) => item.kind === MlDestinationKind.Lan)).toMatchObject({
          available: false,
          refusal: MlAdmissionRefusal.WorkloadNotAllowed,
        });
      });
    });

    it('creates the next revision and a preview job bound to the named destination', async () => {
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
      expect(operations.createWithin).toHaveBeenCalledTimes(1);
      expect(restorations.transition).toHaveBeenCalledWith(
        RESTORATION_ID,
        [AssetRestorationStatus.PreviewQueued],
        { status: AssetRestorationStatus.PreviewQueued, previewOperationId: OPERATION_ID },
        TRX,
        { stage: 'preview', id: null },
      );
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
      expect(restorations.transition).toHaveBeenCalledWith(
        RESTORATION_ID,
        [AssetRestorationStatus.PreviewQueued],
        expect.objectContaining({ status: AssetRestorationStatus.PreviewFailed, error: 'database gone' }),
        undefined,
        { stage: 'preview', id: null },
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
        TRX,
      );
      expect(operations.createWithin).toHaveBeenCalledTimes(1);
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

    it('rolls back the new job when another tab decided first', async () => {
      restorations.getForOwner.mockResolvedValue(row());
      restorations.transition.mockResolvedValue(undefined);
      await expect(sut.accept(authStub.user1, asset.id, RESTORATION_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(recordedOperations).toEqual([]);
      expect(operations.requestCancel).not.toHaveBeenCalled();
    });
  });

  describe('reject and discard', () => {
    it('deletes newly published files when discard raced publication', async () => {
      restorations.getForOwner.mockResolvedValue(
        row({ status: AssetRestorationStatus.Restoring, fullOperationId: OPERATION_ID }),
      );
      restorations.discard.mockResolvedValue(
        row({
          status: AssetRestorationStatus.Restored,
          resultPath: '/latest-result.png',
          resultPreviewPath: '/latest-preview.jpg',
        }),
      );

      await sut.discard(authStub.user1, asset.id, RESTORATION_ID);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: expect.arrayContaining(['/latest-result.png', '/latest-preview.jpg']) },
      });
    });

    it('cancels a newer operation admitted before discard commits', async () => {
      restorations.getForOwner.mockResolvedValue(
        row({ status: AssetRestorationStatus.Restoring, fullOperationId: OPERATION_ID }),
      );
      restorations.discard.mockResolvedValue(
        row({ status: AssetRestorationStatus.Restoring, fullOperationId: 'new-operation' }),
      );

      await sut.discard(authStub.user1, asset.id, RESTORATION_ID);

      expect(operations.requestCancel).toHaveBeenCalledWith(OPERATION_ID, asset.ownerId);
      expect(operations.requestCancel).toHaveBeenCalledWith('new-operation', asset.ownerId);
    });

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
      const discarded = row({
        status: AssetRestorationStatus.Restoring,
        fullOperationId: OPERATION_ID,
        isCurrent: true,
        resultPath: '/data/thumbs/result.png',
        resultPreviewPath: '/data/thumbs/result_preview.jpg',
      });
      restorations.getForOwner.mockResolvedValue(discarded);
      restorations.discard.mockResolvedValue(discarded);

      await sut.discard(authStub.user1, asset.id, RESTORATION_ID);

      expect(operations.requestCancel).toHaveBeenCalledWith(OPERATION_ID, asset.ownerId);
      expect(restorations.discard).toHaveBeenCalledWith(RESTORATION_ID);
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

    it('serves the restored preview for a full-size view when full-size files may not be sent (FL-161)', async () => {
      restorations.listRestoredForPlayback.mockResolvedValue([
        restored({ sourceType: 'image', resultPath: '/r.png', resultPreviewPath: '/r.jpg' }),
      ]);

      expect((await sut.getPlaybackChoice(authStub.user1, asset.id, 'fullsize', false)).file?.path).toBe('/r.jpg');
      expect((await sut.getPlaybackChoice(authStub.user1, asset.id, 'fullsize', true)).file?.path).toBe('/r.png');
      expect((await sut.getPlaybackChoice(authStub.user1, asset.id, 'preview', false)).file?.path).toBe('/r.jpg');
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

      await expect(sut.getPlaybackChoice(authStub.user1, asset.id, 'video')).rejects.toThrow();
      expect(restorations.listRestoredForPlayback).not.toHaveBeenCalled();
    });
  });
});
