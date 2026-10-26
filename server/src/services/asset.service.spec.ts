import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { mkdirSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFile } from 'src/database.js';
import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { AssetJobName, AssetStatsResponseDto } from 'src/dtos/asset.dto.js';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetEditAction, type AssetEditActionItem, VideoTrimMode } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetLockReason,
  AssetMetadataKey,
  AssetPathType,
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  Permission,
  StorageFolder,
} from 'src/enum.js';
import { AssetStats, RemovedAsset } from 'src/repositories/asset.repository.js';
import { AssetOriginField } from 'src/repositories/partner-origin.repository.js';
import { AssetService } from 'src/services/asset.service.js';
import { tryPromise } from 'src/utils/promise.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForAsset, getForAssetDeletion } from 'test/mappers.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const stats: AssetStats = {
  [AssetType.Image]: 10,
  [AssetType.Video]: 23,
  [AssetType.Audio]: 0,
  [AssetType.Other]: 0,
};

const statResponse: AssetStatsResponseDto = {
  images: 10,
  videos: 23,
  total: 33,
};

describe(AssetService.name, () => {
  let sut: AssetService;
  let mocks: ServiceMocks;
  /** What the mocked removal reports beyond the asset's own original and generated files. */
  let removedExtras: Partial<RemovedAsset>;

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AssetService));
    mocks.mediaOperation.create.mockResolvedValue({ id: 'op-1' } as never);
    mocks.partner.getAll.mockResolvedValue([]);
    mocks.duplicateRepository.getVideoDuplicateFrames.mockResolvedValue([]);
    mocks.partnerOrigin.getOriginLabels.mockResolvedValue(new Map());
    mocks.partnerOrigin.withOriginEdit.mockImplementation(async (_kind, _ids, _fields, write) => write());
    mocks.search.getAssetLandmarks.mockResolvedValue([]);
    mocks.map.getLandmarkIcons.mockReturnValue(new Map());
    removedExtras = {};
    // the file cleanup is queued inside the removal's transaction, from the files the repository reads
    // there, as the repository does
    mocks.asset.remove.mockImplementation(async (asset, release) => {
      const deletion = asset as unknown as { originalPath: string; files?: AssetFile[] };
      const removed: RemovedAsset = {
        originalPath: deletion.originalPath,
        reservationTemporaryPath: null,
        files: deletion.files ?? [],
        videoDuplicateFramePaths: [],
        derivedPaths: [],
        pendingMoves: [],
        ...removedExtras,
      };
      if (release) {
        await release.queue(release.files(removed));
      }
      return removed;
    });
  });

  describe('durable metadata lock effects', () => {
    it('retries profile/thumbnail followup and owner updates without a stale blanket lock event', async () => {
      mocks.person.getMissingThumbnailsForAssets.mockResolvedValue([]);
      mocks.user.getLockedProfileImageSources.mockResolvedValue([]);
      await sut.onAssetLocalEffects({
        origin: { kind: 'lock' },
        ownerId: 'owner',
        lockedCascade: { assetIds: ['asset'], interactiveAdmissions: [] },
      } as never);
      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith(['asset']);
      expect(mocks.user.getLockedProfileImageSources).toHaveBeenCalled();
      expect(mocks.asset.getByIdsWithAllRelationsButStacks).toHaveBeenCalledWith(['asset'], 'owner');
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetLocked', expect.anything());
    });

    it('propagates a failed followup so the durable dispatcher cannot acknowledge it', async () => {
      mocks.person.getMissingThumbnailsForAssets.mockResolvedValue([{ ownerId: 'owner', personGroupId: 'person' }]);
      mocks.job.queueAll.mockRejectedValueOnce(new Error('thumbnail admission failed'));
      await expect(
        sut.onAssetLocalEffects({
          origin: { kind: 'lock' },
          ownerId: 'owner',
          lockedCascade: { assetIds: ['asset'], interactiveAdmissions: [] },
        } as never),
      ).rejects.toThrow('thumbnail admission failed');
    });

    it('ignores effects that contain no lock cascade', async () => {
      await sut.onAssetLocalEffects({ origin: { kind: 'publication' }, ownerId: 'owner' } as never);
      expect(mocks.person.getMissingThumbnailsForAssets).not.toHaveBeenCalled();
      expect(mocks.user.getLockedProfileImageSources).not.toHaveBeenCalled();
    });

    it('also follows up real lock cascades produced by existing publication effects', async () => {
      mocks.person.getMissingThumbnailsForAssets.mockResolvedValue([]);
      mocks.user.getLockedProfileImageSources.mockResolvedValue([]);
      await sut.onAssetLocalEffects({
        origin: { kind: 'publication' },
        ownerId: 'owner',
        lockedCascade: { assetIds: ['asset'], interactiveAdmissions: [] },
      } as never);
      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith(['asset']);
      expect(mocks.user.getLockedProfileImageSources).toHaveBeenCalled();
    });
  });

  describe('getStatistics', () => {
    it('should get the statistics for a user, excluding archived assets', async () => {
      const auth = AuthFactory.create();
      mocks.asset.getStatistics.mockResolvedValue(stats);
      await expect(sut.getStatistics(auth, { visibility: AssetVisibility.Timeline })).resolves.toEqual(statResponse);
      expect(mocks.asset.getStatistics).toHaveBeenCalledWith(auth.user.id, { visibility: AssetVisibility.Timeline });
    });

    it('should get the statistics for a user for archived assets', async () => {
      const auth = AuthFactory.create();
      mocks.asset.getStatistics.mockResolvedValue(stats);
      await expect(sut.getStatistics(auth, { visibility: AssetVisibility.Archive })).resolves.toEqual(statResponse);
      expect(mocks.asset.getStatistics).toHaveBeenCalledWith(auth.user.id, {
        visibility: AssetVisibility.Archive,
      });
    });

    it('should get the statistics for a user for favorite assets', async () => {
      const auth = AuthFactory.create();
      mocks.asset.getStatistics.mockResolvedValue(stats);
      await expect(sut.getStatistics(auth, { isFavorite: true })).resolves.toEqual(statResponse);
      expect(mocks.asset.getStatistics).toHaveBeenCalledWith(auth.user.id, { isFavorite: true });
    });

    it('should get the statistics for a user for all assets', async () => {
      const auth = AuthFactory.create();
      mocks.asset.getStatistics.mockResolvedValue(stats);
      await expect(sut.getStatistics(auth, {})).resolves.toEqual(statResponse);
      expect(mocks.asset.getStatistics).toHaveBeenCalledWith(auth.user.id, {});
    });

    it('should exclude NSFW assets when privacy hiding is active', async () => {
      const auth = { ...AuthFactory.create(), hideNsfwAssets: true };
      mocks.asset.getStatistics.mockResolvedValue(stats);

      await expect(sut.getStatistics(auth, { visibility: AssetVisibility.Timeline })).resolves.toEqual(statResponse);

      expect(mocks.asset.getStatistics).toHaveBeenCalledWith(auth.user.id, {
        visibility: AssetVisibility.Timeline,
        excludeNsfw: true,
      });
    });
  });

  describe('get', () => {
    it("names the partner library the viewer's own copy came from (FL-326)", async () => {
      const asset = AssetFactory.create();
      const auth = AuthFactory.create({ id: asset.ownerId });
      const rootOwnerId = newUuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.partnerOrigin.getOriginLabels.mockResolvedValue(
        new Map([[asset.id, { rootOwnerId, rootOwnerName: 'Jamie' }]]),
      );

      await expect(sut.get(auth, asset.id)).resolves.toMatchObject({ origin: { rootOwnerId, rootOwnerName: 'Jamie' } });
      expect(mocks.partnerOrigin.getOriginLabels).toHaveBeenCalledWith('asset', [asset.id], asset.ownerId);
    });

    it("never names an origin on an asset that is not the viewer's own (FL-326)", async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      const result = await sut.get(authStub.admin, asset.id);
      expect(result).not.toHaveProperty('origin');
      expect(mocks.partnerOrigin.getOriginLabels).not.toHaveBeenCalled();
    });

    it('should allow owner access', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.get(authStub.admin, asset.id);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set([asset.id]),
        undefined,
      );
    });

    it('should name the viewer as the Locked owner of the stack read only when elevated (FL-34)', async () => {
      const asset = AssetFactory.create();
      const ordinary = AuthFactory.create({ id: asset.ownerId });
      const elevated = AuthFactory.from({ id: asset.ownerId }).session({ hasElevatedPermission: true }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.get(ordinary, asset.id);
      expect(mocks.asset.getById).toHaveBeenLastCalledWith(
        asset.id,
        expect.objectContaining({ stack: { assets: true } }),
      );

      await sut.get(elevated, asset.id);
      expect(mocks.asset.getById).toHaveBeenLastCalledWith(
        asset.id,
        expect.objectContaining({ stack: { assets: true, lockedOwnerId: asset.ownerId } }),
      );
    });

    it('should name the landmarks a located asset was taken at, and none when its location is hidden', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.from({ ownerId: auth.user.id }).exif({ latitude: 48.8584, longitude: 2.2945 }).build();
      const landmarks = [
        { id: 'Q243', name: 'Eiffel Tower', kind: 'tower' },
        { id: 'Q217925', name: 'Champ de Mars', kind: 'park' },
      ];
      const icon = { background: '#ffffff', tile: false };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.search.getAssetLandmarks.mockResolvedValue(landmarks);
      mocks.map.getLandmarkIcons.mockReturnValue(new Map([['Q243', icon]]));

      // only the landmark with a brand icon says how to draw one
      await expect(sut.get(auth, asset.id)).resolves.toMatchObject({
        landmarks: [
          { ...landmarks[0], icon },
          { ...landmarks[1], icon: undefined },
        ],
      });

      const unlocated = AssetFactory.from({ ownerId: auth.user.id }).exif({ latitude: null, longitude: null }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([unlocated.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(unlocated));
      const response = (await sut.get(auth, unlocated.id)) as AssetResponseDto;
      expect(response.landmarks).toBeUndefined();
    });

    it("should keep the location on someone else's asset seen through an album (FL-326)", async () => {
      const auth = AuthFactory.create();
      const sharer = UserFactory.create();
      const asset = AssetFactory.from({ ownerId: sharer.id })
        .exif({ latitude: 42, longitude: 69, city: 'Calgary' })
        .build();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      const response = (await sut.get(auth, asset.id)) as AssetResponseDto;

      expect(response.exifInfo).toEqual(expect.objectContaining({ latitude: 42, longitude: 69, city: 'Calgary' }));
    });

    it("should keep the location on the owner's own asset without a partner lookup", async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.from({ ownerId: auth.user.id }).exif({ latitude: 42, longitude: 69 }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      const response = (await sut.get(auth, asset.id)) as AssetResponseDto;

      expect(mocks.partner.getAll).not.toHaveBeenCalled();
      expect(response.exifInfo).toEqual(expect.objectContaining({ latitude: 42, longitude: 69 }));
    });

    it('should filter direct asset reads when NSFW privacy hiding is active', async () => {
      const asset = AssetFactory.create();
      const auth = { ...authStub.admin, hideNsfwAssets: true };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.get(auth, asset.id);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        auth.user.id,
        new Set([asset.id]),
        undefined,
        true,
      );
    });

    it('should allow shared link access', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.get(authStub.adminSharedLink, asset.id);

      expect(mocks.access.asset.checkSharedLinkAccess).toHaveBeenCalledWith(
        authStub.adminSharedLink.sharedLink?.id,
        new Set([asset.id]),
      );
    });

    it('should strip metadata for shared link if exif is disabled', async () => {
      const asset = AssetFactory.from().exif({ description: 'foo' }).build();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      const result = await sut.get(
        { ...authStub.adminSharedLink, sharedLink: { ...authStub.adminSharedLink.sharedLink!, showExif: false } },
        asset.id,
      );

      expect(result).toEqual(expect.objectContaining({ hasMetadata: false }));
      expect(result).not.toHaveProperty('exifInfo');
      expect(mocks.access.asset.checkSharedLinkAccess).toHaveBeenCalledWith(
        authStub.adminSharedLink.sharedLink?.id,
        new Set([asset.id]),
      );
    });

    it('should allow partner sharing access', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.get(authStub.admin, asset.id);
    });

    it('should allow shared album access', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.get(authStub.admin, asset.id);

      expect(mocks.access.asset.checkAlbumAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set([asset.id]));
    });

    it('should throw an error for no access', async () => {
      await expect(sut.get(authStub.admin, AssetFactory.create().id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.asset.getById).not.toHaveBeenCalled();
    });

    it('should throw an error for an invalid shared link', async () => {
      await expect(sut.get(authStub.adminSharedLink, AssetFactory.create().id)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
      expect(mocks.asset.getById).not.toHaveBeenCalled();
    });

    it('should throw an error if the asset could not be found', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));

      await expect(sut.get(authStub.admin, asset.id)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('fillMissingMetadata', () => {
    it('takes origin admission before entering metadata write locks', async () => {
      mocks.partnerOrigin.withOriginEdit.mockRejectedValue(new Error('origin busy'));

      await expect(sut.fillMissingMetadata(authStub.admin, 'asset-1', { description: 'Imported' })).rejects.toThrow(
        'origin busy',
      );

      expect(mocks.asset.withMetadataUpdate).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.job.queueInTransaction).not.toHaveBeenCalled();
    });

    const id = 'asset-1';
    const requested = {
      description: 'From Google',
      latitude: 1,
      longitude: 2,
      isFavorite: true,
      visibility: AssetVisibility.Archive,
    };
    let current: ReturnType<typeof getForAsset>;
    let committed: boolean;
    beforeEach(() => {
      committed = false;
      current = {
        ...getForAsset(AssetFactory.create({ id, ownerId: authStub.admin.user.id })),
        exifInfo: { description: '', latitude: null, longitude: null } as never,
      };
      mocks.asset.getById.mockImplementation(() => tryPromise(() => current));
      mocks.asset.update.mockImplementation(() => tryPromise(() => current));
      mocks.asset.withMetadataUpdate.mockImplementation(async (_id, write) => {
        const result = await write(mocks.asset as never, mocks.access as never, {} as never);
        committed = true;
        return result;
      });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
      mocks.partnerOrigin.getIdsWithFollowers.mockResolvedValue([]);
      mocks.job.queueInTransaction.mockImplementation(() =>
        tryPromise(() => {
          expect(committed).toBe(false);
        }),
      );
    });

    it('keeps manual metadata committed after the importer snapshot and emits no no-op effects', async () => {
      current.exifInfo = { description: 'Edited by hand', latitude: 5, longitude: 6 } as never;
      current.isFavorite = true;
      current.visibility = AssetVisibility.Archive;

      expect(await sut.fillMissingMetadata(authStub.admin, id, requested)).toBe(true);

      expect(mocks.asset.getById).toHaveBeenCalledWith(id, { exifInfo: true });
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.asset.unlockProperties).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueInTransaction).not.toHaveBeenCalled();
      expect(mocks.partnerOrigin.markOverridden).not.toHaveBeenCalled();
    });

    it('fills missing fields under the guard, retaining metadata locks and transactional effects', async () => {
      current.stackId = 'stack';
      mocks.asset.getStackSiblingIds.mockResolvedValue(['sibling']);
      await sut.fillMissingMetadata(authStub.admin, id, requested);

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith({
        exif: {
          assetId: id,
          description: 'From Google',
          latitude: 1,
          longitude: 2,
          lockedProperties: ['description', 'latitude', 'longitude'],
        },
        lockedPropertiesBehavior: 'append',
      });
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(id, ['city', 'state', 'country']);
      expect(mocks.asset.update).toHaveBeenCalledWith({ id, isFavorite: true, visibility: AssetVisibility.Archive });
      expect(mocks.job.queueInTransaction).toHaveBeenCalledWith(expect.anything(), {
        name: JobName.SidecarWrite,
        data: { id },
      });
      expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
        'asset',
        [id],
        ['description', 'location', 'visibility'],
        authStub.admin.user.id,
        expect.anything(),
      );
      expect(mocks.asset.getByIdsWithAllRelationsButStacks).toHaveBeenCalledWith(
        [id, 'sibling'],
        authStub.admin.user.id,
      );
    });

    it('admits partner propagation before the sidecar in the metadata transaction', async () => {
      mocks.partnerOrigin.getIdsWithFollowers.mockResolvedValue([id]);
      await sut.fillMissingMetadata(authStub.admin, id, { description: 'From Google' });
      expect(mocks.job.queueInTransaction.mock.calls.map(([, item]) => item)).toEqual([
        { name: JobName.PartnerPropagate, data: { kind: 'asset', sourceId: id, fields: ['description'] } },
        { name: JobName.SidecarWrite, data: { id } },
      ]);
    });

    it('retains a complete zero-valued coordinate pair and Hidden visibility', async () => {
      current.exifInfo = { description: 'Mine', latitude: 0, longitude: 0 } as never;
      current.visibility = AssetVisibility.Hidden;
      await sut.fillMissingMetadata(authStub.admin, id, requested);

      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.asset.update).toHaveBeenCalledWith({ id, isFavorite: true });
      expect(mocks.partnerOrigin.markOverridden).not.toHaveBeenCalled();
      expect(mocks.asset.getStackSiblingIds).not.toHaveBeenCalled();
    });

    it.each([null, { description: '', latitude: 0, longitude: null }])(
      'fills an absent or incomplete EXIF coordinate pair: %s',
      async (exifInfo) => {
        current.exifInfo = exifInfo as never;
        await sut.fillMissingMetadata(authStub.admin, id, requested);
        expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
          expect.objectContaining({
            exif: expect.objectContaining({ description: 'From Google', latitude: 1, longitude: 2 }),
          }),
        );
      },
    );

    it('leaves freshly Locked media alone even for an elevated owner', async () => {
      current.isLocked = true;
      expect(await sut.fillMissingMetadata(authStub.adminWithElevatedPermission, id, requested)).toBe(false);
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it.each(['missing', 'owner', 'deleted', 'access', 'write', 'admission', 'provenance'])(
      'refuses %s and admits no post-commit effects',
      async (failure) => {
        switch (failure) {
          case 'missing': {
            mocks.asset.getById.mockResolvedValue(undefined);
            break;
          }
          case 'owner': {
            current.ownerId = 'other';
            break;
          }
          case 'deleted': {
            current.deletedAt = new Date();
            break;
          }
          // No default
        }
        switch (failure) {
          case 'access': {
            mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
            break;
          }
          case 'write': {
            mocks.asset.update.mockResolvedValue(undefined);
            break;
          }
          case 'admission': {
            mocks.job.queueInTransaction.mockRejectedValue(new Error('admission failed'));
            break;
          }
          // No default
        }
        if (failure === 'provenance') mocks.partnerOrigin.markOverridden.mockRejectedValue(new Error('lineage failed'));
        await expect(sut.fillMissingMetadata(authStub.admin, id, requested)).rejects.toThrow();
        expect(committed).toBe(false);
        expect(mocks.job.queue).not.toHaveBeenCalled();
        if (!['admission', 'provenance'].includes(failure))
          expect(mocks.partnerOrigin.markOverridden).not.toHaveBeenCalled();
        if (!['write', 'admission', 'provenance'].includes(failure))
          expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      },
    );
  });

  describe('update', () => {
    it.each(['ordinary', 'unlink', 'replace'] as const)(
      'pins the whole %s lock group before commit without spreading description overrides',
      async (action) => {
        const ownerId = authStub.admin.user.id;
        const oldMotion = AssetFactory.create({
          id: 'old-motion',
          ownerId,
          type: AssetType.Video,
          visibility: AssetVisibility.Hidden,
        });
        const newMotion = AssetFactory.create({ id: 'new-motion', ownerId, type: AssetType.Video });
        const photo = AssetFactory.create({
          id: 'photo',
          ownerId,
          livePhotoVideoId: action === 'ordinary' ? null : oldMotion.id,
        });
        const sibling = AssetFactory.create({ id: 'sibling', ownerId });
        const ids =
          action === 'ordinary'
            ? [photo.id, sibling.id]
            : action === 'unlink'
              ? [photo.id, oldMotion.id, sibling.id]
              : [photo.id, oldMotion.id, newMotion.id, sibling.id];
        const rows = new Map([photo, oldMotion, newMotion, sibling].map((asset) => [asset.id, getForAsset(asset)]));
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([photo.id]));
        mocks.asset.findLockGroupIds.mockResolvedValue(ids);
        mocks.asset.getById.mockImplementation((id) => Promise.resolve(rows.get(id)));
        mocks.asset.getByIds.mockResolvedValue(rows.values().toArray());
        mocks.asset.update.mockImplementation((update) =>
          Promise.resolve({ ...rows.get(update.id)!, ...update } as never),
        );
        mocks.asset.lock.mockResolvedValue([]);
        mocks.partnerOrigin.getIdsWithFollowers.mockImplementation((_kind, ids) => Promise.resolve(ids));
        let committed = false;
        mocks.partnerOrigin.withOriginEdit.mockImplementation(async (_kind, admitted, _fields, write) => {
          expect(admitted).toEqual(ids);
          const result = await write();
          expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith('asset', ids, ['visibility'], ownerId);
          expect(mocks.partnerOrigin.markOverridden).not.toHaveBeenCalledWith(
            'asset',
            ids,
            expect.arrayContaining(['description']),
            ownerId,
          );
          committed = true;
          return result;
        });
        mocks.job.queueAll.mockImplementation(() => {
          expect(committed).toBe(true);
          return Promise.resolve(undefined as never);
        });
        await sut.update(authStub.admin, photo.id, {
          visibility: AssetVisibility.Locked,
          description: 'Mine',
          ...(action === 'ordinary' ? {} : { livePhotoVideoId: action === 'unlink' ? null : newMotion.id }),
        });
        expect(committed).toBe(true);
        expect(mocks.job.queueAll).toHaveBeenCalledWith(
          expect.arrayContaining([
            { name: JobName.PartnerPropagate, data: { kind: 'asset', sourceId: sibling.id, fields: ['visibility'] } },
          ]),
        );
      },
    );

    it('rejects a single lock group that expands beyond origin admission', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));
      mocks.asset.findLockGroupIds.mockResolvedValueOnce([asset.id]).mockResolvedValue([asset.id, 'sibling']);
      await expect(sut.update(authStub.admin, asset.id, { visibility: AssetVisibility.Locked })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mocks.partnerOrigin.markOverridden).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it.each([undefined, null])('admits origin edits before writing with motion id %s', async (livePhotoVideoId) => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.partnerOrigin.withOriginEdit.mockRejectedValue(new Error('origin busy'));
      await expect(sut.update(authStub.admin, asset.id, { description: 'Mine', livePhotoVideoId })).rejects.toThrow(
        'origin busy',
      );
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.asset.withLivePhotoUpdate).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('records overrides before origin commit and dispatches sidecars afterward', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));
      let admitted = false;
      let committed = false;
      mocks.partnerOrigin.withOriginEdit.mockImplementation(async (_kind, _ids, _fields, write) => {
        admitted = true;
        const result = await write();
        expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
          'asset',
          [asset.id],
          ['description'],
          authStub.admin.user.id,
        );
        committed = true;
        return result;
      });
      mocks.asset.upsertExif.mockImplementation(() => {
        expect(admitted).toBe(true);
        expect(committed).toBe(false);
        return Promise.resolve(undefined as never);
      });
      mocks.job.queue.mockImplementation(() => {
        expect(committed).toBe(true);
        return Promise.resolve(undefined as never);
      });
      await sut.update(authStub.admin, asset.id, { description: 'Mine' });
      expect(committed).toBe(true);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: asset.id } });
    });

    beforeEach(() => {
      mocks.asset.withLivePhotoUpdate.mockImplementation((_id, _motion, write) =>
        write(mocks.asset as never, mocks.access as never),
      );
      mocks.asset.findLockGroupIds.mockImplementation((ids) => Promise.resolve(ids));
      mocks.asset.getLivePhotoCount.mockResolvedValue(0);
    });
    it('should require asset write access for the id', async () => {
      await expect(
        sut.update(authStub.admin, 'asset-1', { visibility: AssetVisibility.Timeline }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('should update the asset', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { isFavorite: true });

      expect(mocks.asset.update).toHaveBeenCalledWith({ id: asset.id, isFavorite: true });
    });

    it('should queue a new thumbnail for people whose featured face became Locked (FL-53)', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));
      mocks.asset.lock.mockResolvedValue([asset.id]);
      mocks.person.getMissingThumbnailsForAssets.mockResolvedValue([
        { ownerId: 'owner-1', personGroupId: 'person-group-1' },
      ]);

      await sut.update(authStub.adminWithElevatedPermission, asset.id, { visibility: AssetVisibility.Locked });

      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith([asset.id]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PersonGenerateThumbnail, data: { ownerId: 'owner-1', personGroupId: 'person-group-1' } },
      ]);
    });

    it('should answer from the updated row when a session without the PIN locks the asset (FL-34)', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));
      mocks.asset.lock.mockResolvedValue([asset.id]);

      const response = await sut.update(authStub.admin, asset.id, { visibility: AssetVisibility.Locked });

      expect(mocks.asset.lock).toHaveBeenCalledWith([asset.id], AssetLockReason.Marked, authStub.admin.user.id);
      expect(mocks.asset.getById).not.toHaveBeenCalled();
      expect(response).toEqual(expect.objectContaining({ id: asset.id, visibility: AssetVisibility.Locked }));
    });

    it('should not look for face thumbnails when the asset does not move into the Locked folder', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { visibility: AssetVisibility.Archive });

      expect(mocks.person.getMissingThumbnailsForAssets).not.toHaveBeenCalled();
      expect(mocks.user.getLockedProfileImageSources).not.toHaveBeenCalled();
    });

    it('should replace a profile picture copied from a photo that became Locked (FL-53)', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));
      mocks.user.getLockedProfileImageSources.mockResolvedValue([
        { id: 'user-1', profileImagePath: '/profile/user-1/old.webp', profileImageAssetId: asset.id },
      ]);
      mocks.user.getProfileImageReplacement.mockResolvedValue(undefined);
      mocks.user.replaceLockedProfileImage.mockResolvedValue(true);
      mocks.asset.lock.mockResolvedValue([asset.id]);

      await sut.update(authStub.adminWithElevatedPermission, asset.id, { visibility: AssetVisibility.Locked });

      // no other photo may stand in, so the user is back to the default avatar
      expect(mocks.user.replaceLockedProfileImage).toHaveBeenCalledWith('user-1', asset.id, {
        profileImagePath: '',
        profileImageAssetId: null,
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/profile/user-1/old.webp'] },
      });
    });

    it('should update the exif description', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { description: 'Test description' });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: { assetId: asset.id, description: 'Test description', lockedProperties: ['description'] },
          lockedPropertiesBehavior: 'append',
        }),
      );
    });

    it("removes a Live Photo's location from its paired video too (FL-51)", async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));
      mocks.asset.getByIds.mockResolvedValue([{ id: asset.id, livePhotoVideoId: 'motion-1' }] as never);

      await sut.update(authStub.admin, asset.id, { latitude: null, longitude: null });

      expect(mocks.asset.clearLocation).toHaveBeenCalledWith([asset.id, 'motion-1']);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: asset.id } });
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: 'motion-1' } });
    });

    it('removes typed place names with the location instead of storing them (FL-51, FL-36)', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.asset.update.mockResolvedValue(getForAsset(asset));
      mocks.asset.getByIds.mockResolvedValue([{ id: asset.id, livePhotoVideoId: null }] as never);

      await sut.update(authStub.admin, asset.id, { latitude: null, longitude: null, city: 'Paris' });

      expect(mocks.asset.clearLocation).toHaveBeenCalledWith([asset.id]);
      expect(mocks.asset.unlockProperties).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.SidecarWrite, data: { id: asset.id } });
    });

    it('should update the exif rating', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(asset));
      mocks.asset.update.mockResolvedValueOnce(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { rating: 3 });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: {
            assetId: asset.id,
            rating: 3,
            lockedProperties: ['rating'],
          },
          lockedPropertiesBehavior: 'append',
        }),
      );
    });

    it('stores and locks a typed place name, clearing an empty one (FL-36, V-24)', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(asset));
      mocks.asset.update.mockResolvedValueOnce(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, {
        latitude: 51.4,
        longitude: -116.2,
        city: '  Lake Louise ',
        state: 'Alberta',
        country: '',
      });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: {
            assetId: asset.id,
            latitude: 51.4,
            longitude: -116.2,
            city: 'Lake Louise',
            state: 'Alberta',
            country: null,
            lockedProperties: ['latitude', 'longitude', 'city', 'state', 'country'],
          },
          lockedPropertiesBehavior: 'append',
        }),
      );
      expect(mocks.asset.unlockProperties).not.toHaveBeenCalled();
    });

    it('lets geocoding name a moved item whose place was not typed (FL-36, V-24)', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(asset));
      mocks.asset.update.mockResolvedValueOnce(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { latitude: 10, longitude: 20 });

      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(asset.id, ['city', 'state', 'country']);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: { assetId: asset.id, latitude: 10, longitude: 20, lockedProperties: ['latitude', 'longitude'] },
        }),
      );
    });

    it('keeps a typed place when the same edit names it at the new coordinates (FL-36, V-24)', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(asset));
      mocks.asset.update.mockResolvedValueOnce(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { latitude: 35.68, longitude: 139.69, city: 'Tokyo' });

      expect(mocks.asset.unlockProperties).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({ exif: expect.objectContaining({ city: 'Tokyo' }) }),
      );
    });

    it('never passes place names to the asset row (FL-36, V-24)', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(asset));
      mocks.asset.update.mockResolvedValueOnce(getForAsset(asset));

      await sut.update(authStub.admin, asset.id, { city: 'Banff' });

      expect(mocks.asset.update).toHaveBeenCalledWith(expect.not.objectContaining({ city: expect.anything() }));
      expect(mocks.asset.unlockProperties).not.toHaveBeenCalled();
    });

    it('should fail linking a live video if the motion part could not be found', async () => {
      const auth = AuthFactory.create();
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));

      await expect(
        sut.update(auth, asset.id, {
          livePhotoVideoId: 'unknown',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.asset.update).not.toHaveBeenCalledWith({
        id: asset.id,
        livePhotoVideoId: 'unknown',
      });
      expect(mocks.asset.update).not.toHaveBeenCalledWith({
        id: 'unknown',
        visibility: AssetVisibility.Timeline,
      });
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetShow', {
        assetId: 'unknown',
        userId: auth.user.id,
      });
    });

    it('should fail linking a live video if the motion part is not a video', async () => {
      const auth = AuthFactory.create();
      const motionAsset = AssetFactory.from().owner(auth.user).build();
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await expect(
        sut.update(authStub.admin, asset.id, {
          livePhotoVideoId: motionAsset.id,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.asset.update).not.toHaveBeenCalledWith({
        id: asset.id,
        livePhotoVideoId: motionAsset.id,
      });
      expect(mocks.asset.update).not.toHaveBeenCalledWith({
        id: motionAsset.id,
        visibility: AssetVisibility.Timeline,
      });
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetShow', {
        assetId: motionAsset.id,
        userId: auth.user.id,
      });
    });

    it('should fail linking a live video if the motion part has a different owner', async () => {
      const auth = AuthFactory.create();
      const motionAsset = AssetFactory.create({ type: AssetType.Video });
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(motionAsset));

      await expect(
        sut.update(auth, asset.id, {
          livePhotoVideoId: motionAsset.id,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.asset.update).not.toHaveBeenCalledWith({
        id: asset.id,
        livePhotoVideoId: motionAsset.id,
      });
      expect(mocks.asset.update).not.toHaveBeenCalledWith({
        id: motionAsset.id,
        visibility: AssetVisibility.Timeline,
      });
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetShow', {
        assetId: motionAsset.id,
        userId: auth.user.id,
      });
    });

    it('should link a live video', async () => {
      const motionAsset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Timeline });
      const stillAsset = AssetFactory.from().owner(motionAsset.owner).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([stillAsset.id]));
      mocks.asset.getById.mockImplementation((id) =>
        tryPromise(() => getForAsset(id === motionAsset.id ? motionAsset : stillAsset)),
      );
      mocks.asset.update.mockResolvedValue(getForAsset(stillAsset));
      const auth = AuthFactory.from(motionAsset.owner).build();

      await sut.update(auth, stillAsset.id, { livePhotoVideoId: motionAsset.id });

      expect(mocks.asset.update).toHaveBeenCalledWith({ id: motionAsset.id, visibility: AssetVisibility.Hidden });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetHide', { assetId: motionAsset.id, userId: auth.user.id });
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: stillAsset.id, livePhotoVideoId: motionAsset.id });
    });

    it('should throw an error if asset could not be found after update', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      await expect(sut.update(AuthFactory.create(), 'asset-1', { isFavorite: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should unlink a live video', async () => {
      const auth = AuthFactory.create();
      const motionAsset = AssetFactory.from({ type: AssetType.Video, visibility: AssetVisibility.Hidden })
        .owner(auth.user)
        .build();
      const asset = AssetFactory.from({ livePhotoVideoId: motionAsset.id }).owner(auth.user).build();
      const unlinkedAsset = { ...asset, livePhotoVideoId: null };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockImplementation((id) =>
        tryPromise(() => getForAsset(id === motionAsset.id ? motionAsset : asset)),
      );
      mocks.asset.update.mockResolvedValueOnce(getForAsset(unlinkedAsset));

      await sut.update(auth, asset.id, { livePhotoVideoId: null });

      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        livePhotoVideoId: null,
      });
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: motionAsset.id,
        visibility: asset.visibility,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetShow', {
        assetId: motionAsset.id,
        userId: auth.user.id,
      });
    });

    it('should fail unlinking a live video if the asset could not be found', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValueOnce(void 0);

      await expect(sut.update(authStub.admin, asset.id, { livePhotoVideoId: null })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });
  });

  describe('Live Photo edit commit', () => {
    const auth = AuthFactory.create();
    type Row = ReturnType<typeof getForAsset> & { isLocked?: boolean };
    let rows: Map<string, Row>;
    let committed: boolean;
    let failing: string | undefined;
    let revoked: boolean;
    let exif: string | undefined;
    let effects: boolean[];

    beforeEach(() => {
      rows = new Map(
        [
          AssetFactory.from({ id: 'photo', ownerId: auth.user.id, livePhotoVideoId: 'old' }).build(),
          AssetFactory.from({ id: 'video', ownerId: auth.user.id, type: AssetType.Video }).build(),
          AssetFactory.from({
            id: 'old',
            ownerId: auth.user.id,
            type: AssetType.Video,
            visibility: AssetVisibility.Hidden,
          }).build(),
        ].map((asset) => [asset.id, getForAsset(asset)]),
      );
      committed = false;
      failing = undefined;
      revoked = false;
      exif = undefined;
      effects = [];
      mocks.access.asset.checkOwnerAccess.mockImplementation(() => tryPromise(() => new Set(revoked ? [] : ['photo'])));
      mocks.asset.getById.mockImplementation((id) => tryPromise(() => rows.get(id)));
      mocks.asset.getByIds.mockImplementation((ids) => tryPromise(() => ids.flatMap((id) => rows.get(id) ?? [])));
      mocks.asset.getLivePhotoCount.mockResolvedValue(0);
      mocks.asset.findLockGroupIds.mockImplementation((ids) =>
        tryPromise(() => [
          ...new Set(
            ids.flatMap((id) => {
              const motionId = rows.get(id)?.livePhotoVideoId;
              return motionId ? [id, motionId] : [id];
            }),
          ),
        ]),
      );
      mocks.asset.update.mockImplementation((update) =>
        tryPromise(() => {
          const row = rows.get(update.id);
          if (!row) return;
          Object.assign(row, update);
          if (failing === (update.id === 'photo' ? 'photo' : 'motion')) throw new Error('write failed');
          return row;
        }),
      );
      mocks.asset.upsertExif.mockImplementation(({ exif: update }) =>
        tryPromise(() => {
          exif = update.description ?? undefined;
          if (failing === 'exif') throw new Error('write failed');
          return undefined as never;
        }),
      );
      mocks.asset.lock.mockImplementation((ids) =>
        tryPromise(() => {
          for (const id of ids) rows.get(id)!.isLocked = true;
          return ids;
        }),
      );
      mocks.person.getMissingThumbnailsForAssets.mockResolvedValue([]);
      mocks.user.getLockedProfileImageSources.mockResolvedValue([]);
      mocks.job.queue.mockImplementation(() =>
        tryPromise(() => {
          effects.push(committed);
        }),
      );
      mocks.event.emit.mockImplementation(() =>
        tryPromise(() => {
          effects.push(committed);
        }),
      );
      Object.assign(mocks.asset, {
        withLivePhotoUpdate: vi.fn(
          async (
            _id: string,
            _motion: string | null,
            write: (assets: ServiceMocks['asset'], access: ServiceMocks['access']) => Promise<unknown>,
          ) => {
            const before = structuredClone(rows);
            const beforeExif = exif;
            try {
              const result = await write(mocks.asset, mocks.access);
              if (failing === 'commit') throw new Error('write failed');
              committed = true;
              return result;
            } catch (error) {
              rows = before;
              exif = beforeExif;
              throw error;
            }
          },
        ),
      });
    });

    it.each(['motion', 'photo', 'exif', 'commit'])(
      'rolls back a failed %s stage without publishing effects',
      async (stage) => {
        failing = stage;
        const before = structuredClone(rows);
        await expect(sut.update(auth, 'photo', { livePhotoVideoId: 'video', description: 'changed' })).rejects.toThrow(
          'write failed',
        );
        expect(rows).toEqual(before);
        expect(exif).toBeUndefined();
        expect(effects).toEqual([]);
      },
    );

    it('rolls back the photo unlink when restoring motion visibility fails', async () => {
      failing = 'motion';
      const before = structuredClone(rows);
      await expect(sut.update(auth, 'photo', { livePhotoVideoId: null })).rejects.toThrow('write failed');
      expect(rows).toEqual(before);
      expect(effects).toEqual([]);
    });

    it('commits both parts and EXIF before sidecar jobs and hide/show events', async () => {
      await sut.update(auth, 'photo', {
        livePhotoVideoId: 'video',
        description: 'changed',
        latitude: null,
        longitude: null,
      });
      expect(rows.get('photo')!.livePhotoVideoId).toBe('video');
      expect(rows.get('video')!.visibility).toBe(AssetVisibility.Hidden);
      expect(rows.get('old')!.visibility).toBe(rows.get('photo')!.visibility);
      expect(exif).toBe('changed');
      expect(mocks.asset.clearLocation).toHaveBeenCalledWith(['photo', 'old', 'video']);
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetHide', { assetId: 'video', userId: auth.user.id });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetShow', { assetId: 'old', userId: auth.user.id });
      expect(effects.length).toBeGreaterThan(0);
      expect(effects.every(Boolean)).toBe(true);
    });

    it('rechecks photo access after acquiring the transaction locks', async () => {
      mocks.access.asset.checkOwnerAccess.mockImplementationOnce(() =>
        tryPromise(() => {
          revoked = true;
          return new Set(['photo']);
        }),
      );
      await expect(sut.update(auth, 'photo', { livePhotoVideoId: 'video' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('refuses a Locked motion from an ordinary session before any writes', async () => {
      rows.get('video')!.isLocked = true;
      await expect(sut.update(auth, 'photo', { livePhotoVideoId: 'video' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it.each(['missing', 'type', 'owner', 'deleted', 'still type'])(
      'refuses a motion link with invalid %s before any writes',
      async (invalid) => {
        switch (invalid) {
          case 'missing': {
            rows.delete('video');
            break;
          }
          case 'type': {
            rows.get('video')!.type = AssetType.Image;
            break;
          }
          case 'owner': {
            rows.get('video')!.ownerId = 'other-owner';
            break;
          }
          // No default
        }
        if (invalid === 'deleted') rows.get('video')!.deletedAt = new Date();
        else if (invalid === 'still type') rows.get('photo')!.type = AssetType.Video;
        await expect(sut.update(auth, 'photo', { livePhotoVideoId: 'video' })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(mocks.asset.update).not.toHaveBeenCalled();
        expect(effects).toEqual([]);
      },
    );

    it('refuses mixed Locked classes even from an elevated session', async () => {
      rows.get('video')!.isLocked = true;
      await expect(
        sut.update({ ...auth, session: { ...auth.session!, hasElevatedPermission: true } }, 'photo', {
          livePhotoVideoId: 'video',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('allows an explicit move to Locked without a PIN and locks both old and new motion parts before commit', async () => {
      rows.get('video')!.isLocked = true;
      const response = await sut.update(auth, 'photo', {
        livePhotoVideoId: 'video',
        visibility: AssetVisibility.Locked,
      });
      expect(mocks.asset.lock).toHaveBeenCalledWith(['photo', 'old', 'video'], AssetLockReason.Marked, auth.user.id);
      expect(response.visibility).toBe(AssetVisibility.Locked);
      expect(effects.every(Boolean)).toBe(true);
    });

    it('does not restore a detached motion still referenced by another photo', async () => {
      mocks.asset.getLivePhotoCount.mockResolvedValue(1);
      await sut.update(auth, 'photo', { livePhotoVideoId: null });
      expect(rows.get('old')!.visibility).toBe(AssetVisibility.Hidden);
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetShow', expect.anything());
    });

    it.each([null, 'video'])(
      'preserves the Android unlink restriction when changing the motion to %s',
      async (livePhotoVideoId) => {
        rows.get('old')!.originalPath = StorageCore.getBaseFolder(StorageFolder.EncodedVideo) + '/motion.mp4';
        await expect(sut.update(auth, 'photo', { livePhotoVideoId })).rejects.toThrow(
          'Cannot unlink Android motion photos',
        );
        expect(mocks.asset.update).not.toHaveBeenCalled();
        expect(effects).toEqual([]);
      },
    );

    it('allows an elevated owner to pair two Locked parts', async () => {
      rows.get('photo')!.isLocked = true;
      rows.get('video')!.isLocked = true;
      await sut.update({ ...auth, session: { ...auth.session!, hasElevatedPermission: true } }, 'photo', {
        livePhotoVideoId: 'video',
      });
      expect(rows.get('photo')!.livePhotoVideoId).toBe('video');
      expect(effects.every(Boolean)).toBe(true);
    });

    it('refuses to detach a Locked motion from an ordinary session', async () => {
      rows.get('old')!.isLocked = true;
      await expect(sut.update(auth, 'photo', { livePhotoVideoId: null })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it("never changes another owner's motion when detaching a malformed legacy link", async () => {
      rows.get('old')!.ownerId = 'other-owner';
      await sut.update(auth, 'photo', { livePhotoVideoId: 'video', latitude: null, longitude: null });
      expect(rows.get('old')!.visibility).toBe(AssetVisibility.Hidden);
      expect(mocks.asset.update).not.toHaveBeenCalledWith(expect.objectContaining({ id: 'old' }));
      expect(mocks.asset.clearLocation).toHaveBeenCalledWith(['photo', 'video']);
    });
  });

  describe('lock cascade origins', () => {
    it.each(['direct', 'bulk'] as const)(
      'protects %s lock siblings before commit, including already-locked members',
      async (action) => {
        const ids = ['asset-1', 'sibling'];
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
        mocks.asset.findLockGroupIds.mockResolvedValue(ids);
        mocks.asset.lock.mockResolvedValue([]);
        mocks.partnerOrigin.getIdsWithFollowers.mockImplementation((_kind, ids) => Promise.resolve(ids));
        let committed = false;
        mocks.partnerOrigin.withOriginEdit.mockImplementation(async (_kind, admitted, _fields, write) => {
          expect(admitted).toEqual(ids);
          const result = await write();
          expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
            'asset',
            ids,
            ['visibility'],
            authStub.admin.user.id,
          );
          committed = true;
          return result;
        });
        mocks.job.queueAll.mockImplementation(() => {
          expect(committed).toBe(true);
          return Promise.resolve(undefined as never);
        });
        if (action === 'direct') await sut.lock(authStub.admin, { ids: ['asset-1'] });
        else
          await sut.updateAll(authStub.admin, {
            ids: ['asset-1'],
            visibility: AssetVisibility.Locked,
            description: 'Mine',
          });
        expect(committed).toBe(true);
        expect(mocks.job.queueAll).toHaveBeenCalledWith(
          expect.arrayContaining([
            { name: JobName.PartnerPropagate, data: { kind: 'asset', sourceId: 'sibling', fields: ['visibility'] } },
          ]),
        );
        expect(mocks.partnerOrigin.markOverridden).not.toHaveBeenCalledWith(
          'asset',
          ids,
          expect.arrayContaining(['description']),
          authStub.admin.user.id,
        );
      },
    );

    it.each(['direct', 'bulk'] as const)(
      'rejects an expanded %s lock group before override recording',
      async (action) => {
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
        mocks.asset.findLockGroupIds.mockResolvedValueOnce(['asset-1']).mockResolvedValue(['asset-1', 'sibling']);
        mocks.asset.lock.mockResolvedValue([]);
        const edit =
          action === 'direct'
            ? sut.lock(authStub.admin, { ids: ['asset-1'] })
            : sut.updateAll(authStub.admin, { ids: ['asset-1'], visibility: AssetVisibility.Locked });
        await expect(edit).rejects.toBeInstanceOf(ConflictException);
        expect(mocks.partnerOrigin.markOverridden).not.toHaveBeenCalled();
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      },
    );
  });

  describe('updateAll', () => {
    beforeEach(() => {
      mocks.asset.findLockGroupIds.mockImplementation((ids) => Promise.resolve(ids));
    });
    it.each([AssetVisibility.Archive, AssetVisibility.Locked])(
      'admits origin edits before bulk %s writes',
      async (visibility) => {
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
        mocks.partnerOrigin.withOriginEdit.mockRejectedValue(new Error('origin busy'));
        await expect(
          sut.updateAll(authStub.admin, { ids: ['asset-1'], description: 'Mine', visibility }),
        ).rejects.toThrow('origin busy');
        expect(mocks.asset.updateAllExif).not.toHaveBeenCalled();
        expect(mocks.asset.updateAll).not.toHaveBeenCalled();
        expect(mocks.asset.lock).not.toHaveBeenCalled();
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
      },
    );

    it('records bulk overrides before commit and dispatches sidecars afterward', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      let committed = false;
      mocks.partnerOrigin.withOriginEdit.mockImplementation(async (_kind, _ids, _fields, write) => {
        const result = await write();
        expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
          'asset',
          ['asset-1'],
          ['description'],
          authStub.admin.user.id,
        );
        committed = true;
        return result;
      });
      mocks.job.queueAll.mockImplementation(() => {
        expect(committed).toBe(true);
        return Promise.resolve(undefined as never);
      });
      await sut.updateAll(authStub.admin, { ids: ['asset-1'], description: 'Mine' });
      expect(committed).toBe(true);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.SidecarWrite, data: { id: 'asset-1' } }]);
    });

    it('should require asset write access for all ids', async () => {
      const auth = AuthFactory.create();
      await expect(sut.updateAll(auth, { ids: ['asset-1'] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should update all assets', async () => {
      const auth = AuthFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1', 'asset-2']));

      await sut.updateAll(auth, { ids: ['asset-1', 'asset-2'], visibility: AssetVisibility.Archive });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['asset-1', 'asset-2'], {
        visibility: AssetVisibility.Archive,
      });
    });

    it('removes the location for null coordinates and rewrites the sidecars (FL-51)', async () => {
      const auth = AuthFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1', 'asset-2']));

      mocks.asset.getByIds.mockResolvedValue([
        { id: 'asset-1', livePhotoVideoId: 'motion-1' },
        { id: 'asset-2', livePhotoVideoId: null },
      ] as never);

      await sut.updateAll(auth, { ids: ['asset-1', 'asset-2'], latitude: null, longitude: null });

      // the Live Photo's paired video loses its location with the photo
      expect(mocks.asset.clearLocation).toHaveBeenCalledWith(['asset-1', 'asset-2', 'motion-1']);
      expect(mocks.asset.updateAllExif).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SidecarWrite, data: { id: 'asset-1' } },
        { name: JobName.SidecarWrite, data: { id: 'asset-2' } },
        { name: JobName.SidecarWrite, data: { id: 'motion-1' } },
      ]);
    });

    it('should keep album membership when assets are locked (FL-32, FL-34)', async () => {
      const auth = authStub.adminWithElevatedPermission;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1', 'asset-2']));

      mocks.person.getMissingThumbnailsForAssets.mockResolvedValue([]);

      await sut.updateAll(auth, { ids: ['asset-1', 'asset-2'], visibility: AssetVisibility.Locked });

      // `visibility: locked` is a lock record, never a stored visibility
      expect(mocks.asset.lock).toHaveBeenCalledWith(['asset-1', 'asset-2'], AssetLockReason.Marked, auth.user.id);
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.album.removeAssetsFromAll).not.toHaveBeenCalled();
    });

    it('should never unlock when storing another visibility (FL-34)', async () => {
      const auth = authStub.adminWithElevatedPermission;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.updateAll(auth, { ids: ['asset-1'], visibility: AssetVisibility.Timeline });

      expect(mocks.asset.unlock).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['asset-1'], { visibility: AssetVisibility.Timeline });
      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });

    it('should leave the lock alone when no visibility is asked for (FL-34)', async () => {
      const auth = authStub.adminWithElevatedPermission;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.updateAll(auth, { ids: ['asset-1'], isFavorite: true });

      expect(mocks.asset.lock).not.toHaveBeenCalled();
      expect(mocks.asset.unlock).not.toHaveBeenCalled();
    });

    it('should queue one new thumbnail per person whose featured face became Locked (FL-53)', async () => {
      const auth = authStub.adminWithElevatedPermission;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1', 'asset-2']));
      // the same person twice, e.g. from two chunks of a large move
      mocks.asset.lock.mockResolvedValue(['asset-1', 'asset-2']);
      mocks.person.getMissingThumbnailsForAssets.mockResolvedValue([
        { ownerId: 'owner-1', personGroupId: 'person-group-1' },
        { ownerId: 'owner-1', personGroupId: 'person-group-1' },
      ]);

      await sut.updateAll(auth, { ids: ['asset-1', 'asset-2'], visibility: AssetVisibility.Locked });

      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith(['asset-1', 'asset-2']);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.PersonGenerateThumbnail, data: { ownerId: 'owner-1', personGroupId: 'person-group-1' } },
      ]);
    });

    it('should not update Assets table if no relevant fields are provided', async () => {
      const auth = AuthFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.updateAll(auth, {
        ids: ['asset-1'],
        latitude: 0,
        longitude: 0,
        isFavorite: undefined,
        duplicateId: undefined,
        rating: undefined,
      });
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });

    it('should update Assets table if visibility field is provided', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.updateAll(authStub.admin, {
        ids: ['asset-1'],
        latitude: 0,
        longitude: 0,
        visibility: AssetVisibility.Archive,
        isFavorite: false,
        duplicateId: undefined,
        rating: undefined,
      });
      expect(mocks.asset.updateAll).toHaveBeenCalled();
      expect(mocks.asset.updateAllExif).toHaveBeenCalledWith(['asset-1'], { latitude: 0, longitude: 0 }, [
        'city',
        'state',
        'country',
      ]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.SidecarWrite, data: { id: 'asset-1' } }]);
    });

    it('should update exif table if latitude field is provided', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      const dateTimeOriginal = new Date().toISOString();
      await sut.updateAll(authStub.admin, {
        ids: ['asset-1'],
        latitude: 30,
        longitude: 50,
        dateTimeOriginal,
        isFavorite: false,
        duplicateId: undefined,
        rating: undefined,
      });
      expect(mocks.asset.updateAll).toHaveBeenCalled();
      expect(mocks.asset.updateAllExif).toHaveBeenCalledWith(
        ['asset-1'],
        { dateTimeOriginal, latitude: 30, longitude: 50 },
        ['city', 'state', 'country'],
      );
      expect(mocks.asset.updateAll).toHaveBeenCalledWith(
        ['asset-1'],
        expect.objectContaining({
          fileCreatedAt: new Date(dateTimeOriginal),
          localDateTime: new Date(dateTimeOriginal),
        }),
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.SidecarWrite, data: { id: 'asset-1' } }]);
    });

    it('releases typed place names when a bulk change moves the items (FL-36, V-24)', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1', 'asset-2']));

      await sut.updateAll(authStub.admin, { ids: ['asset-1', 'asset-2'], latitude: 35.68, longitude: 139.69 });

      expect(mocks.asset.updateAllExif).toHaveBeenCalledWith(
        ['asset-1', 'asset-2'],
        { latitude: 35.68, longitude: 139.69 },
        ['city', 'state', 'country'],
      );
    });

    it('does not release place names on a bulk location removal, which clears them (FL-51, FL-36)', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getByIds.mockResolvedValue([{ id: 'asset-1', livePhotoVideoId: null }] as never);

      await sut.updateAll(authStub.admin, { ids: ['asset-1'], latitude: null, longitude: null, rating: 2 });

      expect(mocks.asset.updateAllExif).toHaveBeenCalledWith(['asset-1'], { rating: 2 }, []);
      expect(mocks.asset.clearLocation).toHaveBeenCalledWith(['asset-1']);
    });

    it('keeps typed place names when a bulk change does not move the items (FL-36, V-24)', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.updateAll(authStub.admin, { ids: ['asset-1'], rating: 4 });

      expect(mocks.asset.updateAllExif).toHaveBeenCalledWith(['asset-1'], { rating: 4 }, []);
    });

    it('should update Assets table if duplicateId is provided as null', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.updateAll(authStub.admin, {
        ids: ['asset-1'],
        latitude: 0,
        longitude: 0,
        isFavorite: undefined,
        duplicateId: null,
        rating: undefined,
      });
      expect(mocks.asset.updateAll).toHaveBeenCalled();
    });

    it('should update exif table if dateTimeRelative and timeZone field is provided', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      const dateTimeRelative = 35;
      const timeZone = 'UTC+2';
      mocks.asset.updateDateTimeOriginal.mockResolvedValue([
        { assetId: 'asset-1', dateTimeOriginal: new Date('2020-02-25T04:41:00'), timeZone },
      ]);
      await sut.updateAll(authStub.admin, {
        ids: ['asset-1'],
        dateTimeRelative,
        timeZone,
      });
      expect(mocks.asset.updateDateTimeOriginal).toHaveBeenCalledWith(['asset-1'], dateTimeRelative, timeZone);
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: 'asset-1',
        fileCreatedAt: new Date('2020-02-25T04:41:00.000Z'),
        localDateTime: new Date('2020-02-25T04:41:00.000Z'),
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.SidecarWrite, data: { id: 'asset-1' } }]);
    });
  });

  describe('lock (FL-34)', () => {
    beforeEach(() => {
      mocks.asset.findLockGroupIds.mockImplementation((ids) => Promise.resolve(ids));
    });
    it('takes origin admission before locking or publishing lock effects', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.partnerOrigin.withOriginEdit.mockRejectedValue(new Error('origin busy'));
      await expect(sut.lock(authStub.admin, { ids: ['asset-1'] })).rejects.toThrow('origin busy');
      expect(mocks.asset.lock).not.toHaveBeenCalled();
      expect(mocks.person.getMissingThumbnailsForAssets).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should lock assets of the caller as their own lock without asking for the PIN', async () => {
      const auth = authStub.admin;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.lock.mockResolvedValue(['asset-1']);

      await sut.lock(auth, { ids: ['asset-1'] });

      expect(mocks.asset.lock).toHaveBeenCalledWith(['asset-1'], AssetLockReason.Marked, auth.user.id);
      expect(mocks.person.getMissingThumbnailsForAssets).toHaveBeenCalledWith(['asset-1']);
    });

    it('should refuse assets the caller may not change', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.lock(authStub.admin, { ids: ['asset-1'] })).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });

    it('should follow up nothing when every asset was already locked', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.lock.mockResolvedValue([]);

      await sut.lock(authStub.admin, { ids: ['asset-1'] });

      expect(mocks.person.getMissingThumbnailsForAssets).not.toHaveBeenCalled();
    });
  });

  describe('shiftDateTimeOriginalFrom (FL-32)', () => {
    it('requires update access for every item', async () => {
      await expect(
        sut.shiftDateTimeOriginalFrom(authStub.admin, [{ id: 'asset-1', from: new Date() }], 30),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.asset.setDateTimeOriginal).not.toHaveBeenCalled();
    });

    it('sets each item to its recorded start plus the shift, the same way twice', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.setDateTimeOriginal.mockResolvedValue({
        assetId: 'asset-1',
        dateTimeOriginal: new Date('2020-02-25T05:16:00.000Z'),
      } as never);
      const items = [{ id: 'asset-1', from: new Date('2020-02-25T04:41:00.000Z') }];

      await sut.shiftDateTimeOriginalFrom(authStub.admin, items, 35);
      await sut.shiftDateTimeOriginalFrom(authStub.admin, items, 35);

      expect(mocks.asset.setDateTimeOriginal).toHaveBeenCalledTimes(2);
      for (const call of mocks.asset.setDateTimeOriginal.mock.calls) {
        expect(call).toEqual(['asset-1', new Date('2020-02-25T05:16:00.000Z')]);
      }
      expect(mocks.asset.updateDateTimeOriginal).not.toHaveBeenCalled();
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: 'asset-1',
        fileCreatedAt: new Date('2020-02-25T05:16:00.000Z'),
        localDateTime: new Date('2020-02-25T05:16:00.000Z'),
      });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.SidecarWrite, data: { id: 'asset-1' } }]);
    });

    it("makes the shifted date the owner's on partner copies and passes it to copies that follow (FL-326)", async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.setDateTimeOriginal.mockResolvedValue({
        assetId: 'asset-1',
        dateTimeOriginal: new Date('2020-02-25T05:16:00.000Z'),
      } as never);
      mocks.partnerOrigin.getIdsWithFollowers.mockResolvedValue(['asset-1']);

      await sut.shiftDateTimeOriginalFrom(
        authStub.admin,
        [{ id: 'asset-1', from: new Date('2020-02-25T04:41:00.000Z') }],
        35,
      );

      expect(mocks.partnerOrigin.withOriginEdit).toHaveBeenCalledWith('asset', ['asset-1'], [], expect.any(Function));
      expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
        'asset',
        ['asset-1'],
        [AssetOriginField.DateTimeOriginal],
        authStub.admin.user.id,
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PartnerPropagate,
          data: { kind: 'asset', sourceId: 'asset-1', fields: [AssetOriginField.DateTimeOriginal] },
        },
      ]);
    });
  });

  describe('recordVisibilityEdit (FL-326)', () => {
    it("makes the visibility the owner's on partner copies, passes it on and notifies open sessions", async () => {
      mocks.partnerOrigin.getIdsWithFollowers.mockResolvedValue(['asset-1']);
      mocks.asset.getStackSiblingIds.mockResolvedValue([]);

      await sut.recordVisibilityEdit(['asset-1'], authStub.admin.user.id);

      expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
        'asset',
        ['asset-1'],
        [AssetOriginField.Visibility],
        authStub.admin.user.id,
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PartnerPropagate,
          data: { kind: 'asset', sourceId: 'asset-1', fields: [AssetOriginField.Visibility] },
        },
      ]);
    });
  });

  describe('deleteAll', () => {
    it('announces only ordinary changes, preserving their order and duplicates after sequenced effects', async () => {
      const ids = ['ordinary-2', 'sequenced', 'ordinary-1', 'ordinary-2'];
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(ids));
      mocks.trash.enqueueLocalEffects.mockResolvedValue(0);
      mocks.trash.applyReviewed.mockImplementation((...args) => {
        args[6]?.(['sequenced', 'sequenced']);
        return Promise.resolve(ids);
      });

      await sut.deleteAll(authStub.user1, { ids });

      expect(mocks.trash.enqueueLocalEffects).toHaveBeenCalledOnce();
      expect(mocks.event.emit).toHaveBeenCalledExactlyOnceWith('AssetTrashAll', {
        assetIds: ['ordinary-2', 'ordinary-1', 'ordinary-2'],
        userId: authStub.user1.user.id,
      });
      expect(mocks.trash.enqueueLocalEffects.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.event.emit.mock.invocationCallOrder[0],
      );
    });

    it('reads sequenced IDs only linearly for a large mixed trash batch', async () => {
      const ids = Array.from({ length: 512 }, (_, index) => `asset-${index}`);
      let reads = 0;
      const sequenced = new Proxy(ids.slice(0, 256), {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            reads++;
          }
          return Reflect.get(target, key, receiver);
        },
      });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(ids));
      mocks.trash.enqueueLocalEffects.mockResolvedValue(0);
      mocks.trash.applyReviewed.mockImplementation((...args) => {
        args[6]?.(sequenced);
        return Promise.resolve(ids);
      });

      await sut.deleteAll(authStub.user1, { ids });

      expect(mocks.event.emit).toHaveBeenCalledExactlyOnceWith('AssetTrashAll', {
        assetIds: ids.slice(256),
        userId: authStub.user1.user.id,
      });
      expect(reads).toBeLessThanOrEqual(512);
    });

    it('should require asset delete access for all ids', async () => {
      await expect(
        sut.deleteAll(authStub.user1, {
          ids: ['asset-1'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should force delete a batch of assets', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset1', 'asset2']));

      await sut.deleteAll(authStub.user1, { ids: ['asset1', 'asset2'], force: true });

      expect(mocks.event.emit).toHaveBeenCalledWith('AssetDeleteAll', {
        assetIds: ['asset1', 'asset2'],
        userId: 'user-id',
      });
    });

    it('should soft delete a batch of assets', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset1', 'asset2']));

      mocks.trash.applyReviewed.mockResolvedValue(['asset1', 'asset2']);
      await sut.deleteAll(authStub.user1, { ids: ['asset1', 'asset2'], force: false });

      expect(mocks.trash.applyReviewed).toHaveBeenCalledWith(
        authStub.user1.user.id,
        'trash',
        ['asset1', 'asset2'],
        expect.any(Object),
        expect.any(Function),
        authStub.user1,
        expect.any(Function),
      );
      expect(mocks.job.queue.mock.calls).toEqual([]);
    });
  });

  describe('handleAssetDeletionCheck', () => {
    beforeAll(() => {
      vi.useFakeTimers();
    });

    beforeEach(() => {
      mocks.assetEdit.releaseOrphanedVideoVersions.mockResolvedValue([]);
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    it('should immediately queue assets for deletion if trash is disabled', async () => {
      const asset = AssetFactory.create();

      mocks.assetJob.streamForDeletedJob.mockReturnValue(makeStream([asset]));
      mocks.systemMetadata.get.mockResolvedValue({ trash: { enabled: false } });

      await expect(sut.handleAssetDeletionCheck()).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.streamForDeletedJob).toHaveBeenCalledWith(new Date());
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDelete, data: { id: asset.id, deleteOnDisk: true } },
      ]);
    });

    it('should queue assets for deletion after trash duration', async () => {
      const asset = AssetFactory.create();

      mocks.assetJob.streamForDeletedJob.mockReturnValue(makeStream([asset]));
      mocks.systemMetadata.get.mockResolvedValue({ trash: { enabled: true, days: 7 } });

      await expect(sut.handleAssetDeletionCheck()).resolves.toBe(JobStatus.Success);

      expect(mocks.assetJob.streamForDeletedJob).toHaveBeenCalledWith(DateTime.now().minus({ days: 7 }).toJSDate());
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetDelete, data: { id: asset.id, deleteOnDisk: true } },
      ]);
    });

    it('queues the files of orphaned Studio HDR intermediates for deletion (FL-97)', async () => {
      mocks.assetJob.streamForDeletedJob.mockReturnValue(makeStream([]));
      mocks.systemMetadata.get.mockResolvedValue({ trash: { enabled: true, days: 7 } });
      mocks.asset.releaseStudioHdrIntermediates.mockResolvedValue(['/gone-studio-hdr.mp4']);

      await expect(sut.handleAssetDeletionCheck()).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/gone-studio-hdr.mp4'] },
      });
    });

    it('queues the files of orphaned video versions for deletion (FL-39)', async () => {
      mocks.assetJob.streamForDeletedJob.mockReturnValue(makeStream([]));
      mocks.systemMetadata.get.mockResolvedValue({ trash: { enabled: true, days: 7 } });
      mocks.assetEdit.releaseOrphanedVideoVersions.mockResolvedValue(['/v.master.mp4', '/v.master.mp4.lineage.json']);

      await expect(sut.handleAssetDeletionCheck()).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/v.master.mp4', '/v.master.mp4.lineage.json'] },
      });
    });
  });

  describe('handleAssetDeletion', () => {
    it('should clean up files', async () => {
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.Thumbnail })
        .file({ type: AssetFileType.Preview })
        .file({ type: AssetFileType.FullSize })
        .file({ type: AssetFileType.Preview, isEdited: true })
        .file({ type: AssetFileType.Thumbnail, isEdited: true })
        .build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      removedExtras = { videoDuplicateFramePaths: ['/data/thumbs/video-frame.jpeg'] };

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.job.queue.mock.calls).toEqual([
        [
          {
            name: JobName.FileDelete,
            data: {
              files: [...asset.files.map(({ path }) => path), '/data/thumbs/video-frame.jpeg', asset.originalPath],
              removedAssetId: asset.id,
              // universal storage: the original goes to the file trash with who held it
              original: {
                path: asset.originalPath,
                ownerId: asset.ownerId,
                assetId: asset.id,
                originalFileName: asset.originalFileName,
                checksum: asset.checksum.toString('hex'),
                sizeInBytes: asset.exifInfo?.fileSizeInByte ?? 0,
              },
            },
          },
        ],
      ]);
      expect(mocks.asset.remove).toHaveBeenCalledWith(getForAssetDeletion(asset), {
        files: expect.any(Function),
        queue: expect.any(Function),
      });
    });

    it('hands a shared file over to the next primary and queues its storage move', async () => {
      const asset = AssetFactory.from({ physicalOriginalFileId: 'physical-file-id' }).build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      mocks.physicalFile.electNextCanonical.mockResolvedValue({ assetId: 'next-primary' });

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.physicalFile.electNextCanonical).toHaveBeenCalledWith('physical-file-id');
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.StorageTemplateMigrationSingle,
        data: { id: 'next-primary' },
      });
    });

    it('leaves the primary alone when a non-primary copy is deleted', async () => {
      const asset = AssetFactory.from({ physicalOriginalFileId: 'physical-file-id' }).build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      mocks.physicalFile.electNextCanonical.mockResolvedValue(undefined);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.job.queue).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: JobName.StorageTemplateMigrationSingle }),
      );
    });

    it('never elects a primary for an asset without a shared file', async () => {
      const asset = AssetFactory.from().build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.physicalFile.electNextCanonical).not.toHaveBeenCalled();
    });

    it('never deletes the original or sidecar of an external library item (FL-78)', async () => {
      const asset = AssetFactory.from({ libraryId: newUuid(), isExternal: true })
        .file({ type: AssetFileType.Thumbnail })
        .file({ type: AssetFileType.Preview })
        .build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: asset.files.map(({ path }) => path), removedAssetId: asset.id },
      });
      const deleted = mocks.job.queue.mock.calls.flatMap(([item]) => (item.data as { files?: string[] }).files ?? []);
      expect(deleted).not.toContain(asset.originalPath);
      expect(mocks.user.updateUsage).not.toHaveBeenCalled();
    });

    it.each([false, true])('removes only the exact managed library sidecar (deleteOnDisk=%s)', async (deleteOnDisk) => {
      const id = newUuid();
      const ownerId = newUuid();
      const ownPath = StorageCore.getNestedPath(StorageFolder.Upload, ownerId, `${id}.xmp`);
      for (const path of [ownPath, '/source/original.jpg.xmp']) {
        mocks.job.queue.mockClear();
        const asset = AssetFactory.from({ id, ownerId, libraryId: newUuid(), isExternal: true })
          .file({ type: AssetFileType.Sidecar, path })
          .build();
        mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));

        await sut.handleAssetDeletion({ id, deleteOnDisk });

        const deleted = mocks.job.queue.mock.calls.flatMap(([item]) => (item.data as { files?: string[] }).files ?? []);
        expect(deleted).not.toContain(asset.originalPath);
        expect(deleted).not.toContain('/source/original.jpg.xmp');
        expect(deleted.includes(ownPath)).toBe(path === ownPath);
      }
    });

    it('deletes a managed asset without resolving an unrelated external sidecar path', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      const path = vi.spyOn(StorageCore, 'getNestedPath').mockImplementation(() => {
        throw new Error('No external sidecar storage configured');
      });
      try {
        await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });
        expect(path).not.toHaveBeenCalled();
      } finally {
        path.mockRestore();
      }
    });

    it('leaves the stack change to the removal, so a removal that rolls back leaves the stack (FL-179)', async () => {
      const asset = AssetFactory.from()
        .stack({}, (builder) => builder.asset())
        .build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      mocks.asset.remove.mockRejectedValueOnce(new Error('removal rolled back'));

      await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).rejects.toThrow(
        'removal rolled back',
      );

      expect(mocks.stack.delete).not.toHaveBeenCalled();
      expect(mocks.stack.update).not.toHaveBeenCalled();
    });

    it('releases both paths of a storage move that never committed (FL-179)', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Thumbnail }).build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      removedExtras = {
        pendingMoves: [
          {
            pathType: AssetPathType.Original,
            oldPath: asset.originalPath,
            newPath: '/data/library/2024/moved.jpg',
            stagedPath: '/data/library/2024/moved.jpg.m1.moving',
          },
          {
            pathType: AssetFileType.Thumbnail,
            oldPath: asset.files[0].path,
            newPath: '/data/thumbs/moved.webp',
            stagedPath: '/data/thumbs/moved.webp.m2.moving',
          },
        ],
      };

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: {
          files: [
            asset.files[0].path,
            asset.originalPath,
            '/data/library/2024/moved.jpg',
            '/data/library/2024/moved.jpg.m1.moving',
            '/data/thumbs/moved.webp',
            '/data/thumbs/moved.webp.m2.moving',
          ],
          removedAssetId: asset.id,
          original: expect.objectContaining({ assetId: asset.id }),
        },
      });
    });

    it("keeps both paths of a shared original's unfinished move: either can hold the only copy (FL-412)", async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Thumbnail }).build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      mocks.physicalFile.isOriginalShared.mockResolvedValue(true);
      removedExtras = {
        pendingMoves: [
          {
            pathType: AssetPathType.Original,
            oldPath: asset.originalPath,
            newPath: '/data/library/2024/moved.jpg',
            stagedPath: '/data/library/2024/moved.jpg.m1.moving',
          },
          {
            pathType: AssetFileType.Thumbnail,
            oldPath: asset.files[0].path,
            newPath: '/data/thumbs/moved.webp',
            stagedPath: '/data/thumbs/moved.webp.m2.moving',
          },
        ],
      };

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.physicalFile.isOriginalShared).toHaveBeenCalledWith(asset.id);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: {
          // the original itself stays reference-counted by FileDelete; the move's new path is never named
          files: [
            asset.files[0].path,
            asset.originalPath,
            '/data/library/2024/moved.jpg.m1.moving',
            '/data/thumbs/moved.webp',
            '/data/thumbs/moved.webp.m2.moving',
          ],
          removedAssetId: asset.id,
          original: expect.objectContaining({ assetId: asset.id }),
        },
      });
    });

    it('never releases the moved original of an external library item (FL-179)', async () => {
      const asset = AssetFactory.from({ libraryId: newUuid(), isExternal: true })
        .file({ type: AssetFileType.Thumbnail })
        .build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      removedExtras = {
        pendingMoves: [
          {
            pathType: AssetPathType.Original,
            oldPath: asset.originalPath,
            newPath: '/library/moved.jpg',
            stagedPath: '/library/moved.jpg.m1.moving',
          },
          {
            pathType: AssetFileType.Sidecar,
            oldPath: `${asset.originalPath}.xmp`,
            newPath: '/library/moved.jpg.xmp',
            stagedPath: '/library/moved.jpg.xmp.m2.moving',
          },
          {
            pathType: AssetFileType.Thumbnail,
            oldPath: asset.files[0].path,
            newPath: '/data/thumbs/moved.webp',
            stagedPath: '/data/thumbs/moved.webp.m3.moving',
          },
        ],
      };

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        // a staged copy is always Frameleaf's own; the library's own files are never released
        data: {
          files: [
            asset.files[0].path,
            '/library/moved.jpg.m1.moving',
            '/library/moved.jpg.xmp.m2.moving',
            '/data/thumbs/moved.webp',
            '/data/thumbs/moved.webp.m3.moving',
          ],
          removedAssetId: asset.id,
        },
      });
    });

    it('should delete a live photo', async () => {
      const motionAsset = AssetFactory.from({ type: AssetType.Video, visibility: AssetVisibility.Hidden }).build();
      const asset = AssetFactory.create({ livePhotoVideoId: motionAsset.id });
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      mocks.asset.getLivePhotoCount.mockResolvedValue(0);

      await sut.handleAssetDeletion({
        id: asset.id,
        deleteOnDisk: true,
      });

      // the file cleanup is queued with the removal (FL-169), the motion part after it
      expect(mocks.job.queue.mock.calls).toEqual([
        [
          {
            name: JobName.FileDelete,
            data: {
              files: [asset.originalPath],
              removedAssetId: asset.id,
              original: expect.objectContaining({ assetId: asset.id }),
            },
          },
        ],
        [{ name: JobName.AssetDelete, data: { id: motionAsset.id, deleteOnDisk: true } }],
      ]);
    });

    it('should not delete a live motion part if it is being used by another asset', async () => {
      const asset = AssetFactory.create({ livePhotoVideoId: newUuid() });
      mocks.asset.getLivePhotoCount.mockResolvedValue(2);
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.job.queue.mock.calls).toEqual([
        [
          {
            name: JobName.FileDelete,
            data: {
              files: [`/data/library/IMG_${asset.id}.jpg`],
              removedAssetId: asset.id,
              original: expect.objectContaining({ assetId: asset.id }),
            },
          },
        ],
      ]);
    });

    it('should update usage', async () => {
      const asset = AssetFactory.from().exif({ fileSizeInByte: 5000 }).build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });
      expect(mocks.user.updateUsage).toHaveBeenCalledWith(asset.ownerId, -5000);
    });

    it('keeps an asset restored from the trash since the deletion was queued (FL-71)', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Thumbnail }).build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue({ ...getForAssetDeletion(asset), deletedAt: null });
      mocks.asset.getLivePhotoCount.mockResolvedValue(0);

      await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.asset.remove).not.toHaveBeenCalled();
      expect(mocks.stack.delete).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('keeps a restored photo’s motion part while a photo still uses it (FL-71)', async () => {
      const motion = AssetFactory.from({ type: AssetType.Video, visibility: AssetVisibility.Hidden }).build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue({ ...getForAssetDeletion(motion), deletedAt: null });
      mocks.asset.getLivePhotoCount.mockResolvedValue(1);

      await expect(sut.handleAssetDeletion({ id: motion.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.asset.getLivePhotoCount).toHaveBeenCalledWith(motion.id);
      expect(mocks.asset.remove).not.toHaveBeenCalled();
    });

    it('deletes a motion part that no photo uses any more, though it was never trashed (FL-71)', async () => {
      const motion = AssetFactory.from({ type: AssetType.Video, visibility: AssetVisibility.Hidden }).build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue({ ...getForAssetDeletion(motion), deletedAt: null });
      mocks.asset.getLivePhotoCount.mockResolvedValue(0);

      await expect(sut.handleAssetDeletion({ id: motion.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.remove).toHaveBeenCalled();
    });

    describe('when a step fails (FL-169)', () => {
      it('queues the file cleanup inside the removal, so a failure to queue it keeps the asset', async () => {
        const asset = AssetFactory.from()
          .file({ type: AssetFileType.Thumbnail })
          .exif({ fileSizeInByte: 5000 })
          .build();
        mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
        // the repository runs the queue inside its transaction and rolls the removal back when it throws
        mocks.job.queue.mockRejectedValue(new Error('queue database unavailable'));

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).rejects.toThrow(
          'queue database unavailable',
        );

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.FileDelete,
          data: {
            files: [...asset.files.map(({ path }) => path), asset.originalPath],
            removedAssetId: asset.id,
            original: expect.objectContaining({ assetId: asset.id }),
          },
        });
        expect(mocks.user.updateUsage).not.toHaveBeenCalled();
        expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetDelete', expect.anything());
      });

      it('still succeeds, with its files queued, when announcing the deletion fails after the row is gone', async () => {
        const motionAsset = AssetFactory.from({ type: AssetType.Video, visibility: AssetVisibility.Hidden }).build();
        const asset = AssetFactory.from({ livePhotoVideoId: motionAsset.id }).exif({ fileSizeInByte: 5000 }).build();
        mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
        mocks.asset.getLivePhotoCount.mockResolvedValue(0);
        mocks.event.emit.mockRejectedValue(new Error('listener failed'));

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        expect(mocks.job.queue.mock.calls).toEqual([
          [
            {
              name: JobName.FileDelete,
              data: {
                files: [asset.originalPath],
                removedAssetId: asset.id,
                original: expect.objectContaining({ assetId: asset.id }),
              },
            },
          ],
          [{ name: JobName.AssetDelete, data: { id: motionAsset.id, deleteOnDisk: true } }],
        ]);
        expect(mocks.user.updateUsage).toHaveBeenCalledWith(asset.ownerId, -5000);
      });

      it('releases restoration and develop outputs with the asset, and never twice', async () => {
        const asset = AssetFactory.from().file({ type: AssetFileType.Thumbnail }).build();
        mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
        const thumbnailPath = asset.files[0]!.path;
        removedExtras = { derivedPaths: ['/data/restorations/result.jpg', '/data/develop/master.tif', thumbnailPath] };

        await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.FileDelete,
          data: {
            files: [thumbnailPath, '/data/restorations/result.jpg', '/data/develop/master.tif', asset.originalPath],
            removedAssetId: asset.id,
            original: expect.objectContaining({ assetId: asset.id }),
          },
        });
      });

      it('announces the deletion and releases the motion part though the usage update fails', async () => {
        const motionAsset = AssetFactory.from({ type: AssetType.Video, visibility: AssetVisibility.Hidden }).build();
        const asset = AssetFactory.create({ livePhotoVideoId: motionAsset.id });
        mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
        mocks.asset.getLivePhotoCount.mockResolvedValue(0);
        mocks.user.updateUsage.mockRejectedValue(new Error('database unavailable'));

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        expect(mocks.event.emit).toHaveBeenCalledWith('AssetDelete', { assetId: asset.id, userId: asset.ownerId });
        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.AssetDelete,
          data: { id: motionAsset.id, deleteOnDisk: true },
        });
      });

      it('does not fail the job when the motion part cannot be queued after the row is gone', async () => {
        const asset = AssetFactory.create({ livePhotoVideoId: newUuid() });
        mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
        mocks.asset.getLivePhotoCount.mockRejectedValue(new Error('database unavailable'));

        await expect(sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true })).resolves.toBe(JobStatus.Success);

        expect(mocks.job.queue.mock.calls).toEqual([
          [
            {
              name: JobName.FileDelete,
              data: {
                files: [asset.originalPath],
                removedAssetId: asset.id,
                original: expect.objectContaining({ assetId: asset.id }),
              },
            },
          ],
        ]);
      });
    });

    it('should fail if asset could not be found', async () => {
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(void 0);
      await expect(sut.handleAssetDeletion({ id: AssetFactory.create().id, deleteOnDisk: true })).resolves.toBe(
        JobStatus.Failed,
      );
    });
  });

  describe('copy sidecar (universal storage)', () => {
    const sidecar = (assetId: string, path: string) =>
      ({ id: `${assetId}-sidecar`, assetId, path, type: AssetFileType.Sidecar, isEdited: false }) as AssetFile;
    const forCopy = (id: string, dto: object) => ({
      id,
      ownerId: 'target-owner',
      stackId: null,
      isFavorite: false,
      originalPath: '/data/library/primary-owner/shared.jpg',
      physicalOriginalFileId: null,
      files: [] as AssetFile[],
      ...dto,
    });

    beforeEach(() => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['source', 'target']));
    });

    it('copies into a fresh managed directory without deleting a read-only library source sidecar', async () => {
      const root = await mkdtemp(join(tmpdir(), 'frameleaf-readonly-copy-'));
      const sourcePath = join(root, 'source.xmp');
      const ownPath = join(root, 'managed', 'nested', 'target.xmp');
      const path = vi.spyOn(StorageCore, 'getNestedPath').mockReturnValue(ownPath);
      try {
        await writeFile(sourcePath, 'synthetic metadata bytes');
        const source = forCopy('source', { files: [sidecar('source', sourcePath)] });
        const target = forCopy('target', {
          libraryReadOnly: true,
          physicalOriginalFileId: 'physical-file-id',
          files: [sidecar('target', '/source/original.jpg.xmp')],
        });
        mocks.asset.getForCopy.mockResolvedValueOnce(source as never).mockResolvedValueOnce(target as never);
        mocks.physicalFile.isOriginalCanonical.mockResolvedValue(true);
        mocks.storage.mkdirSync.mockImplementation((directory) => {
          mkdirSync(directory, { recursive: true });
        });
        mocks.storage.copyFile.mockImplementation(async (from, to) => copyFile(from, to));

        await sut.copy(authStub.user1, {
          sourceId: 'source',
          targetId: 'target',
          albums: false,
          sharedLinks: false,
          stack: false,
          favorite: false,
        });

        expect(await readFile(ownPath, 'utf8')).toBe('synthetic metadata bytes');
        expect(await readFile(sourcePath, 'utf8')).toBe('synthetic metadata bytes');
        expect(mocks.storage.copyFile).toHaveBeenCalledExactlyOnceWith(sourcePath, ownPath);
        expect(mocks.storage.unlink).not.toHaveBeenCalled();
        expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.FileDelete }));
      } finally {
        path.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    });

    it("writes a non-primary target's sidecar to its own upload path, not the primary owner's", async () => {
      const source = forCopy('source', { files: [sidecar('source', '/data/upload/source.xmp')] });
      const target = forCopy('target', {
        physicalOriginalFileId: 'physical-file-id',
        files: [sidecar('target', '/data/library/primary-owner/shared.jpg.xmp')],
      });
      mocks.asset.getForCopy.mockResolvedValueOnce(source as never).mockResolvedValueOnce(target as never);
      mocks.physicalFile.isOriginalCanonical.mockResolvedValue(false);
      const ownPath = StorageCore.getNestedPath(StorageFolder.Upload, 'target-owner', 'target.xmp');

      await sut.copy(authStub.user1, {
        sourceId: 'source',
        targetId: 'target',
        albums: false,
        sharedLinks: false,
        stack: false,
        favorite: false,
      });

      expect(mocks.storage.copyFile).toHaveBeenCalledWith('/data/upload/source.xmp', ownPath);
      expect(mocks.asset.upsertFile).toHaveBeenCalledWith({
        assetId: 'target',
        path: ownPath,
        type: AssetFileType.Sidecar,
      });
      // the sidecar beside the shared original is the primary owner's: never unlinked directly
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/data/library/primary-owner/shared.jpg.xmp'] },
      });
    });

    it('keeps writing a primary target beside its own original', async () => {
      const source = forCopy('source', { files: [sidecar('source', '/data/upload/source.xmp')] });
      const target = forCopy('target', { originalPath: '/data/library/target-owner/own.jpg' });
      mocks.asset.getForCopy.mockResolvedValueOnce(source as never).mockResolvedValueOnce(target as never);

      await sut.copy(authStub.user1, {
        sourceId: 'source',
        targetId: 'target',
        albums: false,
        sharedLinks: false,
        stack: false,
        favorite: false,
      });

      expect(mocks.storage.copyFile).toHaveBeenCalledWith(
        '/data/upload/source.xmp',
        '/data/library/target-owner/own.jpg.xmp',
      );
    });
  });

  describe('getOcr', () => {
    it('should require asset read permission', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.getOcr(authStub.admin, 'asset-1')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.ocr.getByAssetId).not.toHaveBeenCalled();
    });

    it('should return OCR data for an asset', async () => {
      const ocr1 = factory.assetOcr({ text: 'Hello World' });
      const ocr2 = factory.assetOcr({ text: 'Test Image' });
      const asset = AssetFactory.from().exif().build();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.ocr.getByAssetId.mockResolvedValue([ocr1, ocr2]);
      mocks.asset.getForOcr.mockResolvedValue({ edits: [], ...asset.exifInfo });

      await expect(sut.getOcr(authStub.admin, asset.id)).resolves.toEqual([ocr1, ocr2]);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set([asset.id]),
        undefined,
      );
      expect(mocks.ocr.getByAssetId).toHaveBeenCalledWith(asset.id);
    });

    it('should return empty array when no OCR data exists', async () => {
      const asset = AssetFactory.from().exif().build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.ocr.getByAssetId.mockResolvedValue([]);
      mocks.asset.getForOcr.mockResolvedValue({ edits: [], ...asset.exifInfo });
      await expect(sut.getOcr(authStub.admin, asset.id)).resolves.toEqual([]);

      expect(mocks.ocr.getByAssetId).toHaveBeenCalledWith(asset.id);
    });
  });

  describe('run', () => {
    it('should run the refresh faces job', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.run(authStub.admin, { assetIds: ['asset-1'], name: AssetJobName.REFRESH_FACES });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.AssetDetectFaces, data: { id: 'asset-1' } }]);
    });

    it('should run the refresh metadata job', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.run(authStub.admin, { assetIds: ['asset-1'], name: AssetJobName.REFRESH_METADATA });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetExtractMetadata, data: { id: 'asset-1' } },
      ]);
    });

    it('should run the text recognition job to read a photo again', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.run(authStub.admin, { assetIds: ['asset-1'], name: AssetJobName.REFRESH_OCR });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.Ocr, data: { id: 'asset-1' } }]);
    });

    it('should run the refresh thumbnails job', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.run(authStub.admin, { assetIds: ['asset-1'], name: AssetJobName.REGENERATE_THUMBNAIL });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetGenerateThumbnails, data: { id: 'asset-1' } },
      ]);
    });

    it('should run the transcode video', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));

      await sut.run(authStub.admin, { assetIds: ['asset-1'], name: AssetJobName.TRANSCODE_VIDEO });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.AssetEncodeVideo, data: { id: 'asset-1' } }]);
    });
  });

  describe('sensitive metadata origin admission', () => {
    it.each(['single', 'bulk'] as const)(
      'admits %s metadata before persisting an owner-sensitive review',
      async (action) => {
        const item = { key: AssetMetadataKey.MlEnrichment, value: { nsfwDetection: { review: { isNsfw: true } } } };
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
        mocks.asset.findLockGroupIds.mockResolvedValue(['asset-1', 'sibling']);
        mocks.partnerOrigin.withOriginEdit.mockRejectedValue(new Error('origin busy'));
        const edit =
          action === 'single'
            ? sut.upsertMetadata(authStub.admin, 'asset-1', { items: [item] })
            : sut.upsertBulkMetadata(authStub.admin, { items: [{ assetId: 'asset-1', ...item }] });
        await expect(edit).rejects.toThrow('origin busy');
        expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
        expect(mocks.asset.upsertBulkMetadata).not.toHaveBeenCalled();
        expect(mocks.asset.lock).not.toHaveBeenCalled();
      },
    );

    it.each(['single', 'bulk'] as const)(
      'records %s owner group overrides inside the metadata transaction',
      async (action) => {
        const ids = ['asset-1', 'sibling'];
        const item = { key: AssetMetadataKey.MlEnrichment, value: { nsfwDetection: { review: { isNsfw: true } } } };
        const trx = { isTransaction: true } as never;
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
        mocks.asset.findLockGroupIds.mockResolvedValue(ids);
        mocks.asset.lock.mockResolvedValue([]);
        mocks.database.withAssetMetadataLocks.mockImplementation((_ids, write) => write(trx));
        let committed = false;
        mocks.partnerOrigin.withOriginEdit.mockImplementation(async (_kind, admitted, _fields, write) => {
          expect(new Set(admitted)).toEqual(new Set(ids));
          const result = await write();
          expect(mocks.partnerOrigin.markOverridden).toHaveBeenCalledWith(
            'asset',
            ids,
            ['visibility'],
            authStub.admin.user.id,
            trx,
          );
          committed = true;
          return result;
        });
        if (action === 'single') await sut.upsertMetadata(authStub.admin, 'asset-1', { items: [item] });
        else await sut.upsertBulkMetadata(authStub.admin, { items: [{ assetId: 'asset-1', ...item }] });
        expect(committed).toBe(true);
        expect(mocks.asset.lockGroupRows).toHaveBeenCalledWith(['asset-1'], trx);
      },
    );

    it('prepares detection policy before metadata writes can commit', async () => {
      const item = {
        key: AssetMetadataKey.MlEnrichment,
        value: { nsfwDetection: { status: 'success', result: { isNsfw: true } } },
      };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      vi.spyOn(sut, 'getConfig').mockRejectedValue(new Error('policy unavailable'));
      await expect(sut.upsertMetadata(authStub.admin, 'asset-1', { items: [item] })).rejects.toThrow(
        'policy unavailable',
      );
      expect(mocks.asset.upsertMetadata).not.toHaveBeenCalled();
      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });

    it('keeps a detection-only metadata lock free of owner overrides', async () => {
      const item = {
        key: AssetMetadataKey.MlEnrichment,
        value: { nsfwDetection: { status: 'success', result: { isNsfw: true } } },
      };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.findLockGroupIds.mockResolvedValue(['asset-1', 'sibling']);
      mocks.asset.lock.mockResolvedValue([]);
      vi.spyOn(sut, 'getConfig').mockResolvedValue({
        ...defaults,
        machineLearning: {
          ...defaults.machineLearning,
          nsfwDetection: { ...defaults.machineLearning.nsfwDetection, hideFromLibrary: true },
        },
      });
      await sut.upsertMetadata(authStub.admin, 'asset-1', { items: [item] });
      expect(mocks.asset.lock).toHaveBeenCalledWith(['asset-1'], AssetLockReason.Detected, null);
      expect(mocks.partnerOrigin.markOverridden).not.toHaveBeenCalled();
    });
  });

  describe('upsertMetadata', () => {
    beforeEach(() => {
      mocks.asset.findLockGroupIds.mockImplementation((ids) => Promise.resolve(ids));
    });
    it('should throw a bad request exception if duplicate keys are sent', async () => {
      const asset = AssetFactory.create();
      const items = [
        { key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
        { key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
      ];

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));

      await expect(sut.upsertMetadata(authStub.admin, asset.id, { items })).rejects.toThrowError(
        'Duplicate items are not allowed:',
      );

      expect(mocks.asset.upsertBulkMetadata).not.toHaveBeenCalled();
    });

    it('should lock an asset whose owner review marks it sensitive (FL-34)', async () => {
      const asset = AssetFactory.create();
      const value = { nsfwDetection: { review: { action: 'marked-nsfw', isNsfw: true } } };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.upsertMetadata.mockResolvedValue([]);

      await sut.upsertMetadata(authStub.admin, asset.id, { items: [{ key: AssetMetadataKey.MlEnrichment, value }] });

      expect(mocks.asset.lock).toHaveBeenCalledWith([asset.id], AssetLockReason.Marked, authStub.admin.user.id);
    });

    it('should not lock a detection while hiding sensitive detections is off (FL-34)', async () => {
      const asset = AssetFactory.create();
      const value = { nsfwDetection: { status: 'success', result: { isNsfw: true, score: 0.99, labels: {} } } };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.upsertMetadata.mockResolvedValue([]);

      await sut.upsertMetadata(authStub.admin, asset.id, { items: [{ key: AssetMetadataKey.MlEnrichment, value }] });

      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });
  });

  describe('upsertBulkMetadata', () => {
    it('should throw a bad request exception if duplicate keys are sent', async () => {
      const asset = AssetFactory.create();
      const items = [
        { assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
        { assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
      ];

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));

      await expect(sut.upsertBulkMetadata(authStub.admin, { items })).rejects.toThrowError(
        'Duplicate items are not allowed:',
      );

      expect(mocks.asset.upsertBulkMetadata).not.toHaveBeenCalled();
    });
  });

  describe.each(['upsertMetadata', 'upsertBulkMetadata'] as const)('%s metadata review validation', (method) => {
    beforeEach(() => {
      mocks.asset.findLockGroupIds.mockImplementation((ids) => Promise.resolve(ids));
    });
    it.each([
      [{}, AssetLockReason.Detected],
      [{ isNsfw: 'false' }, AssetLockReason.Detected],
      [{ isNsfw: null }, AssetLockReason.Detected],
      [{ isNsfw: false }, null],
      [{ isNsfw: true }, AssetLockReason.Marked],
    ] as const)('uses review %j with lock reason %s', async (review, reason) => {
      const asset = AssetFactory.create();
      const item = {
        key: AssetMetadataKey.MlEnrichment,
        value: { nsfwDetection: { status: 'success', result: { isNsfw: true }, review } },
      };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.upsertMetadata.mockResolvedValue([]);
      mocks.asset.upsertBulkMetadata.mockResolvedValue([]);
      vi.spyOn(sut, 'getConfig').mockResolvedValue({
        ...defaults,
        machineLearning: {
          ...defaults.machineLearning,
          nsfwDetection: { ...defaults.machineLearning.nsfwDetection, hideFromLibrary: true },
        },
      });

      if (method === 'upsertMetadata') {
        await sut.upsertMetadata(authStub.admin, asset.id, { items: [item] });
      } else {
        await sut.upsertBulkMetadata(authStub.admin, { items: [{ assetId: asset.id, ...item }] });
      }

      if (reason === null) {
        expect(mocks.asset.lock).not.toHaveBeenCalled();
      } else {
        expect(mocks.asset.lock).toHaveBeenCalledWith(
          [asset.id],
          reason,
          reason === AssetLockReason.Marked ? authStub.admin.user.id : null,
        );
      }
    });
  });

  describe('video version operations', () => {
    it('does not expose history without edit access', async () => {
      await expect(sut.getVideoEditVersions(authStub.admin, 'asset-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.assetEdit.listVideoVersions).not.toHaveBeenCalled();
    });

    it('queues only the export version and hides internal paths from the response', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.assetEdit.createVideoExport.mockResolvedValue({
        id: 'version-1',
        assetId: 'asset-1',
        purpose: 'export',
        status: 'pending',
        createdAt: new Date('2026-01-01'),
        recipe: [],
        sourcePath: '/private/original',
      } as any);
      mocks.job.queue.mockResolvedValue(undefined);
      const result = await sut.exportVideoEditVersion(authStub.admin, 'asset-1');
      expect(result).not.toHaveProperty('sourcePath');
      expect(mocks.assetEdit.createVideoExport).toHaveBeenCalledWith('asset-1', authStub.admin.user.id);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetVideoEditGeneration,
        data: { id: 'asset-1', versionId: 'version-1', operationId: 'op-1' },
      });
    });

    it('restores an original (empty-recipe) version with edit create permission only', async () => {
      mocks.access.asset.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(new Set(ids)));
      mocks.assetEdit.getVideoVersion.mockResolvedValue({
        ownerId: authStub.admin.user.id,
        status: 'ready',
        recipe: [],
      } as any);
      mocks.asset.getById.mockResolvedValue({ id: 'asset-1', type: AssetType.Video, files: [] } as any);
      mocks.assetEdit.replaceAll.mockResolvedValue([]);
      mocks.assetEdit.getRequestedVideoVersion.mockResolvedValue({ id: 'version-2' } as any);
      const requireAccess = vi.spyOn(sut as any, 'requireAccess');
      await sut.restoreVideoEditVersion(authStub.admin, 'asset-1', 'version-1');
      expect(mocks.assetEdit.replaceAll).toHaveBeenCalledWith('asset-1', [], 'revert');
      expect(requireAccess.mock.calls.map(([options]: any) => options.permission)).toEqual([
        Permission.AssetEditCreate,
      ]);
    });

    it('rejects a ready version owned by a different user before restoring its recipe', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.assetEdit.getVideoVersion.mockResolvedValue({ ownerId: 'other', status: 'ready', recipe: [] } as any);
      await expect(sut.restoreVideoEditVersion(authStub.admin, 'asset-1', 'version-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
    });

    it.each([
      ['video_version_selected_or_missing', BadRequestException],
      ['video_version_inactive', BadRequestException],
      ['video_version_not_found', NotFoundException],
    ])('maps a %s refusal to a client error and deletes nothing', async (code, type) => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.assetEdit.pruneVideoVersion.mockRejectedValue(new Error(code));
      await expect(sut.pruneVideoEditVersion(authStub.admin, 'asset-1', 'version-1')).rejects.toBeInstanceOf(type);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('queues only the unreferenced files of a pruned version', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.assetEdit.pruneVideoVersion.mockResolvedValue(['/master.mp4', '/master.mp4.lineage.json']);
      await sut.pruneVideoEditVersion(authStub.admin, 'asset-1', 'version-1');
      expect(mocks.assetEdit.pruneVideoVersion).toHaveBeenCalledWith('asset-1', 'version-1', authStub.admin.user.id);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/master.mp4', '/master.mp4.lineage.json'] },
      });
    });

    it('keeps history-owned edited files when reverting a retained video to the original', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getById.mockResolvedValue({
        id: 'asset-1',
        type: AssetType.Video,
        files: [{ id: 'file-1', path: '/proxy.mp4', type: AssetFileType.EncodedVideo, isEdited: true }],
      } as any);
      mocks.assetEdit.replaceAll.mockResolvedValue([]);
      mocks.assetEdit.getRequestedVideoVersion.mockResolvedValue({ id: 'version-2' } as any);
      await sut.removeAssetEdits(authStub.admin, 'asset-1');
      expect(mocks.assetEdit.replaceAll).toHaveBeenCalledWith('asset-1', [], 'save');
      expect(mocks.asset.deleteFiles).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
        name: JobName.AssetVideoEditGeneration,
        data: { id: 'asset-1', operationId: 'op-1' },
      });
    });
  });

  describe('original video edit metadata', () => {
    beforeEach(() => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getById.mockResolvedValue({
        type: AssetType.Video,
        duration: 5000,
        originalPath: '/original.mp4',
      } as any);
      mocks.assetEdit.getAll.mockResolvedValue([]);
    });

    it('lists the original keyframes in milliseconds for the fast trim (FL-113)', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [
          { index: 0, width: 1920, height: 1080, rotation: 0, timeBase: 600, timeBaseRational: { num: 1, den: 600 } },
        ],
      } as any);
      mocks.media.probePackets.mockResolvedValue({ startPts: 300, keyframePts: [300, 1500, 1500, 2700] } as any);
      await expect(sut.getAssetEditKeyframes(authStub.admin, 'asset-1')).resolves.toEqual({
        keyframesMs: [0, 2000, 4000],
      });
      expect(mocks.media.probePackets).toHaveBeenCalledWith('/original.mp4', 0);
    });

    it('refuses keyframes for a photo', async () => {
      mocks.asset.getById.mockResolvedValue({ type: AssetType.Image, originalPath: '/a.jpg' } as any);
      await expect(sut.getAssetEditKeyframes(authStub.admin, 'asset-1')).rejects.toThrow('not a video');
    });

    it('returns the rotated original raster and timeline instead of current render metadata', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [{ width: 1920, height: 1080, rotation: -90, pixelFormat: 'yuv420p' }],
      } as any);
      await expect(sut.getAssetEdits(authStub.admin, 'asset-1')).resolves.toMatchObject({
        originalVideo: { width: 1080, height: 1920, durationMs: 30_000 },
      });
      expect(mocks.media.probe).toHaveBeenCalledWith('/original.mp4');
    });

    it('validates a larger crop and longer trim against the original instead of edited metadata', async () => {
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 5000,
        originalPath: '/original.mp4',
        originalFileName: 'original.mp4',
        livePhotoVideoId: null,
        exifImageWidth: 640,
        exifImageHeight: 360,
        orientation: null,
        projectionType: null,
      });
      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [{ width: 1920, height: 1080, rotation: 0, pixelFormat: 'yuv420p' }],
      } as any);
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 600 } },
        { action: AssetEditAction.Trim, parameters: { startMs: 0, endMs: 25_000 } },
      ];
      mocks.assetEdit.replaceAll.mockResolvedValue([]);
      await expect(sut.editAsset(authStub.admin, 'asset-1', { edits })).resolves.toMatchObject({ assetId: 'asset-1' });
      expect(mocks.assetEdit.replaceAll).toHaveBeenCalledWith('asset-1', edits, 'save');
      await expect(
        sut.editAsset(authStub.admin, 'asset-1', {
          edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1922, height: 1080 } }],
        }),
      ).rejects.toThrow('Crop parameters are out of bounds');
    });

    describe('the default trim mode (FL-422)', () => {
      const trim = { action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 4000 } } as const;
      const fastTrim = { ...trim, parameters: { ...trim.parameters, mode: VideoTrimMode.Fast } };

      beforeEach(() => {
        mocks.asset.getForEdit.mockResolvedValue({
          type: AssetType.Video,
          duration: 5000,
          originalPath: '/original.mp4',
          originalFileName: 'original.mp4',
          livePhotoVideoId: null,
          exifImageWidth: 1920,
          exifImageHeight: 1080,
          orientation: null,
          projectionType: null,
        });
        mocks.media.probe.mockResolvedValue({
          format: { duration: 30 },
          videoStreams: [{ width: 1920, height: 1080, rotation: 0, pixelFormat: 'yuv420p' }],
        } as any);
        mocks.assetEdit.replaceAll.mockResolvedValue([]);
      });

      it('cuts a trim that names no mode fast when the setting says Fast', async () => {
        mocks.systemMetadata.get.mockResolvedValue({ editing: { trimMode: VideoTrimMode.Fast } });
        await sut.editAsset(authStub.admin, 'asset-1', { edits: [trim] });
        expect(mocks.assetEdit.replaceAll).toHaveBeenCalledWith('asset-1', [fastTrim], 'save');
      });

      it('keeps a trim that names its mode, whatever the setting says', async () => {
        mocks.systemMetadata.get.mockResolvedValue({ editing: { trimMode: VideoTrimMode.Fast } });
        const precise = { ...trim, parameters: { ...trim.parameters, mode: VideoTrimMode.Precise } };
        await sut.editAsset(authStub.admin, 'asset-1', { edits: [precise] });
        expect(mocks.assetEdit.replaceAll).toHaveBeenCalledWith('asset-1', [precise], 'save');
      });

      it('leaves the recipe as sent with the default setting, so a missing mode stays precise', async () => {
        await sut.editAsset(authStub.admin, 'asset-1', { edits: [trim] });
        expect(mocks.assetEdit.replaceAll).toHaveBeenCalledWith('asset-1', [trim], 'save');
      });

      it('puts a version or a preserved recipe back exactly', async () => {
        mocks.systemMetadata.get.mockResolvedValue({ editing: { trimMode: VideoTrimMode.Fast } });
        await sut.editAsset(authStub.admin, 'asset-1', { edits: [trim] }, 'revert');
        expect(mocks.assetEdit.replaceAll).toHaveBeenLastCalledWith('asset-1', [trim], 'revert');
        await sut.editAsset(authStub.admin, 'asset-1', { edits: [trim] }, 'save', { exact: true });
        expect(mocks.assetEdit.replaceAll).toHaveBeenLastCalledWith('asset-1', [trim], 'save');
      });
    });

    it.each([
      { format: { duration: 30 }, videoStreams: [] },
      { format: { duration: NaN }, videoStreams: [{ width: 1920, height: 1080, rotation: 0, pixelFormat: 'yuv420p' }] },
      { format: { duration: 30 }, videoStreams: [{ width: 0, height: 1080, rotation: 0, pixelFormat: 'yuv420p' }] },
    ])('omits unavailable original metadata when listing and refuses to save against it: %j', async (source) => {
      mocks.media.probe.mockResolvedValue(source as any);
      const listed = await sut.getAssetEdits(authStub.admin, 'asset-1');
      expect(listed).toEqual({ assetId: 'asset-1', edits: [] });
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 5000,
        originalPath: '/original.mp4',
        originalFileName: 'original.mp4',
        livePhotoVideoId: null,
        exifImageWidth: 640,
        exifImageHeight: 360,
        orientation: null,
        projectionType: null,
      });
      await expect(
        sut.editAsset(authStub.admin, 'asset-1', {
          edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }],
        }),
      ).rejects.toThrow('Original video metadata');
      expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
    });

    it('says what an edited version does with HDR and Dolby Vision originals (FL-113)', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [
          { width: 1920, height: 1080, rotation: 0, pixelFormat: 'yuv420p', colorTransfer: 16, dvProfile: null },
        ],
      } as any);
      await expect(sut.getAssetEdits(authStub.admin, 'asset-1')).resolves.toMatchObject({
        originalVideo: { colorPolicy: 'tone-map', colorReason: expect.stringContaining('HDR original is preserved') },
      });

      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [
          { width: 1920, height: 1080, rotation: 0, pixelFormat: 'yuv420p', colorTransfer: 1, dvProfile: null },
        ],
      } as any);
      await expect(sut.getAssetEdits(authStub.admin, 'asset-1')).resolves.toMatchObject({
        originalVideo: { colorPolicy: 'preserve' },
      });
    });

    it('refuses to queue an edit of a Dolby Vision profile 5 original, and still allows reverting (FL-113)', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [
          { width: 1920, height: 1080, rotation: 0, pixelFormat: 'yuv420p', colorTransfer: 16, dvProfile: 5 },
        ],
      } as any);
      await expect(sut.getAssetEdits(authStub.admin, 'asset-1')).resolves.toMatchObject({
        originalVideo: { colorPolicy: 'unsupported', colorReason: expect.stringContaining('Dolby Vision profile 5') },
      });
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 30_000,
        originalPath: '/original.mp4',
        originalFileName: 'original.mp4',
        livePhotoVideoId: null,
        exifImageWidth: 1920,
        exifImageHeight: 1080,
        orientation: null,
        projectionType: null,
      });
      await expect(
        sut.editAsset(authStub.admin, 'asset-1', {
          edits: [{ action: AssetEditAction.Trim, parameters: { startMs: 0, endMs: 10_000 } }],
        }),
      ).rejects.toThrow('Dolby Vision profile 5');
      expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'Dolby Vision profile 7',
        stream: { dvProfile: 7, dvBlSignalCompatibilityId: 6 },
        refusal: 'dolbyVisionEnhancementLayer',
      },
      {
        name: 'Dolby Vision profile 4',
        stream: { dvProfile: 4, dvBlSignalCompatibilityId: 2 },
        refusal: 'dolbyVisionProfileUnqualified',
      },
      {
        name: 'Dolby Vision profile 9',
        stream: { dvProfile: 9, dvBlSignalCompatibilityId: 2 },
        refusal: 'dolbyVisionProfileUnqualified',
      },
      {
        name: 'Dolby Vision profile 10',
        stream: { dvProfile: 10, dvBlSignalCompatibilityId: 1 },
        refusal: 'dolbyVisionProfileUnqualified',
      },
      {
        name: 'Dolby Vision profile 8 with no base layer',
        stream: { dvProfile: 8, dvBlSignalCompatibilityId: 0 },
        refusal: 'dolbyVisionBaseLayerUnknown',
      },
      { name: 'a 16-bit source', stream: { pixelFormat: 'yuv444p16le' }, refusal: 'unsupportedBitDepth' },
      {
        name: 'an undescribable pixel format',
        stream: { pixelFormat: 'bayer_rggb16le' },
        refusal: 'unknownPixelFormat',
      },
    ])(
      'refuses $name before editing and refuses the save, but still allows reverting (FL-101)',
      async ({ stream, refusal }) => {
        mocks.media.probe.mockResolvedValue({
          format: { duration: 30 },
          videoStreams: [
            {
              width: 1920,
              height: 1080,
              rotation: 0,
              pixelFormat: 'yuv420p10le',
              colorTransfer: 16,
              dvProfile: null,
              ...stream,
            },
          ],
        } as any);
        await expect(sut.getAssetEdits(authStub.admin, 'asset-1')).resolves.toMatchObject({
          originalVideo: { colorPolicy: 'unsupported', colorReason: expect.any(String), decodeRefusal: refusal },
        });
        mocks.asset.getForEdit.mockResolvedValue({
          type: AssetType.Video,
          duration: 30_000,
          originalPath: '/original.mp4',
          originalFileName: 'original.mp4',
          livePhotoVideoId: null,
          exifImageWidth: 1920,
          exifImageHeight: 1080,
          orientation: null,
          projectionType: null,
        });
        await expect(
          sut.editAsset(authStub.admin, 'asset-1', {
            edits: [{ action: AssetEditAction.Trim, parameters: { startMs: 0, endMs: 10_000 } }],
          }),
        ).rejects.toThrow(BadRequestException);
        expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();

        mocks.assetEdit.replaceAll.mockResolvedValue([]);
        await expect(sut.editAsset(authStub.admin, 'asset-1', { edits: [] }, 'revert')).resolves.toMatchObject({
          assetId: 'asset-1',
        });
      },
    );

    it('does not report a decode refusal for a qualified Dolby Vision 8.1 source (FL-101)', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [
          {
            width: 1920,
            height: 1080,
            rotation: 0,
            pixelFormat: 'yuv420p10le',
            colorTransfer: 16,
            dvProfile: 8,
            dvBlSignalCompatibilityId: 1,
          },
        ],
      } as any);
      const { originalVideo } = await sut.getAssetEdits(authStub.admin, 'asset-1');
      expect(originalVideo?.colorPolicy).not.toBe('unsupported');
      expect(originalVideo).not.toHaveProperty('decodeRefusal');
    });

    it('swaps the raster for any quarter-turn display rotation', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [{ width: 1920, height: 1080, rotation: 270, pixelFormat: 'yuv420p' }],
      } as any);
      await expect(sut.getAssetEdits(authStub.admin, 'asset-1')).resolves.toMatchObject({
        originalVideo: { width: 1080, height: 1920 },
      });
    });
  });

  describe('editAsset', () => {
    beforeEach(() => {
      mocks.media.probe.mockResolvedValue({
        format: { duration: 10 },
        videoStreams: [{ width: 1920, height: 1080, rotation: 0, pixelFormat: 'yuv420p' }],
        audioStreams: [],
      } as any);
    });
    it('should enforce crop first', async () => {
      await expect(
        sut.editAsset(authStub.admin, 'asset-1', {
          edits: [
            {
              action: AssetEditAction.Rotate,
              parameters: { angle: 90 },
            },
            {
              action: AssetEditAction.Crop,
              parameters: { x: 0, y: 0, width: 100, height: 100 },
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
    });

    it('should allow video edits and queue video edit generation', async () => {
      const edit: AssetEditActionItem = {
        action: AssetEditAction.Trim,
        parameters: { startMs: 1000, endMs: 5000 },
      };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 10_000,
        livePhotoVideoId: null,
        originalPath: '/upload/video.mp4',
        originalFileName: 'video.mp4',
        exifImageWidth: 1920,
        exifImageHeight: 1080,
        orientation: null,
        projectionType: null,
      });
      mocks.assetEdit.replaceAll.mockResolvedValue([{ id: 'edit-1', ...edit }]);

      await expect(sut.editAsset(authStub.admin, 'asset-1', { edits: [edit] })).resolves.toEqual({
        assetId: 'asset-1',
        edits: [{ id: 'edit-1', ...edit }],
      });

      expect(mocks.assetEdit.replaceAll).toHaveBeenCalledWith('asset-1', [edit], 'save');
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetVideoEditGeneration,
        data: { id: 'asset-1', operationId: 'op-1' },
      });
    });

    it('records a video edit as a job in Activity, naming the version it will render (FL-43)', async () => {
      const edit: AssetEditActionItem = { action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 5000 } };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 10_000,
        livePhotoVideoId: null,
        originalPath: '/upload/video.mp4',
        originalFileName: 'video.mp4',
        exifImageWidth: 1920,
        exifImageHeight: 1080,
        orientation: null,
        projectionType: null,
      });
      mocks.assetEdit.replaceAll.mockResolvedValue([{ id: 'edit-1', ...edit }]);
      mocks.assetEdit.getRequestedVideoVersion.mockResolvedValue({ id: 'version-1' } as never);
      mocks.mediaOperation.create.mockResolvedValue({ id: 'op-1' } as never);

      await sut.editAsset(authStub.admin, 'asset-1', { edits: [edit] });

      expect(mocks.mediaOperation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: authStub.admin.user.id,
          kind: 'quick_edit',
          label: 'video.mp4',
          assetId: 'asset-1',
          revisionId: 'version-1',
          settings: { edit: 'video_edit' },
        }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetVideoEditGeneration,
        data: { id: 'asset-1', operationId: 'op-1' },
      });
    });

    it('records a photo edit as a job in Activity (FL-43)', async () => {
      const edit: AssetEditActionItem = { action: AssetEditAction.Rotate, parameters: { angle: 90 } };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Image,
        duration: null,
        livePhotoVideoId: null,
        originalPath: '/upload/photo.jpg',
        originalFileName: 'photo.jpg',
        exifImageWidth: 1920,
        exifImageHeight: 1080,
        orientation: null,
        projectionType: null,
      });
      mocks.assetEdit.replaceAll.mockResolvedValue([{ id: 'edit-1', ...edit }]);
      mocks.mediaOperation.create.mockResolvedValue({ id: 'op-2' } as never);

      await sut.editAsset(authStub.admin, 'asset-1', { edits: [edit] });

      expect(mocks.mediaOperation.create).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'photo.jpg', revisionId: null, settings: { edit: 'photo_edit' } }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetEditThumbnailGeneration,
        data: { id: 'asset-1', operationId: 'op-2' },
      });
    });

    it('records a video export as its own job, pointing at the exported version (FL-43)', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.assetEdit.createVideoExport.mockResolvedValue({
        id: 'version-2',
        purpose: 'export',
        status: 'pending',
        createdAt: new Date('2026-09-25T10:00:00.000Z'),
        recipe: [],
      } as never);
      mocks.asset.getById.mockResolvedValue({ id: 'asset-1', originalFileName: 'video.mp4' } as never);
      mocks.mediaOperation.create.mockResolvedValue({ id: 'op-3' } as never);

      await sut.exportVideoEditVersion(authStub.admin, 'asset-1');

      expect(mocks.mediaOperation.create).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'video.mp4', revisionId: 'version-2', settings: { edit: 'video_export' } }),
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetVideoEditGeneration,
        data: { id: 'asset-1', versionId: 'version-2', operationId: 'op-3' },
      });
    });

    it('should reject video trim parameters outside the duration', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 10_000,
        livePhotoVideoId: null,
        originalPath: '/upload/video.mp4',
        originalFileName: 'video.mp4',
        exifImageWidth: 1920,
        exifImageHeight: 1080,
        orientation: null,
        projectionType: null,
      });

      await expect(
        sut.editAsset(authStub.admin, 'asset-1', {
          edits: [{ action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 11_000 } }],
        }),
      ).rejects.toThrow('Trim parameters are out of bounds');

      expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
    });

    it.each<[string, AssetEditActionItem, string]>([
      [
        'speed',
        { action: AssetEditAction.Speed, parameters: { rate: 0.5, startMs: 500, endMs: 900 } },
        'speed parameters must be within the trimmed video range',
      ],
      [
        'text overlay',
        {
          action: AssetEditAction.TextOverlay,
          parameters: { text: 'Hello', x: 0.5, y: 0.5, startMs: 9000, endMs: 9500, size: 0.06, color: '#ffffff' },
        },
        'textOverlay parameters must be within the trimmed video range',
      ],
    ])('should reject video %s parameters outside the trimmed range', async (_name, timedEdit, message) => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 10_000,
        livePhotoVideoId: null,
        originalPath: '/upload/video.mp4',
        originalFileName: 'video.mp4',
        exifImageWidth: 1920,
        exifImageHeight: 1080,
        orientation: null,
        projectionType: null,
      });

      await expect(
        sut.editAsset(authStub.admin, 'asset-1', {
          edits: [{ action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 8000 } }, timedEdit],
        }),
      ).rejects.toThrow(message);

      expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
    });

    it('should allow non-overlapping video speed segments', async () => {
      const edit: AssetEditActionItem = {
        action: AssetEditAction.Speed,
        parameters: { rate: 0.5, startMs: 1000, endMs: 3000 },
      };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 10_000,
        livePhotoVideoId: null,
        originalPath: '/upload/video.mp4',
        originalFileName: 'video.mp4',
        exifImageWidth: 1920,
        exifImageHeight: 1080,
        orientation: null,
        projectionType: null,
      });
      mocks.assetEdit.replaceAll.mockResolvedValue([{ id: 'edit-1', ...edit }]);

      await expect(sut.editAsset(authStub.admin, 'asset-1', { edits: [edit] })).resolves.toEqual({
        assetId: 'asset-1',
        edits: [{ id: 'edit-1', ...edit }],
      });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetVideoEditGeneration,
        data: { id: 'asset-1', operationId: 'op-1' },
      });
    });

    it('accepts a whole-clip speed with speed ranges, and refuses two whole-clip speeds (FL-113)', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 10_000,
        livePhotoVideoId: null,
        originalPath: '/upload/video.mp4',
        originalFileName: 'video.mp4',
        exifImageWidth: 1920,
        exifImageHeight: 1080,
        orientation: null,
        projectionType: null,
      });
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Speed, parameters: { rate: 2 } },
        { action: AssetEditAction.Speed, parameters: { rate: 0.5, startMs: 1000, endMs: 3000 } },
      ];
      mocks.assetEdit.replaceAll.mockResolvedValue(edits.map((edit, index) => ({ id: `edit-${index}`, ...edit })));
      await expect(sut.editAsset(authStub.admin, 'asset-1', { edits })).resolves.toMatchObject({ assetId: 'asset-1' });

      await expect(
        sut.editAsset(authStub.admin, 'asset-1', {
          edits: [
            { action: AssetEditAction.Speed, parameters: { rate: 2 } },
            { action: AssetEditAction.Speed, parameters: { rate: 4 } },
          ],
        }),
      ).rejects.toThrow('Only one whole-clip speed edit is allowed');
    });

    it('should reject overlapping video speed segments', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.asset.getForEdit.mockResolvedValue({
        type: AssetType.Video,
        duration: 10_000,
        livePhotoVideoId: null,
        originalPath: '/upload/video.mp4',
        originalFileName: 'video.mp4',
        exifImageWidth: 1920,
        exifImageHeight: 1080,
        orientation: null,
        projectionType: null,
      });

      await expect(
        sut.editAsset(authStub.admin, 'asset-1', {
          edits: [
            { action: AssetEditAction.Speed, parameters: { rate: 0.5, startMs: 1000, endMs: 4000 } },
            { action: AssetEditAction.Speed, parameters: { rate: 2, startMs: 3000, endMs: 5000 } },
          ],
        }),
      ).rejects.toThrow('Speed segments cannot overlap');

      expect(mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
    });
  });
});
