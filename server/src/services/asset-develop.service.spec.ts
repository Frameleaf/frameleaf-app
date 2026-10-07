import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Mock } from 'vitest';
import {
  AssetDevelopArtifactKind,
  AssetDevelopFileKind,
  AssetDevelopMaskKind,
  AssetDevelopPreset,
  AssetDevelopRevisionKind,
  AssetDevelopRevisionStatus,
} from 'src/dtos/asset-develop.dto.js';
import { AssetType, AssetVisibility, ChecksumAlgorithm, JobName, JobStatus } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { QueueExecution } from 'src/queue/types.js';
import { AssetDevelopRepository, type AssetDevelopRevision } from 'src/repositories/asset-develop.repository.js';
import { type DevelopExport, PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import {
  AssetDevelopService,
  DEVELOP_RENDER_LEASE_MS,
  developArtifactPath,
} from 'src/services/asset-develop.service.js';
import {
  DARKTABLE_RENDERER_VERSION,
  encodeNativeDevelopOutput,
  renderDarktable,
} from 'src/utils/darktable-renderer.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

vi.mock('src/utils/darktable-renderer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/darktable-renderer.js')>()),
  renderDarktable: vi.fn(),
  encodeNativeDevelopOutput: vi.fn().mockResolvedValue(Buffer.from('jpeg')),
}));

const noAdjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  dehaze: 0,
};

const revisionStub = (overrides: Partial<AssetDevelopRevision> = {}): AssetDevelopRevision => ({
  id: 'a7c3d0aa-8a9f-4a3a-9a80-1f1a2b3c4d5e',
  assetId: 'asset-id',
  ownerId: authStub.user1.user.id,
  revision: 1,
  recipeVersion: 1,
  recipe: defaultDevelopRecipe(),
  label: null,
  status: AssetDevelopRevisionStatus.Saved,
  progress: 0,
  cancelRequested: false,
  error: null,
  rendererVersion: null,
  masterPath: null,
  previewPath: null,
  width: null,
  height: null,
  isCurrent: false,
  kind: AssetDevelopRevisionKind.Recipe,
  sourceChecksum: null,
  renditionChecksum: null,
  exportId: null,
  fileName: null,
  software: null,
  attempts: 0,
  createdAt: new Date('2026-09-22T10:00:00Z'),
  updatedAt: new Date('2026-09-22T10:00:00Z'),
  renderedAt: null,
  ...overrides,
});

describe(AssetDevelopService.name, () => {
  let sut: AssetDevelopService;
  let mocks: ServiceMocks;
  let developRepository: {
    [K in keyof AssetDevelopRepository]: Mock<(...args: any[]) => any>;
  };
  let photoTools: {
    [K in keyof PhotoToolsRepository]: Mock<(...args: any[]) => any>;
  };
  /** SHA-256 of the stub original as the service computes it. */
  const originalSha = Buffer.alloc(32, 7);
  const renditionSha = Buffer.alloc(32, 9);

  const asset = AssetFactory.from({ ownerId: authStub.user1.user.id, type: AssetType.Image })
    .exif({ orientation: null, colorspace: 'sRGB' })
    .build();

  beforeEach(() => {
    mocks = getMocks();
    mocks.mediaOperation.create.mockResolvedValue({ id: 'op-1' } as never);
    developRepository = {
      getAssetIdsWithHistory: vi.fn().mockResolvedValue(new Set()),
      listByAsset: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      getCurrent: vi.fn(),
      create: vi.fn(),
      update: vi
        .fn()
        .mockImplementation((id: string, patch: Partial<AssetDevelopRevision>) =>
          Promise.resolve(revisionStub({ id, ...patch })),
        ),
      setCurrent: vi.fn().mockResolvedValue(void 0),
      requestCancel: vi.fn().mockResolvedValue(void 0),
      isCancelRequested: vi.fn().mockResolvedValue(false),
      releaseRemovedAssetRevisions: vi.fn().mockResolvedValue([]),
      listUnfinished: vi.fn().mockResolvedValue([]),
      getArtifacts: vi.fn().mockResolvedValue([]),
      addArtifact: vi.fn().mockResolvedValue(true),
      releaseArtifacts: vi.fn().mockResolvedValue([]),
      syncUsage: vi.fn().mockResolvedValue(true),
      beginAttempt: vi.fn().mockImplementation((id: string) =>
        developRepository.get(id).then((row: AssetDevelopRevision) => ({
          ...row,
          status: AssetDevelopRevisionStatus.Rendering,
          attempts: (row?.attempts ?? 0) + 1,
        })),
      ),
    };
    photoTools = {
      listPresets: vi.fn(),
      countPresets: vi.fn(),
      getPreset: vi.fn(),
      getPresetByName: vi.fn(),
      createPreset: vi.fn(),
      updatePreset: vi.fn(),
      deletePreset: vi.fn(),
      createExport: vi.fn(),
      listExports: vi.fn().mockResolvedValue([]),
      getExport: vi.fn(),
    };
    mocks.crypto.hashFile.mockImplementation((file: string | Buffer) =>
      Promise.resolve(
        String(file).includes('develop-imports') || String(file).includes('_import_') ? renditionSha : originalSha,
      ),
    );
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
    mocks.asset.getById.mockResolvedValue(asset as never);
    mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
    mocks.media.decodeImage.mockResolvedValue({
      data: Buffer.alloc(4 * 4 * 3, 128),
      info: { width: 4, height: 4, channels: 3 },
    } as never);

    sut = new AssetDevelopService(
      mocks.logger as never,
      mocks.access as never,
      mocks.asset as never,
      mocks.assetJob as never,
      developRepository as unknown as AssetDevelopRepository,
      mocks.config as never,
      mocks.crypto as never,
      mocks.job as never,
      mocks.media as never,
      photoTools as unknown as PhotoToolsRepository,
      mocks.storage as never,
      mocks.systemMetadata as never,
      mocks.mediaOperation as never,
      mocks.machineLearning as never,
    );
    mocks.media.getImageMetadata.mockResolvedValue({ width: 4, height: 4, isTransparent: false });
    vi.mocked(encodeNativeDevelopOutput).mockReset().mockResolvedValue(Buffer.from('jpeg'));
    mocks.mediaOperation.getTrackedRevisionIds.mockResolvedValue(new Set());
    mocks.mediaOperation.listActiveEditsOfRevision.mockResolvedValue([]);
  });

  it('preserves raw recipe through save and readback rather than projecting the renderer (FL-233)', async () => {
    const recipe = { ...defaultDevelopRecipe(), future: { operations: [{ method: 'remove', fill: 'opaque' }] } };
    developRepository.create.mockImplementation((input) => Promise.resolve(revisionStub({ recipe: input.recipe })));
    const saved = await sut.save(authStub.user1, asset.id, { recipe, render: false });
    expect(saved.recipe).toEqual(recipe);
    expect(developRepository.create.mock.calls[0][0].recipe).toEqual(recipe);
    developRepository.listByAsset.mockResolvedValue([revisionStub({ recipe })]);
    expect((await sut.get(authStub.user1, asset.id)).revisions[0].recipe).toEqual(recipe);
  });

  it.each([
    { version: 2, future: { operation: 'remove' } },
    { ...defaultDevelopRecipe(), future: { operation: 'remove' } },
  ])('refuses unsupported immediate save render and preview without touching media: %j', async (recipe) => {
    await expect(sut.save(authStub.user1, asset.id, { recipe, render: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(developRepository.create).not.toHaveBeenCalled();
    await expect(sut.preview(authStub.user1, asset.id, { recipe, size: 256 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(mocks.media.decodeImage).not.toHaveBeenCalled();
  });

  it('returns a machine-readable unsupported render refusal before the first save mutation', async () => {
    const error = await sut
      .save(authStub.user1, asset.id, { recipe: { version: 2 }, render: true })
      .catch((error: BadRequestException) => error);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'develop_renderer_unsupported' });
    expect(developRepository.create).not.toHaveBeenCalled();
    expect(developRepository.setCurrent).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  it('refuses explicitly queueing an unsupported saved revision', async () => {
    developRepository.get.mockResolvedValue(revisionStub({ assetId: asset.id, recipe: { version: 2 } }));
    await expect(sut.render(authStub.user1, asset.id, 'revision')).rejects.toBeInstanceOf(BadRequestException);
    expect(developRepository.update).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  it.each([AssetDevelopRevisionStatus.Queued, AssetDevelopRevisionStatus.Rendering])(
    'refuses unsupported explicit render even when already %s',
    async (status) => {
      developRepository.get.mockResolvedValue(revisionStub({ assetId: asset.id, recipe: { version: 2 }, status }));
      await expect(sut.render(authStub.user1, asset.id, 'revision')).rejects.toBeInstanceOf(BadRequestException);
      expect(developRepository.update).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    },
  );

  it('does not requeue unsupported untracked revisions at bootstrap', async () => {
    developRepository.listUnfinished.mockResolvedValue([
      revisionStub({ recipe: { version: 2 }, status: AssetDevelopRevisionStatus.Queued }),
    ]);
    await sut.onBootstrap();
    expect(mocks.job.queueAll).not.toHaveBeenCalled();
    expect(developRepository.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: AssetDevelopRevisionStatus.Failed }),
    );
  });

  describe('develop artifacts (FL-233)', () => {
    const artifact = 'c'.repeat(64);
    const staged = { path: '/upload/exports/develop-imports/staged.partial', size: 1024, originalname: 'mask.png' };
    const stored = (kind: 'mask' | 'fill' = 'mask') => ({
      assetId: asset.id,
      id: artifact,
      ownerId: asset.ownerId,
      kind,
      path: developArtifactPath(asset, artifact),
      bytes: 3,
      width: 400,
      height: 300,
      createdAt: new Date(),
    });
    const subject = {
      ...defaultDevelopRecipe(),
      masks: [
        {
          id: 's',
          kind: AssetDevelopMaskKind.Subject,
          x: 0.5,
          y: 0.5,
          artifact,
          adjustments: { ...noAdjustments, exposure: 1 },
        },
      ],
    };

    beforeEach(() => {
      mocks.media.getImageMetadata.mockResolvedValue({ width: 400, height: 300, isTransparent: false });
      mocks.media.normalizeDevelopArtifact.mockResolvedValue({ data: Buffer.from('png'), width: 400, height: 300 });
      mocks.crypto.hashSha256.mockReturnValue(Buffer.from(artifact, 'hex'));
      mocks.storage.createFile.mockResolvedValue(void 0);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.asset.getById.mockResolvedValue({
        ...asset,
        exifInfo: { ...asset.exifInfo, exifImageWidth: 4000, exifImageHeight: 3000 },
      } as never);
    });

    it('stores a normalized bitmap beside the versions, records it, and discards the upload', async () => {
      await expect(
        sut.uploadArtifact(authStub.user1, asset.id, { kind: AssetDevelopArtifactKind.Mask }, staged),
      ).resolves.toEqual({ id: artifact, kind: AssetDevelopArtifactKind.Mask, width: 400, height: 300 });
      expect(mocks.media.normalizeDevelopArtifact).toHaveBeenCalledWith(staged.path, AssetDevelopArtifactKind.Mask);
      const [target, bytes] = mocks.storage.createFile.mock.calls[0];
      expect(target).toBe(developArtifactPath(asset, artifact));
      expect(target).toContain(`${asset.id}_develop_artifact_${artifact}.png`);
      expect(bytes).toEqual(Buffer.from('png'));
      expect(developRepository.addArtifact).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: asset.id, id: artifact, kind: 'mask', path: target, bytes: 3 }),
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(staged.path);

      // a file deleted by an earlier release just before it was recorded again is written again
      mocks.storage.checkFileExists.mockResolvedValueOnce(false);
      await sut.uploadArtifact(authStub.user1, asset.id, { kind: AssetDevelopArtifactKind.Mask }, staged);
      expect(mocks.storage.createFile).toHaveBeenCalledTimes(3);
      mocks.storage.createFile.mockClear();

      // the same bitmap again returns the stored one, records it again (restarting its grace
      // period) and skips the limits, without writing the file that is still there
      developRepository.getArtifacts.mockResolvedValue([stored()]);
      developRepository.addArtifact.mockClear();
      await expect(
        sut.uploadArtifact(authStub.user1, asset.id, { kind: AssetDevelopArtifactKind.Mask }, staged),
      ).resolves.toEqual({ id: artifact, kind: AssetDevelopArtifactKind.Mask, width: 400, height: 300 });
      expect(developRepository.addArtifact).toHaveBeenCalledWith(expect.objectContaining({ id: artifact }));
      expect(mocks.storage.createFile).not.toHaveBeenCalled();

      // ... and writes it again if a release took the file after it was found
      mocks.storage.checkFileExists.mockResolvedValueOnce(false);
      await sut.uploadArtifact(authStub.user1, asset.id, { kind: AssetDevelopArtifactKind.Mask }, staged);
      expect(mocks.storage.createFile).toHaveBeenCalledWith(developArtifactPath(asset, artifact), Buffer.from('png'));
    });

    it('refuses someone else’s photo, an unreadable or oversized bitmap, and keeps nothing', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(
        sut.uploadArtifact(authStub.user1, asset.id, { kind: AssetDevelopArtifactKind.Fill }, staged),
      ).rejects.toBeInstanceOf(BadRequestException);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.media.getImageMetadata.mockResolvedValue({ width: 5000, height: 10, isTransparent: false });
      await expect(
        sut.uploadArtifact(authStub.user1, asset.id, { kind: AssetDevelopArtifactKind.Fill }, staged),
      ).rejects.toThrow('at most 4096 pixels');
      // a mask is never larger than the original
      mocks.asset.getById.mockResolvedValue({
        ...asset,
        exifInfo: { ...asset.exifInfo, exifImageWidth: 300, exifImageHeight: 200 },
      } as never);
      mocks.media.getImageMetadata.mockResolvedValue({ width: 400, height: 300, isTransparent: false });
      await expect(
        sut.uploadArtifact(authStub.user1, asset.id, { kind: AssetDevelopArtifactKind.Mask }, staged),
      ).rejects.toThrow('no larger than the original');
      expect(mocks.storage.createFile).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(3);
    });

    it('removes the file of an upload the recording refused (FL-304: the photo’s limit, the owner’s quota)', async () => {
      // the limit and the quota are decided where the row is inserted; the service keeps no file
      // for a refused upload
      const refusal = new BadRequestException({ message: 'Your storage is full', code: 'develop_artifact_quota' });
      developRepository.addArtifact.mockRejectedValue(refusal);
      await expect(
        sut.uploadArtifact(authStub.user1, asset.id, { kind: AssetDevelopArtifactKind.Mask }, staged),
      ).rejects.toBe(refusal);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [developArtifactPath(asset, artifact)] },
      });
      expect(mocks.storage.unlink).toHaveBeenCalledWith(staged.path);

      // the same bitmap again, already recorded, queues nothing whatever happens
      mocks.job.queue.mockClear();
      developRepository.getArtifacts.mockResolvedValue([stored()]);
      await expect(
        sut.uploadArtifact(authStub.user1, asset.id, { kind: AssetDevelopArtifactKind.Mask }, staged),
      ).rejects.toBe(refusal);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('refuses to render a recipe whose artifact this photo does not have, before saving', async () => {
      const error = await sut
        .save(authStub.user1, asset.id, { recipe: subject, render: true })
        .catch((error: BadRequestException) => error);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'develop_artifact_missing' });
      expect(developRepository.create).not.toHaveBeenCalled();

      // saved without rendering it is kept, and renders once the artifact is uploaded
      developRepository.create.mockResolvedValue(revisionStub({ assetId: asset.id, recipe: subject }));
      await expect(sut.save(authStub.user1, asset.id, { recipe: subject, render: false })).resolves.toBeDefined();
      // a fill never stands in for a mask bitmap
      developRepository.getArtifacts.mockResolvedValue([stored('fill')]);
      await expect(sut.save(authStub.user1, asset.id, { recipe: subject, render: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      developRepository.getArtifacts.mockResolvedValue([stored()]);
      await sut.save(authStub.user1, asset.id, { recipe: subject, render: true });
      expect(mocks.job.queue).toHaveBeenCalledWith(expect.objectContaining({ name: JobName.AssetDevelopRender }));
    });

    it('requires only the artifacts a render reads: a disabled mask or Clean Up keeps its reference', async () => {
      developRepository.create.mockResolvedValue(revisionStub({ assetId: asset.id }));
      const recipe = {
        ...subject,
        masks: [{ ...subject.masks[0], enabled: false }],
        cleanup: [
          { id: 'x', method: 'remove', enabled: false, region: { x: 0, y: 0, w: 0.5, h: 0.5 }, fill: 'e'.repeat(64) },
        ],
      };
      await expect(sut.save(authStub.user1, asset.id, { recipe, render: true })).resolves.toBeDefined();
      expect(developRepository.getArtifacts).toHaveBeenCalledWith(asset.id, []);
    });

    it('renders brilliance, a bitmap mask and Clean Up in the preview from the stored artifacts', async () => {
      developRepository.getArtifacts.mockImplementation((_assetId: string, ids: string[]) =>
        Promise.resolve(ids.map(() => stored())),
      );
      const fillId = 'd'.repeat(64);
      developRepository.getArtifacts.mockImplementation((_assetId: string, ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ ...stored(id === fillId ? 'fill' : 'mask'), id }))),
      );
      mocks.media.decodeDevelopArtifact.mockImplementation((_file: string, kind: 'mask' | 'fill') =>
        Promise.resolve(
          kind === 'mask'
            ? { data: Buffer.alloc(4, 255), width: 2, height: 2, channels: 1 }
            : { data: Buffer.from([0, 0, 0, 255]), width: 1, height: 1, channels: 4 },
        ),
      );
      const recipe = {
        ...subject,
        brilliance: 30,
        cleanup: [{ id: 'x', method: 'remove', region: { x: 0, y: 0, w: 0.5, h: 0.5 }, fill: fillId }],
      };
      await sut.preview(authStub.user1, asset.id, { recipe, size: 256 });
      expect(mocks.media.decodeDevelopArtifact).toHaveBeenCalledWith(developArtifactPath(asset, artifact), 'fill');
      expect(mocks.media.decodeDevelopArtifact).toHaveBeenCalledWith(developArtifactPath(asset, artifact), 'mask');
      const [pixels] = mocks.media.encodeDevelopOutput.mock.calls[0];
      // the removed top-left quarter took the black fill; the rest was brightened by the subject mask
      expect(pixels[0]).toBeLessThan(40);
      expect(pixels.at(-1)).toBeGreaterThan(128);

      // a mask artifact never stands in for a fill
      developRepository.getArtifacts.mockImplementation((_assetId: string, ids: string[]) =>
        Promise.resolve(ids.map((id) => ({ ...stored('mask'), id }))),
      );
      await expect(sut.preview(authStub.user1, asset.id, { recipe, size: 256 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('releases the photo’s artifacts when it is deleted, and unused ones nightly', async () => {
      await sut.onAssetDelete({ assetId: asset.id, userId: asset.ownerId });
      expect(developRepository.releaseArtifacts).toHaveBeenCalledWith(expect.any(Function), { assetId: asset.id });
      await sut.onNightlyDatabaseCleanup();
      const [, options] = developRepository.releaseArtifacts.mock.calls[1];
      expect(options.unreferencedBefore.getTime()).toBeLessThan(Date.now() - 6 * 24 * 60 * 60 * 1000);
    });
  });

  describe('access', () => {
    it('refuses every operation on an asset the user cannot edit', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.get(authStub.user1, asset.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.save(authStub.user1, asset.id, { recipe: defaultDevelopRecipe(), render: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.revert(authStub.user1, asset.id, {})).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.preview(authStub.user1, asset.id, { recipe: defaultDevelopRecipe(), size: 512 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(developRepository.create).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('save', () => {
    it('saves and queues an explicit version 2 native recipe (FL-233 artifact checks are for version 1)', async () => {
      const recipe = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 1 };
      const created = revisionStub({ assetId: asset.id, recipe, status: AssetDevelopRevisionStatus.Saved });
      developRepository.create.mockResolvedValue(created);
      await expect(sut.save(authStub.user1, asset.id, { recipe, render: true })).resolves.toMatchObject({
        status: AssetDevelopRevisionStatus.Queued,
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetDevelopRender,
        data: { id: created.id, operationId: 'op-1' },
      });

      developRepository.get.mockResolvedValue(created);
      await expect(sut.render(authStub.user1, asset.id, created.id)).resolves.toBeDefined();
      expect(developRepository.getArtifacts).toHaveBeenCalledWith(asset.id, []);
    });

    it('stores a valid recipe as the next revision and queues the render', async () => {
      const created = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Saved });
      developRepository.create.mockResolvedValue(created);

      const response = await sut.save(authStub.user1, asset.id, {
        recipe: { ...defaultDevelopRecipe(), exposure: 2, preset: AssetDevelopPreset.Warm },
        label: 'Warm sunset',
        render: true,
      });

      expect(developRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: asset.id,
          ownerId: asset.ownerId,
          label: 'Warm sunset',
          recipe: expect.objectContaining({ exposure: 2, preset: AssetDevelopPreset.Warm }),
        }),
      );
      expect(developRepository.update).toHaveBeenCalledWith(created.id, {
        status: AssetDevelopRevisionStatus.Queued,
        progress: 0,
        error: null,
        cancelRequested: false,
        attempts: 0,
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetDevelopRender,
        data: { id: created.id, operationId: 'op-1' },
      });
      expect(response.status).toBe(AssetDevelopRevisionStatus.Queued);
      expect(response.hasMaster).toBe(false);
    });

    it('can store a recipe without rendering', async () => {
      developRepository.create.mockResolvedValue(revisionStub({ assetId: asset.id }));
      const response = await sut.save(authStub.user1, asset.id, { recipe: defaultDevelopRecipe(), render: false });
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(response.status).toBe(AssetDevelopRevisionStatus.Saved);
    });

    it('refuses videos and offline originals', async () => {
      const video = AssetFactory.from({ ownerId: asset.ownerId, type: AssetType.Video }).build();
      mocks.asset.getById.mockResolvedValue(video as never);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([video.id]));
      await expect(
        sut.save(authStub.user1, video.id, { recipe: defaultDevelopRecipe(), render: true }),
      ).rejects.toBeInstanceOf(BadRequestException);

      mocks.asset.getById.mockResolvedValue({ ...asset, isOffline: true } as never);
      await expect(
        sut.save(authStub.user1, asset.id, { recipe: defaultDevelopRecipe(), render: true }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(developRepository.create).not.toHaveBeenCalled();
    });
  });

  it('saves a Live Photo still revision without altering its motion link', async () => {
    const pair = { ...asset, livePhotoVideoId: 'original-motion' };
    mocks.asset.getById.mockResolvedValue(pair as never);
    developRepository.create.mockResolvedValue(revisionStub({ assetId: asset.id }));
    await sut.save(authStub.user1, asset.id, { recipe: defaultDevelopRecipe(), render: false });
    expect(developRepository.create).toHaveBeenCalledWith(expect.objectContaining({ assetId: asset.id }));
    expect(pair.livePhotoVideoId).toBe('original-motion');
    expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalled();
  });

  describe('cancel', () => {
    it('finishes a queued revision immediately so the worker skips it', async () => {
      const queued = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(queued);
      const response = await sut.cancel(authStub.user1, asset.id, queued.id);
      expect(developRepository.update).toHaveBeenCalledWith(queued.id, {
        status: AssetDevelopRevisionStatus.Cancelled,
        cancelRequested: true,
        progress: 0,
      });
      expect(response.status).toBe(AssetDevelopRevisionStatus.Cancelled);
    });

    it('only flags a running render, leaving the worker to stop it', async () => {
      const rendering = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Rendering, progress: 40 });
      developRepository.get.mockResolvedValue(rendering);
      const response = await sut.cancel(authStub.user1, asset.id, rendering.id);
      expect(developRepository.requestCancel).toHaveBeenCalledWith(rendering.id);
      expect(developRepository.update).not.toHaveBeenCalled();
      expect(response.status).toBe(AssetDevelopRevisionStatus.Rendering);
    });

    it('rejects a revision that belongs to another asset', async () => {
      developRepository.get.mockResolvedValue(revisionStub({ assetId: 'someone-elses-asset' }));
      await expect(sut.cancel(authStub.user1, asset.id, 'rev')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('revert', () => {
    it('makes the original current when no revision is named', async () => {
      await sut.revert(authStub.user1, asset.id, {});
      expect(developRepository.setCurrent).toHaveBeenCalledWith(asset.id, null);
    });

    it('only accepts rendered revisions', async () => {
      developRepository.get.mockResolvedValue(
        revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Failed }),
      );
      await expect(sut.revert(authStub.user1, asset.id, { revisionId: 'rev' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      developRepository.get.mockResolvedValue(
        revisionStub({ id: 'rev', assetId: asset.id, status: AssetDevelopRevisionStatus.Rendered }),
      );
      await sut.revert(authStub.user1, asset.id, { revisionId: 'rev' });
      expect(developRepository.setCurrent).toHaveBeenCalledWith(asset.id, 'rev');
    });
  });

  describe('getFile', () => {
    it('serves only rendered files', async () => {
      developRepository.get.mockResolvedValue(
        revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued }),
      );
      await expect(sut.getFile(authStub.user1, asset.id, 'rev', AssetDevelopFileKind.Preview)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      developRepository.get.mockResolvedValue(
        revisionStub({
          assetId: asset.id,
          status: AssetDevelopRevisionStatus.Rendered,
          masterPath: '/data/thumbs/o/as/se/asset_develop_rev_master.jpeg',
          previewPath: '/data/thumbs/o/as/se/asset_develop_rev_preview.jpeg',
        }),
      );
      const file = await sut.getFile(authStub.user1, asset.id, 'rev', AssetDevelopFileKind.Master);
      expect(file.path).toBe('/data/thumbs/o/as/se/asset_develop_rev_master.jpeg');
      expect(file.contentType).toBe('image/jpeg');
    });
  });

  describe('preview', () => {
    it.each([true, false])(
      'refuses silent HDR flattening even when reconstruction is available: %s',
      async (available) => {
        mocks.media.inspectImageEncoding.mockResolvedValue({
          dynamicRange: 'hdr',
          gainMap: 'apple-legacy',
          referenceWhite: 203,
          reconstructionAvailable: available,
        });
        await expect(
          sut.preview(authStub.user1, asset.id, {
            recipe: defaultDevelopRecipe(),
            size: 640,
          }),
        ).rejects.toThrow('HDR-preserving Develop rendering is not available');
        expect(mocks.media.decodeImage).not.toHaveBeenCalled();
        expect(mocks.media.encodeDevelopOutput).not.toHaveBeenCalled();
        expect(mocks.storage.rename).not.toHaveBeenCalled();
      },
    );

    it('uses the full native sRGB pipeline for an explicit version 2 RAW recipe', async () => {
      const raw = { ...getForGenerateThumbnail(asset), originalFileName: 'image.CR2' };
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(raw);
      const native = Buffer.from('mock-native-png');
      vi.mocked(renderDarktable).mockResolvedValue(native);
      mocks.media.encodeDevelopOutput.mockResolvedValue(Buffer.from('jpeg'));
      const recipe = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 1 };
      await sut.preview(authStub.user1, asset.id, { recipe, size: 640 });
      expect(renderDarktable).toHaveBeenCalledWith(raw.originalPath, recipe, expect.any(AbortSignal), expect.any(Map));
      expect(mocks.media.extract).not.toHaveBeenCalled();
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
      expect(encodeNativeDevelopOutput).toHaveBeenCalledWith(native, expect.objectContaining({ size: 640 }));
      expect(mocks.media.renderDevelopGeometry).not.toHaveBeenCalled();
    });
    it('renders from the original and returns bytes without writing files', async () => {
      mocks.media.encodeDevelopOutput.mockResolvedValue(Buffer.from('jpeg-bytes'));
      const result = await sut.preview(authStub.user1, asset.id, {
        recipe: { ...defaultDevelopRecipe(), contrast: 20 },
        size: 640,
      });
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, expect.objectContaining({ size: 1280 }));
      expect(mocks.media.encodeDevelopOutput).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.objectContaining({ width: 4, height: 4 }),
        expect.objectContaining({ size: 640 }),
      );
      expect(mocks.media.encodeDevelopOutput.mock.calls[0]).toHaveLength(3);
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(result.buffer.toString()).toBe('jpeg-bytes');
      expect(result.contentType).toBe('image/jpeg');
    });
  });

  it('fails recovered unsupported queued recipes permanently without decode/publication/retry', async () => {
    const revision = revisionStub({
      assetId: asset.id,
      recipe: { version: 2 },
      status: AssetDevelopRevisionStatus.Queued,
    });
    developRepository.get.mockResolvedValue(revision);
    developRepository.beginAttempt.mockResolvedValue({ ...revision, status: AssetDevelopRevisionStatus.Rendering });
    await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Failed);
    expect(mocks.media.decodeImage).not.toHaveBeenCalled();
    expect(developRepository.setCurrent).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalled();
    expect(developRepository.update).toHaveBeenCalledWith(
      revision.id,
      expect.objectContaining({ status: AssetDevelopRevisionStatus.Failed }),
    );
  });

  describe('HDR version 3', () => {
    const recipe = { version: 3, exposure: 1 };
    it('refuses rendering while disabled before creating history or media', async () => {
      vi.stubEnv('FRAMELEAF_HDR_IMAGES', '');
      try {
        await expect(sut.save(authStub.user1, asset.id, { recipe, render: true })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(developRepository.create).not.toHaveBeenCalled();
        await expect(sut.preview(authStub.user1, asset.id, { recipe, size: 256 })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(mocks.media.generateHdrRenditions).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it('publishes HDR and compatible SDR together without legacy pixel decoding or motion changes', async () => {
      vi.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
      try {
        const revision = revisionStub({
          assetId: asset.id,
          recipe,
          recipeVersion: 3,
          status: AssetDevelopRevisionStatus.Queued,
        });
        developRepository.get.mockResolvedValue({
          ...revision,
          masterPath: '/old-sdr.jpg',
          previewPath: '/old-preview.jpg',
          hdrMasterPath: '/old-hdr.jpg',
          hdrPreviewPath: '/old-hdr-preview.jpg',
        });
        mocks.asset.getById.mockResolvedValue({ ...asset, livePhotoVideoId: 'original-motion' } as never);
        mocks.media.generateHdrRenditions.mockImplementation((_input, outputs) =>
          Promise.resolve(
            outputs.map(({ path, dynamicRange }) => ({
              path,
              width: 64,
              height: 32,
              gamut: 1 as const,
              encoding: {
                dynamicRange: dynamicRange ?? 'hdr',
                gainMap: dynamicRange === 'sdr' ? 'none' : 'iso',
                reconstructionAvailable: dynamicRange !== 'sdr',
              },
            })),
          ),
        );
        await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Success);
        const call = mocks.media.generateHdrRenditions.mock.calls[0];
        expect(call[0]).toBe(asset.originalPath);
        expect(call[1]).toHaveLength(4);
        expect(call[1].map((x) => x.dynamicRange ?? 'hdr')).toEqual(['hdr', 'hdr', 'sdr', 'sdr']);
        expect(call[2]).toMatchObject({ recipe: { version: 1, exposure: 1 }, seed: 2 });
        expect(mocks.media.decodeImage).not.toHaveBeenCalled();
        expect(mocks.storage.rename).toHaveBeenCalledTimes(4);
        expect(developRepository.beginAttempt).toHaveBeenCalledWith(
          revision.id,
          'frameleaf-develop-hdr/1',
          DEVELOP_RENDER_LEASE_MS / 1000,
        );
        expect(developRepository.update).toHaveBeenCalledWith(
          revision.id,
          expect.objectContaining({
            hdrMasterPath: expect.stringContaining('_master_hdr.jpg'),
            hdrPreviewPath: expect.stringContaining('_preview_hdr.jpg'),
            hdrRenditionChecksum: originalSha,
            sourceChecksum: originalSha,
            status: AssetDevelopRevisionStatus.Rendered,
          }),
        );
        expect(developRepository.setCurrent).toHaveBeenCalledWith(asset.id, revision.id);
        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.FileDelete,
          data: { files: ['/old-sdr.jpg', '/old-preview.jpg', '/old-hdr.jpg', '/old-hdr-preview.jpg'] },
        });
        expect(mocks.asset.update).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it('never adopts a failed four-output set or deletes previous working files', async () => {
      vi.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
      try {
        const revision = revisionStub({
          assetId: asset.id,
          recipe,
          recipeVersion: 3,
          status: AssetDevelopRevisionStatus.Queued,
          masterPath: '/prior-sdr.jpg',
          previewPath: '/prior-preview.jpg',
          hdrMasterPath: '/prior-hdr.jpg',
          hdrPreviewPath: '/prior-hdr-preview.jpg',
          hdrRenditionChecksum: originalSha,
          renderedAt: new Date(),
        });
        developRepository.get.mockResolvedValue(revision);
        mocks.media.generateHdrRenditions.mockRejectedValue(new Error('INVALID_HDR_RENDITION'));
        await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Failed);
        expect(developRepository.setCurrent).not.toHaveBeenCalled();
        expect(mocks.storage.rename).not.toHaveBeenCalled();
        for (const path of ['/prior-sdr.jpg', '/prior-preview.jpg', '/prior-hdr.jpg', '/prior-hdr-preview.jpg'])
          expect(mocks.storage.unlink).not.toHaveBeenCalledWith(path);
        await expect(
          sut.getFile(authStub.user1, asset.id, revision.id, AssetDevelopFileKind.Preview, 'sdr'),
        ).resolves.toMatchObject({ path: '/prior-preview.jpg' });
        await expect(
          sut.getFile(authStub.user1, asset.id, revision.id, AssetDevelopFileKind.Master, 'hdr'),
        ).resolves.toMatchObject({ path: '/prior-hdr.jpg' });
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it('aborts the isolated HDR call on a shared-row cancellation without publication', async () => {
      vi.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
      try {
        const revision = revisionStub({
          assetId: asset.id,
          recipe,
          recipeVersion: 3,
          status: AssetDevelopRevisionStatus.Queued,
        });
        developRepository.get.mockResolvedValue(revision);
        developRepository.isCancelRequested.mockResolvedValue(true);
        mocks.media.generateHdrRenditions.mockImplementation(
          (_input, _outputs, _develop, signal) =>
            new Promise((_resolve, reject) => {
              signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
            }),
        );
        await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Skipped);
        expect(developRepository.setCurrent).not.toHaveBeenCalled();
        expect(mocks.storage.rename).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it('rejects a changed normalized fill before the worker consumes it', async () => {
      vi.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
      try {
        const fill = 'e'.repeat(64);
        developRepository.getArtifacts.mockResolvedValue([
          { id: fill, assetId: asset.id, ownerId: asset.ownerId, kind: 'fill', path: '/artifact.png' },
        ]);
        await expect(
          sut.preview(authStub.user1, asset.id, {
            recipe: {
              version: 3,
              cleanup: [{ id: 'fill', method: 'remove', region: { x: 0, y: 0, w: 1, h: 1 }, fill }],
            },
            size: 256,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mocks.media.decodeDevelopArtifact).not.toHaveBeenCalled();
        expect(mocks.media.generateHdrRenditions).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it('retains HDR preview bytes only until the response has been read and defaults to SDR', async () => {
      vi.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
      try {
        mocks.media.generateHdrRenditions.mockResolvedValue([]);
        mocks.storage.readFile.mockResolvedValue(Buffer.from('server-authoritative-preview'));
        for (const dynamicRange of [undefined, 'hdr'] as const) {
          const result = await sut.preview(authStub.user1, asset.id, { recipe, size: 256, dynamicRange });
          expect(result.buffer.toString()).toBe('server-authoritative-preview');
          expect(mocks.media.generateHdrRenditions.mock.lastCall?.[1][0]).toMatchObject({
            size: 256,
            dynamicRange: dynamicRange ?? 'sdr',
          });
        }
        expect(mocks.storage.rename).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('handleRender', () => {
    it('records native provenance and derives master and preview from the same native pixels', async () => {
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        originalFileName: 'image.CR2',
      });
      const recipe = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 1 };
      const revision = revisionStub({
        assetId: asset.id,
        recipe,
        recipeVersion: 2,
        status: AssetDevelopRevisionStatus.Queued,
      });
      developRepository.get.mockResolvedValue(revision);
      vi.mocked(renderDarktable).mockResolvedValue(Buffer.from('mock-native-png'));
      await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Success);
      expect(developRepository.beginAttempt).toHaveBeenCalledWith(
        revision.id,
        DARKTABLE_RENDERER_VERSION,
        DEVELOP_RENDER_LEASE_MS / 1000,
      );
      const calls = vi.mocked(encodeNativeDevelopOutput).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0]).toBe(calls[1][0]);
      expect(calls[0][1]).toMatchObject({ format: 'jpeg' });
      expect(calls[1][1]).toMatchObject({ format: 'jpeg' });
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
      expect(mocks.media.extract).not.toHaveBeenCalled();
    });

    it('aborts native work when cancellation arrives through the shared revision row', async () => {
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        originalFileName: 'image.CR2',
      });
      const revision = revisionStub({
        assetId: asset.id,
        recipe: { version: 2, renderer: 'darktable/5.6.1', exposureEV: 1 },
        status: AssetDevelopRevisionStatus.Queued,
      });
      developRepository.get.mockResolvedValue(revision);
      developRepository.isCancelRequested.mockResolvedValueOnce(false).mockResolvedValue(true);
      vi.mocked(renderDarktable).mockImplementation(
        (_input, _recipe, signal) =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
          }),
      );
      await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(developRepository.setCurrent).not.toHaveBeenCalled();
      expect(developRepository.update).toHaveBeenCalledWith(
        revision.id,
        expect.objectContaining({ status: AssetDevelopRevisionStatus.Cancelled }),
      );
    });
    it.each([null, 'original-motion'])(
      'renders the still atomically with motion link %s intact',
      async (livePhotoVideoId) => {
        mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(
          getForGenerateThumbnail({ ...asset, livePhotoVideoId }),
        );
        const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued, revision: 3 });
        developRepository.get.mockResolvedValue(revision);

        await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Success);

        // The original is only ever an input.
        expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, expect.any(Object));
        const writtenPaths = mocks.media.encodeDevelopOutput.mock.calls.map((call) => call[3]);
        expect(writtenPaths).toHaveLength(2);
        for (const written of writtenPaths) {
          expect(written).toContain(`${asset.id}_develop_${revision.id}_`);
          expect(written).toMatch(/\.tmp$/);
          expect(written).not.toBe(asset.originalPath);
        }
        expect(mocks.storage.rename).toHaveBeenCalledTimes(2);
        const renames = mocks.storage.rename.mock.calls;
        expect(renames[0][1]).toMatch(/_master\.jpeg$/);
        expect(renames[1][1]).toMatch(/_preview\.jpeg$/);
        expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();

        expect(developRepository.update).toHaveBeenCalledWith(
          revision.id,
          expect.objectContaining({
            status: AssetDevelopRevisionStatus.Rendered,
            progress: 100,
            masterPath: renames[0][1],
            previewPath: renames[1][1],
            width: 4,
            height: 4,
          }),
        );
        expect(developRepository.setCurrent).toHaveBeenCalledWith(asset.id, revision.id);
        expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      },
    );

    it('stops between stages when a cancel is requested and discards partial output', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);
      developRepository.isCancelRequested.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(2);
      expect(developRepository.update).toHaveBeenCalledWith(revision.id, {
        status: AssetDevelopRevisionStatus.Cancelled,
        progress: 0,
      });
      expect(developRepository.setCurrent).not.toHaveBeenCalled();
    });

    it('retries a first failure once, after a delay, without publishing files or moving the working version', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);
      mocks.media.encodeDevelopOutput.mockRejectedValueOnce(new Error('libvips: out of memory'));

      await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Failed);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(developRepository.setCurrent).not.toHaveBeenCalled();
      expect(developRepository.update).toHaveBeenCalledWith(revision.id, {
        status: AssetDevelopRevisionStatus.Queued,
        progress: 0,
        error: 'libvips: out of memory',
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetDevelopRender,
        data: { id: revision.id, delay: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS },
      });
    });

    it('records the failure of the automatic retry and waits for a person', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued, attempts: 1 });
      developRepository.get.mockResolvedValue(revision);
      mocks.media.encodeDevelopOutput.mockRejectedValueOnce(new Error('libvips: out of memory'));

      await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Failed);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(developRepository.setCurrent).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(developRepository.update).toHaveBeenCalledWith(revision.id, {
        status: AssetDevelopRevisionStatus.Failed,
        error: 'libvips: out of memory',
      });
    });

    it('leaves a render another worker is still running alone', async () => {
      developRepository.get.mockResolvedValue(
        revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Rendering, updatedAt: new Date() }),
      );
      await expect(sut.handleRender({ id: 'rev' })).resolves.toBe(JobStatus.Skipped);
      expect(developRepository.beginAttempt).not.toHaveBeenCalled();
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
    });

    it('claims a render with the lease, so the database refuses a second claim of a live one', async () => {
      developRepository.get.mockResolvedValue(
        revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued }),
      );
      await sut.handleRender({ id: 'rev' });
      expect(developRepository.beginAttempt).toHaveBeenCalledWith(
        'rev',
        expect.any(String),
        DEVELOP_RENDER_LEASE_MS / 1000,
      );
    });

    it('records the original and the master it produced for lineage', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);
      await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Success);
      expect(developRepository.update).toHaveBeenCalledWith(
        revision.id,
        expect.objectContaining({ status: AssetDevelopRevisionStatus.Rendered, sourceChecksum: originalSha }),
      );
    });

    it('renders selective masks into the edited master', async () => {
      const plain = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(plain);
      await sut.handleRender({ id: plain.id });
      const withoutMask = Buffer.from(mocks.media.encodeDevelopOutput.mock.calls[0][0] as Buffer);

      mocks.media.encodeDevelopOutput.mockClear();
      mocks.media.decodeImage.mockResolvedValue({
        data: Buffer.alloc(4 * 4 * 3, 128),
        info: { width: 4, height: 4, channels: 3 },
      } as never);
      const masked = revisionStub({
        assetId: asset.id,
        status: AssetDevelopRevisionStatus.Queued,
        recipe: {
          ...defaultDevelopRecipe(),
          masks: [
            {
              id: 'sky',
              name: null,
              kind: AssetDevelopMaskKind.Linear,
              enabled: true,
              invert: false,
              x: 0.5,
              y: 0,
              radiusX: 0.25,
              radiusY: 0.25,
              endX: 0.5,
              endY: 0.5,
              feather: 50,
              amount: 100,
              adjustments: { ...noAdjustments, exposure: -1 },
            },
          ],
        },
      });
      developRepository.get.mockResolvedValue(masked);
      await sut.handleRender({ id: masked.id });
      const withMask = mocks.media.encodeDevelopOutput.mock.calls[0][0] as Buffer;
      // The top row darkens; the bottom half, past the end of the gradient, does not.
      expect(withMask[0]).toBeLessThan(withoutMask[0]);
      expect(withMask.at(-1)).toBe(withoutMask.at(-1));
    });

    it('never re-renders an already rendered revision', async () => {
      developRepository.get.mockResolvedValue(
        revisionStub({
          assetId: asset.id,
          status: AssetDevelopRevisionStatus.Rendered,
          masterPath: '/m',
          previewPath: '/p',
        }),
      );
      await expect(sut.handleRender({ id: 'rev' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
    });

    it('skips a revision that was cancelled before the worker picked it up', async () => {
      developRepository.get.mockResolvedValue(revisionStub({ assetId: asset.id, cancelRequested: true }));
      await expect(sut.handleRender({ id: 'rev' })).resolves.toBe(JobStatus.Skipped);
      expect(developRepository.update).toHaveBeenCalledWith('rev', {
        status: AssetDevelopRevisionStatus.Cancelled,
        progress: 0,
      });
    });
  });

  describe('onAssetDelete', () => {
    /** The repository releases the files and queues their deletion inside its transaction, as it does. */
    const releasing = (files: string[]) =>
      developRepository.releaseRemovedAssetRevisions.mockImplementation(
        async (queue: (files: string[]) => Promise<void>) => {
          if (files.length > 0) {
            await queue(files);
          }
          return files;
        },
      );

    it('removes the revisions and queues their rendered files for deletion', async () => {
      releasing(['/m1', '/p1']);
      await sut.onAssetDelete({ assetId: asset.id, userId: asset.ownerId });
      expect(developRepository.releaseRemovedAssetRevisions).toHaveBeenCalledWith(expect.any(Function), asset.id);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FileDelete, data: { files: ['/m1', '/p1'] } });
    });

    it('queues nothing when the revisions are left for later, as during a handoff (FL-179)', async () => {
      releasing([]);
      await sut.onAssetDelete({ assetId: asset.id, userId: asset.ownerId });
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('fails, keeping the revisions for the nightly sweep, when the cleanup cannot be queued (FL-179)', async () => {
      releasing(['/m1']);
      mocks.job.queue.mockRejectedValue(new Error('queue database unavailable'));
      await expect(sut.onAssetDelete({ assetId: asset.id, userId: asset.ownerId })).rejects.toThrow(
        'queue database unavailable',
      );
    });
  });

  describe('onNightlyDatabaseCleanup (FL-179)', () => {
    it('releases the revisions of removed assets left earlier', async () => {
      developRepository.releaseRemovedAssetRevisions.mockImplementation(
        async (queue: (files: string[]) => Promise<void>) => {
          await queue(['/m2']);
          return ['/m2'];
        },
      );
      await sut.onNightlyDatabaseCleanup();
      expect(developRepository.releaseRemovedAssetRevisions).toHaveBeenCalledWith(expect.any(Function));
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FileDelete, data: { files: ['/m2'] } });
    });

    it('defers a failure to the next night', async () => {
      developRepository.releaseRemovedAssetRevisions.mockRejectedValue(new Error('database unavailable'));
      await expect(sut.onNightlyDatabaseCleanup()).resolves.toBeUndefined();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });
  describe('onBootstrap', () => {
    it('requeues queued renders and renders whose lease lapsed, never a live one', async () => {
      const stale = new Date(Date.now() - DEVELOP_RENDER_LEASE_MS - 1000);
      developRepository.listUnfinished.mockResolvedValue([
        { id: 'queued', status: AssetDevelopRevisionStatus.Queued, updatedAt: new Date() },
        { id: 'lost', status: AssetDevelopRevisionStatus.Rendering, updatedAt: stale },
        { id: 'live', status: AssetDevelopRevisionStatus.Rendering, updatedAt: new Date() },
      ]);
      await sut.onBootstrap();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDevelopRender, data: { id: 'queued' } },
        { name: JobName.AssetDevelopRender, data: { id: 'lost' } },
      ]);
    });
  });

  describe('onBootstrap with Activity jobs (FL-43)', () => {
    it('leaves a render its Activity job will recover to that job', async () => {
      developRepository.listUnfinished.mockResolvedValue([
        { id: 'tracked', status: AssetDevelopRevisionStatus.Queued, updatedAt: new Date() },
        { id: 'untracked', status: AssetDevelopRevisionStatus.Queued, updatedAt: new Date() },
      ]);
      mocks.media.getImageMetadata.mockResolvedValue({ width: 4, height: 4, isTransparent: false });
      vi.mocked(encodeNativeDevelopOutput).mockReset().mockResolvedValue(Buffer.from('jpeg'));
      mocks.mediaOperation.getTrackedRevisionIds.mockResolvedValue(new Set(['tracked']));

      await sut.onBootstrap();

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDevelopRender, data: { id: 'untracked' } },
      ]);
    });
  });

  describe('as a job in Activity (FL-43)', () => {
    const claimed = {
      operation: { id: 'op-1', ownerId: authStub.user1.user.id, assetId: asset.id },
      claimToken: 'token-1',
    };

    beforeEach(() => {
      mocks.mediaOperation.create.mockResolvedValue({ id: 'op-1' } as never);
      mocks.mediaOperation.beginJobQueueRun.mockResolvedValue(claimed as never);
      mocks.mediaOperation.reportProgress.mockResolvedValue(true);
      mocks.mediaOperation.beginValidation.mockResolvedValue(true);
      mocks.mediaOperation.complete.mockResolvedValue(true);
      mocks.mediaOperation.heartbeat.mockResolvedValue(true);
      mocks.mediaOperation.getForWorker.mockResolvedValue({ cancelRequestedAt: null, claimToken: 'token-1' } as never);
    });

    it('records a queued render as a photo version job for the photo, and queues it with the job', async () => {
      const created = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Saved });
      developRepository.create.mockResolvedValue(created);

      await sut.save(authStub.user1, asset.id, { recipe: defaultDevelopRecipe(), render: true });

      expect(mocks.mediaOperation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: created.ownerId,
          kind: 'quick_edit',
          destination: 'local',
          label: asset.originalFileName,
          assetId: asset.id,
          revisionId: created.id,
          settings: { edit: 'photo_version' },
          claimedBy: 'job-queue',
          snapshot: expect.objectContaining({
            executor: 'job_queue',
            job: { name: JobName.AssetDevelopRender, data: { id: created.id } },
          }),
        }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetDevelopRender,
        data: { id: created.id, operationId: 'op-1' },
      });
    });

    it('refuses untracked rendering when the durable job row cannot be written', async () => {
      const created = revisionStub({ assetId: asset.id });
      developRepository.create.mockResolvedValue(created);
      mocks.mediaOperation.create.mockRejectedValue(new Error('database busy'));

      await expect(
        sut.save(authStub.user1, asset.id, { recipe: defaultDevelopRecipe(), render: true }),
      ).rejects.toThrow('database busy');
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('does not adopt staged render paths when the operation is cancelled before final validation', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);
      mocks.mediaOperation.beginValidation.mockResolvedValue(false);
      mocks.mediaOperation.getForWorker.mockResolvedValue({
        cancelRequestedAt: new Date(),
        claimToken: 'token-1',
      } as never);
      mocks.mediaOperation.acknowledgeCancel.mockResolvedValue(true);
      const context: QueueExecution = {
        claim: { id: 'queue-job', token: 'queue-token' } as QueueExecution['claim'],
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        buffering: false,
        adoptions: [],
        followups: [],
      };
      await expect(
        queueExecution.run(context, () => sut.handleRender({ id: revision.id, operationId: 'op-1' })),
      ).resolves.toBe(JobStatus.Skipped);
      expect(mocks.storage.rename).toHaveBeenCalledTimes(2);
      expect(context.adoptions).toEqual([]);
      expect(developRepository.update).not.toHaveBeenCalledWith(
        revision.id,
        expect.objectContaining({ status: AssetDevelopRevisionStatus.Rendered }),
      );
      expect(developRepository.setCurrent).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.complete).not.toHaveBeenCalled();
    });

    it('reports each stage, validates, makes the version current and completes with the photo', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);

      await expect(sut.handleRender({ id: revision.id, operationId: 'op-1' })).resolves.toBe(JobStatus.Success);

      expect(mocks.mediaOperation.beginJobQueueRun).toHaveBeenCalledWith('op-1', expect.any(Number));
      const reported = mocks.mediaOperation.reportProgress.mock.calls.map((call) => call[2].progress);
      expect(reported).toEqual([0, 25, 60, 85, 95]);
      expect(mocks.mediaOperation.beginValidation.mock.invocationCallOrder[0]).toBeLessThan(
        developRepository.setCurrent.mock.invocationCallOrder[0],
      );
      expect(mocks.mediaOperation.complete).toHaveBeenCalledWith('op-1', 'token-1', { resultAssetId: asset.id });
    });

    it('stops at the next stage when the job is cancelled in Activity, leaving the working version', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);
      // the cancel lands after the first stage: progress writes are refused from then on
      mocks.mediaOperation.reportProgress.mockResolvedValueOnce(true).mockResolvedValue(false);
      mocks.mediaOperation.getForWorker.mockResolvedValue({
        cancelRequestedAt: new Date(),
        claimToken: 'token-1',
      } as never);
      mocks.mediaOperation.acknowledgeCancel.mockResolvedValue(true);

      await expect(sut.handleRender({ id: revision.id, operationId: 'op-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(developRepository.setCurrent).not.toHaveBeenCalled();
      expect(developRepository.update).toHaveBeenCalledWith(revision.id, {
        status: AssetDevelopRevisionStatus.Cancelled,
        progress: 0,
      });
      expect(mocks.mediaOperation.acknowledgeCancel).toHaveBeenCalledWith('op-1', 'token-1', { released: true });
      expect(mocks.mediaOperation.complete).not.toHaveBeenCalled();
    });

    it('never starts a render whose job was cancelled while it waited, and marks the version cancelled', async () => {
      mocks.mediaOperation.beginJobQueueRun.mockResolvedValue(undefined);
      mocks.mediaOperation.getForWorker.mockResolvedValue({ cancelRequestedAt: new Date(), claimToken: null } as never);

      await expect(sut.handleRender({ id: 'rev', operationId: 'op-1' })).resolves.toBe(JobStatus.Skipped);

      expect(developRepository.update).toHaveBeenCalledWith('rev', {
        status: AssetDevelopRevisionStatus.Cancelled,
        cancelRequested: true,
        progress: 0,
      });
      expect(developRepository.beginAttempt).not.toHaveBeenCalled();
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
    });

    it('does nothing for a second delivery of a job another run already holds', async () => {
      mocks.mediaOperation.beginJobQueueRun.mockResolvedValue(undefined);
      mocks.mediaOperation.getForWorker.mockResolvedValue({ cancelRequestedAt: null, claimToken: 'other' } as never);

      await expect(sut.handleRender({ id: 'rev', operationId: 'op-1' })).resolves.toBe(JobStatus.Skipped);

      expect(developRepository.get).not.toHaveBeenCalled();
      expect(developRepository.update).not.toHaveBeenCalled();
    });

    it('keeps the previous working version when the claim is lost before publishing', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);
      mocks.mediaOperation.beginValidation.mockResolvedValue(false);
      mocks.mediaOperation.getForWorker.mockResolvedValue({
        cancelRequestedAt: null,
        claimToken: 'recovered',
      } as never);

      await expect(sut.handleRender({ id: revision.id, operationId: 'op-1' })).resolves.toBe(JobStatus.Skipped);

      expect(developRepository.setCurrent).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.complete).not.toHaveBeenCalled();
      expect(mocks.mediaOperation.fail).not.toHaveBeenCalled();
    });

    it('lets the job decide the automatic retry: the version waits queued and nothing requeues itself', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);
      mocks.media.encodeDevelopOutput.mockRejectedValueOnce(new Error('libvips: out of memory'));
      mocks.mediaOperation.fail.mockResolvedValue('retrying');

      await expect(sut.handleRender({ id: revision.id, operationId: 'op-1' })).resolves.toBe(JobStatus.Failed);

      expect(mocks.mediaOperation.fail).toHaveBeenCalledWith(
        'op-1',
        'token-1',
        { error: 'libvips: out of memory', errorCode: 'edit_render_failed' },
        { retry: true },
      );
      expect(developRepository.update).toHaveBeenCalledWith(revision.id, {
        status: AssetDevelopRevisionStatus.Queued,
        progress: 0,
        error: 'libvips: out of memory',
      });
      // the sweep dispatches the retry with its row; a second job here would run it twice
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(developRepository.setCurrent).not.toHaveBeenCalled();
    });

    it('reports the failure once the job has used its automatic retry', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);
      mocks.media.encodeDevelopOutput.mockRejectedValueOnce(new Error('libvips: out of memory'));
      mocks.mediaOperation.fail.mockResolvedValue('failed');

      await expect(sut.handleRender({ id: revision.id, operationId: 'op-1' })).resolves.toBe(JobStatus.Failed);

      expect(developRepository.update).toHaveBeenCalledWith(revision.id, {
        status: AssetDevelopRevisionStatus.Failed,
        error: 'libvips: out of memory',
      });
    });

    it('hands the job back to wait while another render still holds the version', async () => {
      developRepository.get.mockResolvedValue(
        revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Rendering, updatedAt: new Date() }),
      );
      mocks.mediaOperation.requeue.mockResolvedValue(true);

      await expect(sut.handleRender({ id: 'rev', operationId: 'op-1' })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.mediaOperation.requeue).toHaveBeenCalledWith('op-1', 'token-1', {
        delayMs: DEVELOP_RENDER_LEASE_MS,
        returnAttempt: true,
      });
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
    });

    it('cancels the version’s Activity job when the editor cancels it', async () => {
      const rendering = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Rendering });
      developRepository.get.mockResolvedValue(rendering);
      mocks.mediaOperation.listActiveEditsOfRevision.mockResolvedValue([{ id: 'op-1', status: 'rendering' }] as never);

      await sut.cancel(authStub.user1, asset.id, rendering.id);

      expect(mocks.mediaOperation.listActiveEditsOfRevision).toHaveBeenCalledWith(rendering.ownerId, rendering.id);
      expect(mocks.mediaOperation.requestCancel).toHaveBeenCalledWith('op-1', rendering.ownerId);
    });
  });

  describe('external development round trip', () => {
    const staged = { path: '/data/exports/user/develop-imports/abc.partial', originalname: 'IMG_0001.tif', size: 1024 };
    const exportRow = (overrides: Partial<DevelopExport> = {}): DevelopExport => ({
      id: '0d9f8b4e-2f7c-4a51-9d1e-6c1e4a2b3c4d',
      assetId: asset.id,
      ownerId: asset.ownerId,
      sourceChecksum: originalSha,
      fileName: asset.originalFileName,
      createdAt: new Date('2026-09-23T09:00:00Z') as never,
      ...overrides,
    });

    beforeEach(() => {
      mocks.media.getImageMetadata.mockResolvedValue({ width: 64, height: 48, isTransparent: false });
      developRepository.create.mockImplementation((input: Partial<AssetDevelopRevision>) =>
        Promise.resolve(revisionStub({ ...input, id: 'imported', revision: 2 })),
      );
    });

    it('records an export with the SHA-256 of the original', async () => {
      photoTools.createExport.mockImplementation((input: Partial<DevelopExport>) => Promise.resolve(exportRow(input)));
      const result = await sut.createExport(authStub.user1, asset.id);
      expect(photoTools.createExport).toHaveBeenCalledWith({
        assetId: asset.id,
        ownerId: asset.ownerId,
        sourceChecksum: originalSha,
        fileName: asset.originalFileName,
      });
      expect(result).toMatchObject({ sourceChecksum: originalSha.toString('hex'), isCurrentOriginal: true });
    });

    it('uses the stored checksum when the original already has a SHA-256', async () => {
      mocks.asset.getById.mockResolvedValue({
        ...asset,
        checksum: originalSha,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      } as never);
      photoTools.createExport.mockImplementation((input: Partial<DevelopExport>) => Promise.resolve(exportRow(input)));
      await sut.createExport(authStub.user1, asset.id);
      expect(mocks.crypto.hashFile).not.toHaveBeenCalledWith(asset.originalPath, 'sha256');
    });

    it('keeps a developed file that answers its export as a new version and queues its preview', async () => {
      photoTools.getExport.mockResolvedValue(exportRow());

      const result = await sut.importRendition(
        authStub.user1,
        asset.id,
        { exportId: exportRow().id, renditionChecksum: renditionSha.toString('hex'), software: 'darktable 5' },
        staged,
      );

      const kept = mocks.storage.rename.mock.calls[0][1] as string;
      expect(mocks.storage.rename).toHaveBeenCalledWith(staged.path, kept);
      expect(kept).toMatch(new RegExp(String.raw`${asset.id}_develop_import_.+\.tif$`));
      expect(developRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: AssetDevelopRevisionKind.External,
          sourceChecksum: originalSha,
          renditionChecksum: renditionSha,
          exportId: exportRow().id,
          fileName: 'IMG_0001.tif',
          software: 'darktable 5',
          masterPath: kept,
        }),
      );
      // A render of the preview only; no library, thumbnail or machine-learning job is started.
      expect(mocks.job.queue).toHaveBeenCalledTimes(1);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetDevelopRender,
        data: { id: 'imported', operationId: 'op-1' },
      });
      expect(developRepository.setCurrent).not.toHaveBeenCalled();
      expect(result.status).toBe(AssetDevelopRevisionStatus.Queued);
    });

    it('refuses a file developed from a different original and keeps nothing', async () => {
      photoTools.getExport.mockResolvedValue(exportRow({ sourceChecksum: Buffer.alloc(32, 1) }));
      await expect(
        sut.importRendition(authStub.user1, asset.id, { exportId: exportRow().id }, staged),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        sut.importRendition(authStub.user1, asset.id, { sourceChecksum: 'ab'.repeat(32) }, staged),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(developRepository.create).not.toHaveBeenCalled();
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(staged.path);
    });

    it("refuses an export made from another photo, including someone else's", async () => {
      photoTools.getExport.mockResolvedValue(exportRow({ assetId: 'another-asset' }));
      await expect(
        sut.importRendition(authStub.user1, asset.id, { exportId: exportRow().id }, staged),
      ).rejects.toBeInstanceOf(BadRequestException);
      photoTools.getExport.mockResolvedValue(undefined);
      await expect(sut.importRendition(authStub.user1, asset.id, { exportId: exportRow().id }, staged)).rejects.toThrow(
        'That export was not made from this photo',
      );
      expect(developRepository.create).not.toHaveBeenCalled();
    });

    it('refuses an interrupted transfer whose bytes do not match what the client sent', async () => {
      photoTools.getExport.mockResolvedValue(exportRow());
      await expect(
        sut.importRendition(
          authStub.user1,
          asset.id,
          { exportId: exportRow().id, renditionChecksum: 'cd'.repeat(32) },
          staged,
        ),
      ).rejects.toThrow('did not arrive intact');
      expect(developRepository.create).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(staged.path);
    });

    it('refuses a file that is named like an image but is not one, before keeping it', async () => {
      photoTools.getExport.mockResolvedValue(exportRow());
      mocks.media.getImageMetadata.mockRejectedValue(new Error('Input file contains unsupported image format'));
      await expect(sut.importRendition(authStub.user1, asset.id, { exportId: exportRow().id }, staged)).rejects.toThrow(
        'not a readable image',
      );
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(developRepository.create).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(staged.path);
    });

    it('refuses a RAW, an unsupported format and an empty file', async () => {
      photoTools.getExport.mockResolvedValue(exportRow());
      for (const file of [
        { ...staged, originalname: 'IMG_0001.CR3' },
        { ...staged, originalname: 'notes.txt' },
        { ...staged, size: 0 },
      ]) {
        await expect(
          sut.importRendition(authStub.user1, asset.id, { exportId: exportRow().id }, file),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(developRepository.create).not.toHaveBeenCalled();
    });

    it('refuses a hidden parent: Locked without an unlocked session, trashed, or kept out of view', async () => {
      photoTools.getExport.mockResolvedValue(exportRow());
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(
        sut.importRendition(authStub.user1, asset.id, { exportId: exportRow().id }, staged),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.createExport(authStub.user1, asset.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.listExports(authStub.user1, asset.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.user1.user.id,
        new Set([asset.id]),
        undefined,
      );

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue({ ...asset, deletedAt: new Date() } as never);
      await expect(sut.importRendition(authStub.user1, asset.id, { exportId: exportRow().id }, staged)).rejects.toThrow(
        'Restore the photo from the trash',
      );
      mocks.asset.getById.mockResolvedValue({ ...asset, visibility: AssetVisibility.Hidden } as never);
      await expect(
        sut.importRendition(authStub.user1, asset.id, { exportId: exportRow().id }, staged),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(developRepository.create).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledWith(staged.path);
    });

    it('makes an imported version current only once its preview has rendered', async () => {
      const imported = revisionStub({
        id: 'imported',
        assetId: asset.id,
        kind: AssetDevelopRevisionKind.External,
        status: AssetDevelopRevisionStatus.Queued,
        masterPath: `/thumbs/${asset.id}_develop_import_x.tif`,
        sourceChecksum: originalSha,
        renditionChecksum: renditionSha,
      });
      developRepository.get.mockResolvedValue(imported);
      mocks.media.getOrientedSize.mockResolvedValue({ width: 6000, height: 4000 });

      await expect(sut.handleRender({ id: 'imported' })).resolves.toBe(JobStatus.Success);

      expect(mocks.media.decodeImage).toHaveBeenCalledWith(imported.masterPath, expect.any(Object));
      expect(mocks.media.encodeDevelopOutput).toHaveBeenCalledTimes(1);
      expect(mocks.storage.rename).toHaveBeenCalledTimes(1);
      expect(developRepository.update).toHaveBeenCalledWith(
        'imported',
        expect.objectContaining({ status: AssetDevelopRevisionStatus.Rendered, width: 6000, height: 4000 }),
      );
      expect(developRepository.setCurrent).toHaveBeenCalledWith(asset.id, 'imported');
    });

    it('fails an imported version whose original changed, without a retry or a new working version', async () => {
      developRepository.get.mockResolvedValue(
        revisionStub({
          id: 'imported',
          assetId: asset.id,
          kind: AssetDevelopRevisionKind.External,
          status: AssetDevelopRevisionStatus.Queued,
          masterPath: `/thumbs/${asset.id}_develop_import_x.tif`,
          sourceChecksum: Buffer.alloc(32, 3),
          renditionChecksum: renditionSha,
        }),
      );

      await expect(sut.handleRender({ id: 'imported' })).resolves.toBe(JobStatus.Failed);

      expect(mocks.media.encodeDevelopOutput).not.toHaveBeenCalled();
      expect(developRepository.setCurrent).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(developRepository.update).toHaveBeenCalledWith('imported', {
        status: AssetDevelopRevisionStatus.Failed,
        error: 'The original changed after this file was brought back',
      });
      // The file can never become a version, so it is not kept.
      expect(developRepository.update).toHaveBeenCalledWith('imported', { masterPath: null });
      expect(mocks.storage.unlink).toHaveBeenCalledWith(`/thumbs/${asset.id}_develop_import_x.tif`);
    });
  });
});
