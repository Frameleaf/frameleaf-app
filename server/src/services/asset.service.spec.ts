import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { AssetJobName, AssetStatsResponseDto } from 'src/dtos/asset.dto.js';
import { AssetEditAction, type AssetEditActionItem } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetLockReason,
  AssetMetadataKey,
  AssetStatus,
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  Permission,
} from 'src/enum.js';
import { AssetStats } from 'src/repositories/asset.repository.js';
import { AssetService } from 'src/services/asset.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { PartnerFactory } from 'test/factories/partner.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForAsset, getForAssetDeletion, getForPartner } from 'test/mappers.js';
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

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AssetService));
    mocks.partner.getAll.mockResolvedValue([]);
    mocks.duplicateRepository.getVideoDuplicateFrames.mockResolvedValue([]);
    mocks.asset.remove.mockImplementation((asset) =>
      Promise.resolve({
        originalPath: (asset as unknown as { originalPath: string }).originalPath,
        reservationTemporaryPath: null,
      }),
    );
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

    it("should hide location on a partner's asset when the partner turned location sharing off", async () => {
      const auth = AuthFactory.create();
      const sharer = UserFactory.create();
      const partner = PartnerFactory.from({ shareLocation: false })
        .sharedBy(sharer)
        .sharedWith({ id: auth.user.id })
        .build();
      const asset = AssetFactory.from({ ownerId: sharer.id })
        .exif({ latitude: 42, longitude: 69, city: 'Calgary', state: 'Alberta', country: 'Canada', make: 'Canon' })
        .build();
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.partner.getAll.mockResolvedValue([getForPartner(partner)]);

      const response = (await sut.get(auth, asset.id)) as AssetResponseDto;

      expect(mocks.partner.getAll).toHaveBeenCalledWith(auth.user.id);
      expect(response.exifInfo).toEqual(
        expect.objectContaining({
          latitude: null,
          longitude: null,
          city: null,
          state: null,
          country: null,
          make: 'Canon',
        }),
      );
    });

    it("should keep location on a partner's asset while location sharing is on", async () => {
      const auth = AuthFactory.create();
      const sharer = UserFactory.create();
      const partner = PartnerFactory.from({ shareLocation: true })
        .sharedBy(sharer)
        .sharedWith({ id: auth.user.id })
        .build();
      const asset = AssetFactory.from({ ownerId: sharer.id })
        .exif({ latitude: 42, longitude: 69, city: 'Calgary' })
        .build();
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      mocks.partner.getAll.mockResolvedValue([getForPartner(partner)]);

      const response = (await sut.get(auth, asset.id)) as AssetResponseDto;

      expect(response.exifInfo).toEqual(expect.objectContaining({ latitude: 42, longitude: 69, city: 'Calgary' }));
    });

    it('should never consult the partner policy for the owner of the asset', async () => {
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
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));

      await sut.get(authStub.admin, asset.id);

      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set([asset.id]));
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

  describe('update', () => {
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
      const stillAsset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([stillAsset.id]));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(motionAsset));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(stillAsset));
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
      const asset = AssetFactory.create({ livePhotoVideoId: motionAsset.id });
      const unlinkedAsset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(asset));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(motionAsset));
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(unlinkedAsset));
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

  describe('updateAll', () => {
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
      expect(mocks.asset.updateAllExif).toHaveBeenCalledWith(['asset-1'], { latitude: 0, longitude: 0 });
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
      expect(mocks.asset.updateAllExif).toHaveBeenCalledWith(['asset-1'], {
        dateTimeOriginal,
        latitude: 30,
        longitude: 50,
      });
      expect(mocks.asset.updateAll).toHaveBeenCalledWith(
        ['asset-1'],
        expect.objectContaining({
          fileCreatedAt: new Date(dateTimeOriginal),
          localDateTime: new Date(dateTimeOriginal),
        }),
      );
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.SidecarWrite, data: { id: 'asset-1' } }]);
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
  });

  describe('deleteAll', () => {
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

      await sut.deleteAll(authStub.user1, { ids: ['asset1', 'asset2'], force: false });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['asset1', 'asset2'], {
        deletedAt: expect.any(Date),
        status: AssetStatus.Trashed,
      });
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
      mocks.duplicateRepository.getVideoDuplicateFrames.mockResolvedValue([
        { assetId: asset.id, frameIndex: 0, path: '/data/thumbs/video-frame.jpeg' } as any,
      ]);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.job.queue.mock.calls).toEqual([
        [
          {
            name: JobName.FileDelete,
            data: {
              files: [...asset.files.map(({ path }) => path), '/data/thumbs/video-frame.jpeg', asset.originalPath],
            },
          },
        ],
      ]);
      expect(mocks.asset.remove).toHaveBeenCalledWith(getForAssetDeletion(asset));
    });

    it('never deletes the original or sidecar of an external library item (FL-78)', async () => {
      const asset = AssetFactory.from({ libraryId: newUuid(), isExternal: true })
        .file({ type: AssetFileType.Thumbnail })
        .file({ type: AssetFileType.Preview })
        .build();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));
      mocks.duplicateRepository.getVideoDuplicateFrames.mockResolvedValue([]);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: asset.files.map(({ path }) => path) },
      });
      const deleted = mocks.job.queue.mock.calls.flatMap(([item]) => (item.data as { files?: string[] }).files ?? []);
      expect(deleted).not.toContain(asset.originalPath);
      expect(mocks.user.updateUsage).not.toHaveBeenCalled();
    });

    it('should delete the entire stack if deleted asset was the primary asset and the stack would only contain one asset afterwards', async () => {
      const asset = AssetFactory.from()
        .stack({}, (builder) => builder.asset())
        .build();
      mocks.stack.delete.mockResolvedValue();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.stack.delete).toHaveBeenCalledWith(asset.stackId);
    });

    it('should delete the stack when a non-primary asset is deleted and only the primary would remain', async () => {
      const asset = AssetFactory.from().build();
      const deletionAsset = {
        ...getForAssetDeletion(asset),
        stack: { id: newUuid(), primaryAssetId: newUuid(), assets: [{ id: asset.id }] },
      };
      mocks.stack.delete.mockResolvedValue();
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(deletionAsset);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.stack.delete).toHaveBeenCalledWith(deletionAsset.stack.id);
    });

    it('should keep the stack when a non-primary asset is deleted and the primary plus another asset remain', async () => {
      const asset = AssetFactory.from().build();
      const deletionAsset = {
        ...getForAssetDeletion(asset),
        stack: { id: newUuid(), primaryAssetId: newUuid(), assets: [{ id: asset.id }, { id: newUuid() }] },
      };
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(deletionAsset);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.stack.delete).not.toHaveBeenCalled();
      expect(mocks.stack.update).not.toHaveBeenCalled();
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

      expect(mocks.job.queue.mock.calls).toEqual([
        [{ name: JobName.AssetDelete, data: { id: motionAsset.id, deleteOnDisk: true } }],
        [{ name: JobName.FileDelete, data: { files: [asset.originalPath] } }],
      ]);
    });

    it('should not delete a live motion part if it is being used by another asset', async () => {
      const asset = AssetFactory.create({ livePhotoVideoId: newUuid() });
      mocks.asset.getLivePhotoCount.mockResolvedValue(2);
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(getForAssetDeletion(asset));

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(mocks.job.queue.mock.calls).toEqual([
        [{ name: JobName.FileDelete, data: { files: [`/data/library/IMG_${asset.id}.jpg`] } }],
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

    it('should fail if asset could not be found', async () => {
      mocks.assetJob.getForAssetDeletion.mockResolvedValue(void 0);
      await expect(sut.handleAssetDeletion({ id: AssetFactory.create().id, deleteOnDisk: true })).resolves.toBe(
        JobStatus.Failed,
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

  describe('upsertMetadata', () => {
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
        data: { id: 'asset-1', versionId: 'version-1' },
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
        data: { id: 'asset-1' },
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

    it('returns the rotated original raster and timeline instead of current render metadata', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [{ width: 1920, height: 1080, rotation: -90 }],
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
        videoStreams: [{ width: 1920, height: 1080, rotation: 0 }],
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

    it.each([
      { format: { duration: 30 }, videoStreams: [] },
      { format: { duration: NaN }, videoStreams: [{ width: 1920, height: 1080, rotation: 0 }] },
      { format: { duration: 30 }, videoStreams: [{ width: 0, height: 1080, rotation: 0 }] },
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

    it('swaps the raster for any quarter-turn display rotation', async () => {
      mocks.media.probe.mockResolvedValue({
        format: { duration: 30 },
        videoStreams: [{ width: 1920, height: 1080, rotation: 270 }],
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
        videoStreams: [{ width: 1920, height: 1080, rotation: 0 }],
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
        data: { id: 'asset-1' },
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
        data: { id: 'asset-1' },
      });
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
