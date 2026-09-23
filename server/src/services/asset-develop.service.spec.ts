import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetDevelopFileKind, AssetDevelopPreset, AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetType, JobName, JobStatus } from 'src/enum.js';
import { AssetDevelopRepository, type AssetDevelopRevision } from 'src/repositories/asset-develop.repository.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

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
  createdAt: new Date('2026-09-22T10:00:00Z'),
  updatedAt: new Date('2026-09-22T10:00:00Z'),
  renderedAt: null,
  ...overrides,
});

describe(AssetDevelopService.name, () => {
  let sut: AssetDevelopService;
  let mocks: ServiceMocks;
  let developRepository: {
    [K in keyof AssetDevelopRepository]: ReturnType<typeof vi.fn>;
  };

  const asset = AssetFactory.from({ ownerId: authStub.user1.user.id, type: AssetType.Image })
    .exif({ orientation: null, colorspace: 'sRGB' })
    .build();

  beforeEach(() => {
    mocks = getMocks();
    developRepository = {
      listByAsset: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      getCurrent: vi.fn(),
      create: vi.fn(),
      update: vi.fn().mockImplementation((id: string, patch: Partial<AssetDevelopRevision>) =>
        Promise.resolve(revisionStub({ id, ...patch })),
      ),
      setCurrent: vi.fn().mockResolvedValue(void 0),
      requestCancel: vi.fn().mockResolvedValue(void 0),
      isCancelRequested: vi.fn().mockResolvedValue(false),
      getFilePaths: vi.fn().mockResolvedValue([]),
      deleteByAsset: vi.fn().mockResolvedValue(void 0),
    };
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
      mocks.job as never,
      mocks.media as never,
      mocks.storage as never,
      mocks.systemMetadata as never,
    );
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
    it('stores a normalized recipe as the next revision and queues the render', async () => {
      const created = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Saved });
      developRepository.create.mockResolvedValue(created);

      const response = await sut.save(authStub.user1, asset.id, {
        recipe: { ...defaultDevelopRecipe(), exposure: 9, preset: AssetDevelopPreset.Warm },
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
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetDevelopRender, data: { id: created.id } });
      expect(response.status).toBe(AssetDevelopRevisionStatus.Queued);
      expect(response.hasMaster).toBe(false);
    });

    it('can store a recipe without rendering', async () => {
      developRepository.create.mockResolvedValue(revisionStub({ assetId: asset.id }));
      const response = await sut.save(authStub.user1, asset.id, { recipe: defaultDevelopRecipe(), render: false });
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(response.status).toBe(AssetDevelopRevisionStatus.Saved);
    });

    it('refuses videos, offline originals and live photos', async () => {
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

      mocks.asset.getById.mockResolvedValue({ ...asset, livePhotoVideoId: 'motion' } as never);
      await expect(
        sut.save(authStub.user1, asset.id, { recipe: defaultDevelopRecipe(), render: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(developRepository.create).not.toHaveBeenCalled();
    });
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
      developRepository.get.mockResolvedValue(revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Failed }));
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
      developRepository.get.mockResolvedValue(revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued }));
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

  describe('handleRender', () => {
    it('renders into new files, publishes them atomically and makes the version current', async () => {
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
    });

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

    it('records a failure without publishing files', async () => {
      const revision = revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Queued });
      developRepository.get.mockResolvedValue(revision);
      mocks.media.encodeDevelopOutput.mockRejectedValueOnce(new Error('libvips: out of memory'));

      await expect(sut.handleRender({ id: revision.id })).resolves.toBe(JobStatus.Failed);

      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(developRepository.update).toHaveBeenCalledWith(revision.id, {
        status: AssetDevelopRevisionStatus.Failed,
        error: 'libvips: out of memory',
      });
    });

    it('never re-renders an already rendered revision', async () => {
      developRepository.get.mockResolvedValue(
        revisionStub({ assetId: asset.id, status: AssetDevelopRevisionStatus.Rendered, masterPath: '/m', previewPath: '/p' }),
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
    it('removes the revisions and queues their rendered files for deletion', async () => {
      developRepository.getFilePaths.mockResolvedValue(['/m1', '/p1']);
      await sut.onAssetDelete({ assetId: asset.id, userId: asset.ownerId });
      expect(developRepository.deleteByAsset).toHaveBeenCalledWith(asset.id);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FileDelete, data: { files: ['/m1', '/p1'] } });
    });
  });
});
