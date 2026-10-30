import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vitest } from 'vitest';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { MapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetType, AssetVisibility, JobName, JobStatus, SystemMetadataKey } from 'src/enum.js';
import { DuplicateService } from 'src/services/duplicate.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForDuplicate } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

vitest.useFakeTimers();

/** A minute of 4-frame scenes from `seed`, as stored. */
const timeline = (seed: number) => ({
  durationMs: 60_000,
  hashes: Array.from({ length: 120 }, (_, index) =>
    BigInt.asIntN(64, BigInt(seed * 1000 + Math.floor(index / 4) + 1) * 0x9e_37_79_b9_7f_4a_7c_15n).toString(),
  ),
});

const hasEmbedding = {
  id: 'asset-1',
  ownerId: 'user-id',
  stackId: null,
  type: AssetType.Image,
  duplicateId: null,
  embedding: '[1, 2, 3, 4]',
  visibility: AssetVisibility.Timeline,
};

const hasDupe = {
  ...hasEmbedding,
  id: 'asset-2',
  duplicateId: 'duplicate-id',
};

describe(DuplicateService.name, () => {
  let sut: DuplicateService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(DuplicateService));
    mocks.assetDevelop.getAssetIdsWithHistory.mockResolvedValue(new Set());
    mocks.duplicateRepository.findMotionTransfer.mockResolvedValue(undefined);
    mocks.duplicateRepository.withResolutionLock.mockImplementation((_id, callback) => callback(undefined as never));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getDuplicates', () => {
    it('should get duplicates', async () => {
      const asset = AssetFactory.from().exif().build();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['duplicate-id']));
      mocks.duplicateRepository.cleanupSingletonGroups.mockResolvedValue();
      mocks.duplicateRepository.getAll.mockResolvedValue([
        {
          duplicateId: 'duplicate-id',
          assets: [getForDuplicate(asset), getForDuplicate(asset)],
        },
      ]);
      await expect(sut.getDuplicates(authStub.admin)).resolves.toEqual([
        {
          duplicateId: 'duplicate-id',
          assets: [expect.objectContaining({ id: asset.id }), expect.objectContaining({ id: asset.id })],
          suggestedKeepAssetIds: [asset.id],
        },
      ]);
    });

    it('prefers a smaller HEIC and reports motion that still requires review', async () => {
      mocks.duplicateRepository.cleanupSingletonGroups.mockResolvedValue();
      const heic = AssetFactory.from({ originalFileName: 'capture.HEIC' }).exif({ fileSizeInByte: 1000 }).build();
      const jpeg = AssetFactory.from({ originalFileName: 'capture.jpg', livePhotoVideoId: 'motion' })
        .exif({ fileSizeInByte: 9000 })
        .build();
      mocks.duplicateRepository.getAll.mockResolvedValue([
        { duplicateId: 'group', assets: [getForDuplicate(jpeg), getForDuplicate(heic)] },
      ]);
      const [group] = await sut.getDuplicates(authStub.admin);
      expect(group.suggestedKeepAssetIds).toEqual([heic.id]);
      expect(group.reviewRequiredReasons).toEqual(['distinct-motion']);
    });

    it('requires review when Develop history evidence is unavailable', async () => {
      mocks.duplicateRepository.cleanupSingletonGroups.mockResolvedValue();
      const asset = AssetFactory.from().exif().build();
      mocks.duplicateRepository.getAll.mockResolvedValue([{ duplicateId: 'group', assets: [getForDuplicate(asset)] }]);
      mocks.assetDevelop.getAssetIdsWithHistory.mockRejectedValue(new Error('unavailable'));
      const [group] = await sut.getDuplicates(authStub.admin);
      expect(group.reviewRequiredReasons).toEqual(['evidence-unavailable']);
    });

    it('permits a verified motion transfer without pretending the keeper is already paired', async () => {
      mocks.duplicateRepository.cleanupSingletonGroups.mockResolvedValue();
      const heic = AssetFactory.from({ originalFileName: 'capture.HEIC' }).exif().build();
      const jpeg = AssetFactory.from({ livePhotoVideoId: 'proven-motion' }).exif().build();
      mocks.duplicateRepository.getAll.mockResolvedValue([
        { duplicateId: 'group', assets: [getForDuplicate(jpeg), getForDuplicate(heic)] },
      ]);
      mocks.duplicateRepository.findMotionTransfer.mockResolvedValue('proven-motion');
      const [group] = await sut.getDuplicates(authStub.admin);
      expect(group.suggestedKeepAssetIds).toEqual([heic.id]);
      expect(group.reviewRequiredReasons).toBeUndefined();
      expect(group.assets.find(({ id }) => id === heic.id)?.livePhotoVideoId).toBeNull();
    });

    it('should hide private NSFW duplicate assets when requested', async () => {
      mocks.duplicateRepository.cleanupSingletonGroups.mockResolvedValue();
      mocks.duplicateRepository.getAll.mockResolvedValue([]);

      await sut.getDuplicates({ ...authStub.admin, hideNsfwAssets: true });

      expect(mocks.duplicateRepository.getAll).toHaveBeenCalledWith(authStub.admin.user.id, { excludeNsfw: true });
    });

    it('should return suggestedKeepAssetIds based on file size', async () => {
      const smallAsset = AssetFactory.from().exif({ fileSizeInByte: 1000 }).build();
      const largeAsset = AssetFactory.from().exif({ fileSizeInByte: 5000 }).build();
      mocks.duplicateRepository.cleanupSingletonGroups.mockResolvedValue();
      mocks.duplicateRepository.getAll.mockResolvedValue([
        {
          duplicateId: 'duplicate-id',
          assets: [getForDuplicate(smallAsset), getForDuplicate(largeAsset)],
        },
      ]);
      const result = await sut.getDuplicates(authStub.admin);
      expect(result[0].suggestedKeepAssetIds).toEqual([largeAsset.id]);
    });
  });

  describe('Library care → Group near-duplicates for review (FL-69)', () => {
    beforeEach(() => {
      clearConfigCache();
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { enabled: true, duplicateDetection: { enabled: true } },
        libraryCare: { duplicateReview: false },
      });
    });

    it('queues no grouping while it is off', async () => {
      await expect(sut.handleQueueSearchDuplicates({})).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('groups nothing while it is off', async () => {
      await expect(sut.handleSearchDuplicates({ id: newUuid() })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.assetJob.getForSearchDuplicatesJob).not.toHaveBeenCalled();
    });
  });

  describe('handleQueueSearchDuplicates', () => {
    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          duplicateDetection: {
            enabled: true,
          },
        },
      });
    });

    it('should skip if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: false,
          duplicateDetection: {
            enabled: true,
          },
        },
      });

      await expect(sut.handleQueueSearchDuplicates({})).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('should skip if duplicate detection is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          duplicateDetection: {
            enabled: false,
          },
        },
      });

      await expect(sut.handleQueueSearchDuplicates({})).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.get).toHaveBeenCalled();
    });

    it('should queue missing assets', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.selectionForSearchDuplicates.mockReturnValue({ selected: [asset] } as never);

      await sut.handleQueueSearchDuplicates({});

      expect(mocks.assetJob.selectionForSearchDuplicates).toHaveBeenCalledWith(undefined);
      expect(mocks.job.queueSelection).toHaveBeenCalledWith(
        JobName.AssetDetectDuplicates,
        mocks.assetJob.selectionForSearchDuplicates.mock.results[0].value,
      );
    });

    it('should queue all assets', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.selectionForSearchDuplicates.mockReturnValue({ selected: [asset] } as never);

      await sut.handleQueueSearchDuplicates({ force: true });

      expect(mocks.assetJob.selectionForSearchDuplicates).toHaveBeenCalledWith(true);
      expect(mocks.job.queueSelection).toHaveBeenCalledWith(
        JobName.AssetDetectDuplicates,
        mocks.assetJob.selectionForSearchDuplicates.mock.results[0].value,
      );
    });
  });

  describe('handleQueueVideoFingerprints', () => {
    it('should queue videos without a fingerprint', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.selectionForVideoFingerprint.mockReturnValue({ selected: [asset] } as never);

      await expect(sut.handleQueueVideoFingerprints({})).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.selectionForVideoFingerprint).toHaveBeenCalledWith(undefined);
      expect(mocks.job.queueSelection).toHaveBeenCalledWith(
        JobName.AssetVideoFingerprint,
        mocks.assetJob.selectionForVideoFingerprint.mock.results[0].value,
      );
    });

    it('should skip when video comparison is off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { duplicateDetection: { enhancedVideo: { enabled: false } } },
      });

      await expect(sut.handleQueueVideoFingerprints({})).resolves.toBe(JobStatus.Skipped);
      expect(mocks.assetJob.selectionForVideoFingerprint).not.toHaveBeenCalled();
    });
  });

  describe('retired video duplicate frame jobs', () => {
    it('should change nothing for jobs queued before the upgrade', async () => {
      await expect(sut.handleQueueGenerateVideoDuplicateFrames()).resolves.toBe(JobStatus.Skipped);
      await expect(sut.handleGenerateVideoDuplicateFrames()).resolves.toBe(JobStatus.Skipped);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should throw for an unknown or unauthorized group id', async () => {
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.delete(authStub.admin, 'group-1')).rejects.toThrow(BadRequestException);
      expect(mocks.duplicateRepository.delete).not.toHaveBeenCalled();
    });

    it('should dismiss the duplicate group', async () => {
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.duplicateRepository.delete.mockResolvedValue();
      await expect(sut.delete(authStub.admin, 'group-1')).resolves.toBeUndefined();
      expect(mocks.duplicateRepository.delete).toHaveBeenCalledWith(authStub.admin.user.id, 'group-1');
    });
  });

  describe('deleteAll', () => {
    it('should throw if any group id is unknown or unauthorized', async () => {
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      await expect(sut.deleteAll(authStub.admin, { ids: ['group-1', 'group-2'] })).rejects.toThrow(BadRequestException);
      expect(mocks.duplicateRepository.deleteAll).not.toHaveBeenCalled();
    });

    it('should dismiss all duplicate groups', async () => {
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1', 'group-2']));
      mocks.duplicateRepository.deleteAll.mockResolvedValue();
      await expect(sut.deleteAll(authStub.admin, { ids: ['group-1', 'group-2'] })).resolves.toBeUndefined();
      expect(mocks.duplicateRepository.deleteAll).toHaveBeenCalledWith(authStub.admin.user.id, ['group-1', 'group-2']);
    });
  });

  describe('resolve', () => {
    it('should handle mixed success and failure', async () => {
      const asset = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockImplementation((_owner, ids) =>
        Promise.resolve(new Set([...ids].filter((id) => ['group-1', 'group-2'].includes(id)))),
      );
      mocks.duplicateRepository.get.mockResolvedValueOnce(void 0);
      mocks.duplicateRepository.get.mockResolvedValueOnce({
        duplicateId: 'group-2',
        assets: [asset as unknown as MapAsset],
      });

      await expect(
        sut.resolve(authStub.admin, {
          groups: [
            { duplicateId: 'group-1', keepAssetIds: [], trashAssetIds: [] },
            { duplicateId: 'group-2', keepAssetIds: [asset.id], trashAssetIds: [] },
          ],
        }),
      ).resolves.toEqual([
        { id: 'group-1', success: false, error: BulkIdErrorReason.NOT_FOUND },
        { id: 'group-2', success: true },
      ]);
    });

    it('should catch and report errors', async () => {
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.duplicateRepository.get.mockRejectedValue(new Error('Database error'));

      await expect(
        sut.resolve(authStub.admin, {
          groups: [{ duplicateId: 'group-1', keepAssetIds: [], trashAssetIds: [] }],
        }),
      ).resolves.toEqual([{ id: 'group-1', success: false, error: BulkIdErrorReason.UNKNOWN }]);
    });
  });

  describe('resolveGroup (via resolve)', () => {
    it('attaches a proven motion reference before trashing the JPEG and retains its original link', async () => {
      const keeper = AssetFactory.from({ originalFileName: 'capture.HEIC' }).build();
      const jpeg = AssetFactory.from({ livePhotoVideoId: 'proven-motion' }).build();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.access.asset.checkOwnerAccess.mockImplementation((_owner, ids) => Promise.resolve(ids));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [keeper, jpeg] as unknown as MapAsset[],
      });
      mocks.duplicateRepository.findMotionTransfer.mockResolvedValue('proven-motion');
      const [result] = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: [keeper.id], trashAssetIds: [jpeg.id] }],
      });
      expect(result.success).toBe(true);
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: keeper.id, livePhotoVideoId: 'proven-motion' });
      expect(mocks.asset.update.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.asset.updateAll.mock.invocationCallOrder[0],
      );
      expect(mocks.asset.updateAll).not.toHaveBeenCalledWith(
        [jpeg.id],
        expect.objectContaining({ livePhotoVideoId: null }),
      );
    });
    it('retains committed success and a durable receipt when sidecar work fails, while attempting disposal events', async () => {
      const keeper = AssetFactory.create();
      const disposable = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([disposable.id]));
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-1']));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [
          { ...keeper, tags: [] },
          { ...disposable, tags: [{ id: 'tag-1', value: 'Travel' }] },
        ] as unknown as MapAsset[],
      });
      mocks.job.queueAll.mockRejectedValue(new Error('queue unavailable'));
      const [result] = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: [keeper.id], trashAssetIds: [disposable.id] }],
      });
      expect(result.success).toBe(true);
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTrashAll', {
        assetIds: [disposable.id],
        userId: authStub.admin.user.id,
      });
      expect(mocks.job.removeJob).not.toHaveBeenCalled();
      const [, receipt] = mocks.job.queueInTransaction.mock.calls[0];
      expect(receipt).toMatchObject({
        name: JobName.DuplicateResolutionLifecycle,
        data: { sidecarIds: [keeper.id], trashIds: [disposable.id] },
      });
      mocks.job.queueAll.mockResolvedValue(undefined);
      await expect(sut.handleResolutionLifecycle(receipt.data as never)).resolves.toBe(JobStatus.Success);
    });

    it.each([{ isEdited: true }, { livePhotoVideoId: 'unique-motion' }])(
      'refuses disposal of protected content %j before mutating anything',
      async (protectedFields) => {
        const keeper = AssetFactory.create();
        const disposable = AssetFactory.create(protectedFields);
        mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([disposable.id]));
        mocks.duplicateRepository.get.mockResolvedValue({
          duplicateId: 'group-1',
          assets: [keeper, disposable] as unknown as MapAsset[],
        });
        const result = await sut.resolve(authStub.admin, {
          groups: [{ duplicateId: 'group-1', keepAssetIds: [keeper.id], trashAssetIds: [disposable.id] }],
        });
        expect(result[0]).toMatchObject({ success: false, error: BulkIdErrorReason.VALIDATION });
        expect(mocks.asset.updateAll).not.toHaveBeenCalled();
        expect(mocks.album.addAssetIdsToAlbums).not.toHaveBeenCalled();
      },
    );

    it.each([AssetType.Image, AssetType.Video])('protects historical %s edits even after reset', async (type) => {
      const keeper = AssetFactory.create();
      const disposable = AssetFactory.create({ isEdited: false, type });
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([disposable.id]));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [keeper, disposable] as unknown as MapAsset[],
      });
      mocks.assetDevelop.getAssetIdsWithHistory.mockResolvedValue(new Set([disposable.id]));
      const result = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: [keeper.id], trashAssetIds: [disposable.id] }],
      });
      expect(result[0]).toMatchObject({ success: false, error: BulkIdErrorReason.VALIDATION });
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('should fail if duplicate group not found', async () => {
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['missing-id']));
      mocks.duplicateRepository.get.mockResolvedValue(void 0);

      await expect(
        sut.resolve(authStub.admin, {
          groups: [{ duplicateId: 'missing-id', keepAssetIds: [], trashAssetIds: [] }],
        }),
      ).resolves.toEqual([
        {
          id: 'missing-id',
          success: false,
          error: BulkIdErrorReason.NOT_FOUND,
        },
      ]);
    });

    it('should resolve only visible duplicate assets when NSFW assets are hidden', async () => {
      const asset = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [asset as unknown as MapAsset],
      });

      await expect(
        sut.resolve(
          { ...authStub.admin, hideNsfwAssets: true },
          {
            groups: [{ duplicateId: 'group-1', keepAssetIds: [asset.id], trashAssetIds: [] }],
          },
        ),
      ).resolves.toEqual([{ id: 'group-1', success: true }]);

      expect(mocks.access.duplicate.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set(['group-1']),
        true,
      );
      expect(mocks.duplicateRepository.get).toHaveBeenCalledWith('group-1', { excludeNsfw: true });
    });

    it('should reject when keepAssetIds contains non-member (server.md Medium #nsfwOptions)', async () => {
      // Security fix: previously this silently dropped non-member IDs, which
      // would let an attacker probe for NSFW-hidden asset IDs by guessing.
      // Now we reject the whole group with a NOT_FOUND error.
      const asset = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [asset as unknown as MapAsset],
      });

      const result = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: ['asset-999', asset.id], trashAssetIds: [] }],
      });
      expect(result[0].success).toBe(false);
      expect(result[0].errorMessage).toMatch(/not part of this duplicate group/);
    });

    it('should reject when trashAssetIds contains non-member (server.md Medium #nsfwOptions)', async () => {
      const asset = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [asset as unknown as MapAsset],
      });

      const result = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: [asset.id], trashAssetIds: ['asset-999'] }],
      });
      expect(result[0].success).toBe(false);
      expect(result[0].errorMessage).toMatch(/not part of this duplicate group/);
    });

    it('should fail if keepAssetIds and trashAssetIds overlap', async () => {
      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [asset1 as unknown as MapAsset, asset2 as unknown as MapAsset],
      });

      const result = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: [asset1.id], trashAssetIds: [asset1.id] }],
      });

      expect(result[0].success).toBe(false);
      expect(result[0].errorMessage).toContain('An asset cannot be in both keepAssetIds and trashAssetIds');
    });

    it('should fail if keepAssetIds and trashAssetIds do not cover all assets', async () => {
      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();
      const asset3 = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [asset1 as unknown as MapAsset, asset2 as unknown as MapAsset, asset3 as unknown as MapAsset],
      });

      const result = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: [asset1.id], trashAssetIds: [asset2.id] }],
      });

      expect(result[0].success).toBe(false);
      expect(result[0].errorMessage).toContain('Every asset must be in either keepAssetIds or trashAssetIds');
    });

    it('should fail if partial trash without keepers', async () => {
      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [asset1 as unknown as MapAsset, asset2 as unknown as MapAsset],
      });

      const result = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: [], trashAssetIds: [asset1.id] }],
      });

      expect(result[0].success).toBe(false);
      expect(result[0].errorMessage).toContain('Every asset must be in either keepAssetIds or trashAssetIds');
    });

    it('should sync merged tags to asset_exif.tags', async () => {
      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset2.id]));
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set(['tag-1', 'tag-2']));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [
          {
            ...asset1,
            tags: [
              {
                id: 'tag-1',
                value: 'Work',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                parentId: null,
                color: null,
              },
            ],
          },
          {
            ...asset2,
            tags: [
              {
                id: 'tag-2',
                value: 'Travel',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                parentId: null,
                color: null,
              },
            ],
          },
        ] as any,
      });

      const result = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: [asset1.id], trashAssetIds: [asset2.id] }],
      });

      expect(result[0].success).toBe(true);

      // Verify tags were applied to tag_asset table
      expect(mocks.tag.replaceAssetTags).toHaveBeenCalledWith(asset1.id, ['tag-1', 'tag-2']);

      // Verify merged tag values were written to asset_exif.tags so SidecarWrite preserves them
      expect(mocks.asset.updateAllExif).toHaveBeenCalledWith([asset1.id], { tags: ['Work', 'Travel'] });

      // Verify SidecarWrite was queued (to write tags to sidecar)
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.SidecarWrite, data: { id: asset1.id } }]);
    });

    it.each([
      { latitudes: [-0, 0, NaN, Infinity], expected: 0 },
      { latitudes: [12, 12, NaN, -Infinity], expected: 12 },
      { latitudes: [12, 13, 12], expected: null },
      { latitudes: [NaN, Infinity], expected: null },
    ])('merges only unanimous finite coordinates: $latitudes', async ({ latitudes, expected }) => {
      const assets = latitudes.map((latitude) => AssetFactory.from().exif({ latitude, longitude: 21 }).build());
      const [keeper, ...removed] = assets;
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(removed.map(({ id }) => id)));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: assets as unknown as MapAsset[],
      });
      await expect(
        sut.resolve(authStub.admin, {
          groups: [{ duplicateId: 'group-1', keepAssetIds: [keeper.id], trashAssetIds: removed.map(({ id }) => id) }],
        }),
      ).resolves.toEqual([{ id: 'group-1', success: true }]);
      const updates = mocks.asset.updateAllExif.mock.calls.map(([, update]) => update);
      if (expected === null) {
        expect(updates.every((update) => !('latitude' in update) && !('longitude' in update))).toBe(true);
      } else {
        expect(updates).toContainEqual(expect.objectContaining({ latitude: expected, longitude: 21 }));
        expect(updates.find((update) => 'latitude' in update)?.latitude).toBe(expected);
      }
    });

    it('merges trimmed description lines in first-seen order without duplicates', async () => {
      const keeper = AssetFactory.from().exif({ description: ' first \r\nsecond\n\n' }).build();
      const removed = AssetFactory.from().exif({ description: '\tsecond\n third \nfirst\n' }).build();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([removed.id]));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [keeper as unknown as MapAsset, removed as unknown as MapAsset],
      });
      await expect(
        sut.resolve(authStub.admin, {
          groups: [{ duplicateId: 'group-1', keepAssetIds: [keeper.id], trashAssetIds: [removed.id] }],
        }),
      ).resolves.toEqual([{ id: 'group-1', success: true }]);
      expect(mocks.asset.updateAllExif).toHaveBeenCalledWith(
        [keeper.id],
        expect.objectContaining({ description: 'first\nsecond\nthird' }),
      );
    });

    it('should not merge metadata when multiple assets are kept', async () => {
      const asset1 = AssetFactory.create({ isFavorite: true });
      const asset2 = AssetFactory.create();
      mocks.access.duplicate.checkOwnerAccess.mockResolvedValue(new Set(['group-1']));
      mocks.duplicateRepository.get.mockResolvedValue({
        duplicateId: 'group-1',
        assets: [asset1 as unknown as MapAsset, asset2 as unknown as MapAsset],
      });

      const result = await sut.resolve(authStub.admin, {
        groups: [{ duplicateId: 'group-1', keepAssetIds: [asset1.id, asset2.id], trashAssetIds: [] }],
      });

      expect(result[0].success).toBe(true);
      expect(mocks.album.addAssetIdsToAlbums).not.toHaveBeenCalled();
      expect(mocks.tag.replaceAssetTags).not.toHaveBeenCalled();
      expect(mocks.asset.updateAllExif).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset1.id, asset2.id], { duplicateId: null });
    });

    // NOTE: The following integration-style tests are covered by E2E tests instead
    // to avoid complex mock setup. The validation and error-handling logic above
    // is thoroughly unit tested.
  });

  describe('handleSearchDuplicates', () => {
    it('does not publish duplicate groups after an index transition refusal', async () => {
      mocks.machineLearning.captureClipRead.mockResolvedValue({
        assertCurrent: () => Promise.resolve(),
        publish: () => Promise.reject(new Error('desktop_clip_index_changed')),
      });
      await expect(sut.handleSearchDuplicates({ id: 'asset' })).rejects.toThrow('desktop_clip_index_changed');
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          duplicateDetection: {
            enabled: true,
          },
        },
      });
    });

    it('should skip if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: false,
          duplicateDetection: {
            enabled: true,
          },
        },
      });
      const result = await sut.handleSearchDuplicates({ id: newUuid() });

      expect(result).toBe(JobStatus.Skipped);
      expect(mocks.assetJob.getForSearchDuplicatesJob).not.toHaveBeenCalled();
    });

    it('should skip if duplicate detection is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          enabled: true,
          duplicateDetection: {
            enabled: false,
          },
        },
      });
      const result = await sut.handleSearchDuplicates({ id: newUuid() });

      expect(result).toBe(JobStatus.Skipped);
      expect(mocks.assetJob.getForSearchDuplicatesJob).not.toHaveBeenCalled();
    });

    it('should fail if asset is not found', async () => {
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(void 0);

      const asset = AssetFactory.create();
      const result = await sut.handleSearchDuplicates({ id: asset.id });

      expect(result).toBe(JobStatus.Failed);
      expect(mocks.logger.error).toHaveBeenCalledWith(`Asset ${asset.id} not found`);
    });

    it('should skip if asset is part of stack', async () => {
      const asset = AssetFactory.from().stack().build();
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue({ ...hasEmbedding, stackId: asset.stackId });

      const result = await sut.handleSearchDuplicates({ id: asset.id });

      expect(result).toBe(JobStatus.Skipped);
      expect(mocks.logger.debug).toHaveBeenCalledWith(`Asset ${asset.id} is part of a stack, skipping`);
    });

    it('should skip if asset is not visible', async () => {
      const asset = AssetFactory.create({ visibility: AssetVisibility.Hidden });
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue({ ...hasEmbedding, ...asset });

      const result = await sut.handleSearchDuplicates({ id: asset.id });

      expect(result).toBe(JobStatus.Skipped);
      expect(mocks.logger.debug).toHaveBeenCalledWith(`Asset ${asset.id} is not visible, skipping`);
    });

    it('should fail if asset is missing embedding', async () => {
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue({ ...hasEmbedding, embedding: null });

      const asset = AssetFactory.create();
      const result = await sut.handleSearchDuplicates({ id: asset.id });

      expect(result).toBe(JobStatus.Failed);
      expect(mocks.logger.debug).toHaveBeenCalledWith(`Asset ${asset.id} is missing embedding`);
    });

    it('should search for duplicates and update asset with duplicateId', async () => {
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(hasEmbedding);
      const asset = AssetFactory.create();
      mocks.duplicateRepository.search.mockResolvedValue([{ assetId: asset.id, distance: 0.01, duplicateId: null }]);
      mocks.duplicateRepository.merge.mockResolvedValue();
      const expectedAssetIds = [asset.id, hasEmbedding.id];

      const result = await sut.handleSearchDuplicates({ id: hasEmbedding.id });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.duplicateRepository.search).toHaveBeenCalledWith({
        assetId: hasEmbedding.id,
        embedding: hasEmbedding.embedding,
        maxDistance: 0.01,
        type: hasEmbedding.type,
        userIds: [hasEmbedding.ownerId],
      });
      expect(mocks.duplicateRepository.merge).toHaveBeenCalledWith({
        assetIds: expectedAssetIds,
        targetId: expect.any(String),
        sourceIds: [],
      });
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith(
        ...expectedAssetIds.map((assetId) => ({ assetId, duplicatesDetectedAt: expect.any(Date) })),
      );
    });

    it('should use existing duplicate ID among matched duplicates', async () => {
      const duplicateId = hasDupe.duplicateId;
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(hasEmbedding);
      mocks.duplicateRepository.search.mockResolvedValue([{ assetId: hasDupe.id, distance: 0.01, duplicateId }]);
      mocks.duplicateRepository.merge.mockResolvedValue();
      const expectedAssetIds = [hasEmbedding.id];

      const result = await sut.handleSearchDuplicates({ id: hasEmbedding.id });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.duplicateRepository.search).toHaveBeenCalledWith({
        assetId: hasEmbedding.id,
        embedding: hasEmbedding.embedding,
        maxDistance: 0.01,
        type: hasEmbedding.type,
        userIds: [hasEmbedding.ownerId],
      });
      expect(mocks.duplicateRepository.merge).toHaveBeenCalledWith({
        assetIds: expectedAssetIds,
        targetId: duplicateId,
        sourceIds: [],
      });
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith(
        ...expectedAssetIds.map((assetId) => ({ assetId, duplicatesDetectedAt: expect.any(Date) })),
      );
    });

    it('does not merge the existing target group back into itself', async () => {
      const asset = { ...hasEmbedding, duplicateId: 'existing-group' };
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(asset);
      mocks.duplicateRepository.search.mockResolvedValue([
        { assetId: 'same-group', distance: 0.01, duplicateId: 'existing-group' },
        { assetId: 'other-group-a', distance: 0.01, duplicateId: 'other-group' },
        { assetId: 'ungrouped', distance: 0.01, duplicateId: null },
        { assetId: 'other-group-b', distance: 0.01, duplicateId: 'other-group' },
      ]);
      mocks.duplicateRepository.merge.mockResolvedValue();
      await expect(sut.handleSearchDuplicates({ id: asset.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.duplicateRepository.merge).toHaveBeenCalledWith({
        targetId: 'existing-group',
        sourceIds: ['other-group'],
        assetIds: ['other-group-a', 'ungrouped', 'other-group-b', asset.id],
      });
    });

    it('keeps existing members out of source groups when every match already belongs to the target', async () => {
      const asset = { ...hasEmbedding, duplicateId: 'existing-group' };
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(asset);
      mocks.duplicateRepository.search.mockResolvedValue([
        { assetId: 'same-group', distance: 0.01, duplicateId: 'existing-group' },
      ]);
      mocks.duplicateRepository.merge.mockResolvedValue();
      await expect(sut.handleSearchDuplicates({ id: asset.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.duplicateRepository.merge).toHaveBeenCalledWith({
        targetId: 'existing-group',
        sourceIds: [],
        assetIds: [asset.id],
      });
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: asset.id,
        duplicatesDetectedAt: expect.any(Date),
      });
    });

    it('should fingerprint the video first and defer grouping when it has none', async () => {
      const video = { ...hasEmbedding, type: AssetType.Video };
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(video);
      mocks.duplicateRepository.search.mockResolvedValue([{ assetId: 'asset-2', distance: 0.01, duplicateId: null }]);
      mocks.duplicateRepository.getVideoFingerprints.mockResolvedValue([]);

      await expect(sut.handleSearchDuplicates({ id: video.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetVideoFingerprint, data: { id: video.id } });
      expect(mocks.duplicateRepository.searchVideoFingerprints).not.toHaveBeenCalled();
      expect(mocks.duplicateRepository.merge).not.toHaveBeenCalled();
    });

    it('should fingerprint candidates that have none and not group them yet', async () => {
      const video = { ...hasEmbedding, type: AssetType.Video };
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(video);
      mocks.duplicateRepository.search.mockResolvedValue([{ assetId: 'asset-2', distance: 0.01, duplicateId: null }]);
      mocks.duplicateRepository.getVideoFingerprints.mockImplementation((ids) =>
        Promise.resolve(ids.includes(video.id) ? [{ assetId: video.id, ...timeline(1) }] : []),
      );
      mocks.duplicateRepository.searchVideoFingerprints.mockResolvedValue([]);

      await expect(sut.handleSearchDuplicates({ id: video.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetVideoFingerprint, data: { id: 'asset-2' } },
      ]);
      expect(mocks.duplicateRepository.merge).not.toHaveBeenCalled();
    });

    it('should not group videos whose timelines do not line up', async () => {
      const video = { ...hasEmbedding, type: AssetType.Video };
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(video);
      mocks.duplicateRepository.search.mockResolvedValue([{ assetId: 'asset-2', distance: 0.01, duplicateId: null }]);
      mocks.duplicateRepository.getVideoFingerprints.mockImplementation((ids) =>
        Promise.resolve(
          ids.includes(video.id) ? [{ assetId: video.id, ...timeline(1) }] : [{ assetId: 'asset-2', ...timeline(2) }],
        ),
      );
      mocks.duplicateRepository.searchVideoFingerprints.mockResolvedValue([]);

      await expect(sut.handleSearchDuplicates({ id: video.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.duplicateRepository.merge).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: video.id,
        duplicatesDetectedAt: expect.any(Date),
      });
    });

    it('should group a copy found by its middle frames when the preview does not match', async () => {
      const video = { ...hasEmbedding, type: AssetType.Video };
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(video);
      mocks.duplicateRepository.search.mockResolvedValue([]);
      mocks.duplicateRepository.getVideoFingerprints.mockImplementation((ids) =>
        Promise.resolve(
          ids.includes(video.id) ? [{ assetId: video.id, ...timeline(1) }] : [{ assetId: 'asset-2', ...timeline(1) }],
        ),
      );
      mocks.duplicateRepository.searchVideoFingerprints.mockResolvedValue([
        { assetId: 'asset-2', distance: 0, duplicateId: null },
      ]);
      mocks.duplicateRepository.merge.mockResolvedValue();

      await expect(sut.handleSearchDuplicates({ id: video.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.duplicateRepository.searchVideoFingerprints).toHaveBeenCalledWith({
        assetId: video.id,
        hashes: expect.any(Array),
        maxBits: 8,
        userIds: [video.ownerId],
      });
      expect(mocks.duplicateRepository.merge).toHaveBeenCalledWith({
        assetIds: ['asset-2', video.id],
        targetId: expect.any(String),
        sourceIds: [],
      });
    });

    it('should remove duplicateId if no duplicates found and asset has duplicateId', async () => {
      mocks.assetJob.getForSearchDuplicatesJob.mockResolvedValue(hasDupe);
      mocks.duplicateRepository.search.mockResolvedValue([]);

      const result = await sut.handleSearchDuplicates({ id: hasDupe.id });

      expect(result).toBe(JobStatus.Success);
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: hasDupe.id, duplicateId: null });
      expect(mocks.asset.upsertJobStatus).toHaveBeenCalledWith({
        assetId: hasDupe.id,
        duplicatesDetectedAt: expect.any(Date),
      });
    });
  });

  describe('look-alike estimate and comparing again (FL-520)', () => {
    it('estimates the groups each choice makes and how long comparing again takes, from a sample', async () => {
      mocks.duplicateRepository.sampleNearestDistances.mockResolvedValue([0.002, 0.008, 0.02, 0.05, Infinity]);
      mocks.duplicateRepository.countComparable.mockResolvedValue({ comparable: 1000, groups: 10, grouped: 30 });

      const estimate = await sut.estimateLookAlikes({ maxDistances: [0.004, 0.01, 0.03] });

      // 1, 2 and 3 of 5 sampled photos have a look-alike; groups so far hold three photos each.
      expect(estimate).toEqual(
        expect.objectContaining({
          comparable: 1000,
          groups: 10,
          sampled: 5,
          choices: [
            { maxDistance: 0.004, groups: 67 },
            { maxDistance: 0.01, groups: 133 },
            { maxDistance: 0.03, groups: 200 },
          ],
        }),
      );
      expect(estimate.seconds).toBeGreaterThanOrEqual(0);
    });

    it('says nothing is grouped when nothing can be compared', async () => {
      mocks.duplicateRepository.sampleNearestDistances.mockResolvedValue([]);
      mocks.duplicateRepository.countComparable.mockResolvedValue({ comparable: 0, groups: 0, grouped: 0 });

      await expect(sut.estimateLookAlikes({ maxDistances: [0.01] })).resolves.toEqual({
        comparable: 0,
        groups: 0,
        sampled: 0,
        seconds: 0,
        choices: [{ maxDistance: 0.01, groups: 0 }],
      });
    });

    it('compares every photo again now, or leaves the request for the overnight run', async () => {
      await sut.recompare({ when: 'now' });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetDetectDuplicatesQueueAll,
        data: { force: true },
      });

      mocks.job.queue.mockClear();
      await sut.recompare({ when: 'tonight' });
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.DuplicateRecompare, {
        requestedAt: expect.any(String),
      });
    });
  });
});
