import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ReactionType } from 'src/dtos/activity.dto.js';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { ActivityService } from 'src/services/activity.service.js';
import { ActivityFactory } from 'test/factories/activity.factory.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { getForActivity, getForAlbum } from 'test/mappers.js';
import { newUuid, newUuids } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(ActivityService.name, () => {
  let sut: ActivityService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ActivityService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getAll', () => {
    it('should get all', async () => {
      const [albumId, assetId, userId] = newUuids();

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.search.mockResolvedValue([]);

      await expect(sut.getAll(AuthFactory.create({ id: userId }), { assetId, albumId })).resolves.toEqual([]);

      expect(mocks.activity.search).toHaveBeenCalledWith({ assetId, albumId, isLiked: undefined });
    });

    it('should filter by type=like', async () => {
      const [albumId, assetId, userId] = newUuids();

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.search.mockResolvedValue([]);

      await expect(
        sut.getAll(AuthFactory.create({ id: userId }), { assetId, albumId, type: ReactionType.LIKE }),
      ).resolves.toEqual([]);

      expect(mocks.activity.search).toHaveBeenCalledWith({ assetId, albumId, isLiked: true });
    });

    it('should filter by type=comment', async () => {
      const [albumId, assetId] = newUuids();

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.search.mockResolvedValue([]);

      await expect(sut.getAll(AuthFactory.create(), { assetId, albumId, type: ReactionType.COMMENT })).resolves.toEqual(
        [],
      );

      expect(mocks.activity.search).toHaveBeenCalledWith({ assetId, albumId, isLiked: false });
    });

    it('should hide private NSFW asset activities when requested', async () => {
      const [albumId, assetId, userId] = newUuids();

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.search.mockResolvedValue([]);

      await expect(
        sut.getAll({ ...AuthFactory.create({ id: userId }), hideNsfwAssets: true }, { assetId, albumId }),
      ).resolves.toEqual([]);

      expect(mocks.activity.search).toHaveBeenCalledWith({ assetId, albumId, isLiked: undefined, excludeNsfw: true });
    });

    it('names the viewer as the only Locked owner in an elevated session, and nobody otherwise', async () => {
      const [albumId, userId] = newUuids();

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.search.mockResolvedValue([]);

      const elevated = AuthFactory.from({ id: userId }).session({ hasElevatedPermission: true }).build();
      await sut.getAll(elevated, { albumId });
      expect(mocks.activity.search).toHaveBeenCalledWith(expect.objectContaining({ albumId, lockedOwnerId: userId }));

      mocks.activity.search.mockClear();
      await sut.getAll(AuthFactory.from({ id: userId }).session().build(), { albumId });
      expect(mocks.activity.search.mock.calls[0][0]).not.toHaveProperty('lockedOwnerId');
    });
  });

  describe('Locked reactions', () => {
    it('counts a Locked item only for its elevated owner', async () => {
      const [albumId, userId] = newUuids();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.getStatistics.mockResolvedValue({ comments: 0, likes: 0 });

      const elevated = AuthFactory.from({ id: userId }).session({ hasElevatedPermission: true }).build();
      await sut.getStatistics(elevated, { albumId });

      expect(mocks.activity.getStatistics).toHaveBeenCalledWith({ albumId, assetId: undefined, lockedOwnerId: userId });
    });

    it("keeps Locked items in view for the duplicate-like check of the caller's own reactions", async () => {
      const [albumId, assetId, userId] = newUuids();
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.search.mockResolvedValue([]);
      mocks.activity.create.mockResolvedValue(
        getForActivity(ActivityFactory.create({ userId, albumId, assetId, isLiked: true })),
      );

      await sut.create(AuthFactory.create({ id: userId }), { albumId, assetId, type: ReactionType.LIKE });

      expect(mocks.activity.search).toHaveBeenCalledWith(
        expect.objectContaining({ userId, assetId, albumId, isLiked: true, includeLocked: true }),
      );
    });
  });

  describe('getStatistics', () => {
    it('should get the comment and like count', async () => {
      const [albumId, assetId] = newUuids();

      mocks.activity.getStatistics.mockResolvedValue({ comments: 1, likes: 3 });
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));

      await expect(sut.getStatistics(AuthFactory.create(), { assetId, albumId })).resolves.toEqual({
        comments: 1,
        likes: 3,
      });
    });

    it('should hide private NSFW asset statistics when requested', async () => {
      const [albumId, assetId] = newUuids();

      mocks.activity.getStatistics.mockResolvedValue({ comments: 0, likes: 0 });
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));

      await expect(
        sut.getStatistics({ ...AuthFactory.create(), hideNsfwAssets: true }, { assetId, albumId }),
      ).resolves.toEqual({
        comments: 0,
        likes: 0,
      });

      expect(mocks.activity.getStatistics).toHaveBeenCalledWith({ albumId, assetId, excludeNsfw: true });
    });
  });

  describe('addComment', () => {
    it('should require access to the album', async () => {
      const [albumId, assetId] = newUuids();

      await expect(
        sut.create(AuthFactory.create(), { albumId, assetId, type: ReactionType.COMMENT, comment: 'comment' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should create a comment', async () => {
      const [albumId, assetId, userId] = newUuids();
      const activity = ActivityFactory.create({ albumId, assetId, userId });

      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.create.mockResolvedValue(getForActivity(activity));

      await sut.create(AuthFactory.create({ id: userId }), {
        albumId,
        assetId,
        type: ReactionType.COMMENT,
        comment: 'comment',
      });

      expect(mocks.activity.create).toHaveBeenCalledWith({
        userId: activity.userId,
        albumId: activity.albumId,
        assetId: activity.assetId,
        comment: 'comment',
        isLiked: false,
      });
    });

    it('should require asset read access before creating hidden-mode asset activity', async () => {
      const [albumId, assetId, userId] = newUuids();
      const activity = ActivityFactory.create({ albumId, assetId, userId });

      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([albumId]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
      mocks.activity.create.mockResolvedValue(getForActivity(activity));

      await sut.create(
        { ...AuthFactory.create({ id: userId }), hideNsfwAssets: true },
        {
          albumId,
          assetId,
          type: ReactionType.COMMENT,
          comment: 'comment',
        },
      );

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(userId, new Set([assetId]), undefined, true);
      expect(mocks.activity.create).toHaveBeenCalledWith({
        userId,
        albumId,
        assetId,
        comment: 'comment',
        isLiked: false,
      });
    });

    it('should fail because activity is disabled for the album', async () => {
      const [albumId, assetId] = newUuids();
      const activity = ActivityFactory.create({ albumId, assetId });

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.create.mockResolvedValue(getForActivity(activity));

      await expect(
        sut.create(AuthFactory.create(), { albumId, assetId, type: ReactionType.COMMENT, comment: 'comment' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should create a like', async () => {
      const [albumId, assetId, userId] = newUuids();
      const activity = ActivityFactory.create({ userId, albumId, assetId, isLiked: true });

      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.create.mockResolvedValue(getForActivity(activity));
      mocks.activity.search.mockResolvedValue([]);

      await sut.create(AuthFactory.create({ id: userId }), { albumId, assetId, type: ReactionType.LIKE });

      expect(mocks.activity.create).toHaveBeenCalledWith({ userId: activity.userId, albumId, assetId, isLiked: true });
    });

    it('should skip if like exists', async () => {
      const [albumId, assetId] = newUuids();
      const activity = ActivityFactory.create({ albumId, assetId, isLiked: true });

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.access.activity.checkCreateAccess.mockResolvedValue(new Set([albumId]));
      mocks.activity.search.mockResolvedValue([getForActivity(activity)]);

      await sut.create(AuthFactory.create(), { albumId, assetId, type: ReactionType.LIKE });

      expect(mocks.activity.create).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should require access', async () => {
      await expect(sut.delete(AuthFactory.create(), newUuid())).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.activity.delete).not.toHaveBeenCalled();
    });

    it('should let the activity owner delete a comment', async () => {
      const activity = ActivityFactory.create();

      mocks.access.activity.checkOwnerAccess.mockResolvedValue(new Set([activity.id]));
      mocks.activity.getById.mockResolvedValue(getForActivity(activity));
      mocks.activity.delete.mockResolvedValue();

      await sut.delete(AuthFactory.create(), activity.id);

      expect(mocks.activity.delete).toHaveBeenCalledWith(activity.id);
    });

    it('should let the album owner delete a comment', async () => {
      const activity = ActivityFactory.create();

      mocks.access.activity.checkAlbumOwnerAccess.mockResolvedValue(new Set([activity.id]));
      mocks.activity.getById.mockResolvedValue(getForActivity(activity));
      mocks.activity.delete.mockResolvedValue();

      await sut.delete(AuthFactory.create(), activity.id);

      expect(mocks.activity.delete).toHaveBeenCalledWith(activity.id);
    });

    describe('in a shared space (FL-55)', () => {
      it('removes a comment together with its replies', async () => {
        const auth = AuthFactory.create();
        const space = AlbumFactory.from({ kind: AlbumKind.Space })
          .albumUser({ userId: auth.user.id, role: AlbumUserRole.Editor })
          .build();
        const activity = ActivityFactory.create({ albumId: space.id, userId: auth.user.id, comment: 'x' });

        mocks.access.activity.checkOwnerAccess.mockResolvedValue(new Set([activity.id]));
        mocks.activity.getById.mockResolvedValue(getForActivity(activity));
        mocks.album.getById.mockResolvedValue(getForAlbum(space));
        mocks.albumUser.deleteCommentWithReplies.mockResolvedValue();

        await sut.delete(auth, activity.id);

        expect(mocks.albumUser.deleteCommentWithReplies).toHaveBeenCalledWith(activity.id);
        expect(mocks.activity.delete).not.toHaveBeenCalled();
      });

      it('refuses somebody who has left the space, even for their own old comment', async () => {
        const auth = AuthFactory.create();
        const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
        const activity = ActivityFactory.create({ albumId: space.id, userId: auth.user.id, comment: 'x' });

        mocks.access.activity.checkOwnerAccess.mockResolvedValue(new Set([activity.id]));
        mocks.activity.getById.mockResolvedValue(getForActivity(activity));
        mocks.album.getById.mockResolvedValue(getForAlbum(space));

        await expect(sut.delete(auth, activity.id)).rejects.toBeInstanceOf(ForbiddenException);
        expect(mocks.albumUser.deleteCommentWithReplies).not.toHaveBeenCalled();
        expect(mocks.activity.delete).not.toHaveBeenCalled();
      });
    });
  });
});
