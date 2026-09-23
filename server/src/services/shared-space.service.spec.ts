import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { SharedSpaceService } from 'src/services/shared-space.service.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { getForAlbum } from 'test/mappers.js';
import { newDate, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const metadata = (albumId: string, assetCount = 4) => ({
  albumId,
  assetCount,
  startDate: null,
  endDate: null,
  lastModifiedAssetTimestamp: null,
});

describe(SharedSpaceService.name, () => {
  let sut: SharedSpaceService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SharedSpaceService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getPreview', () => {
    it('shows an invited recipient what the space exposes, without any asset', async () => {
      const recipient = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space, albumName: 'Family', icon: 'mdiHomeHeart' }).build();
      const owner = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;
      const invitedAt = newDate();

      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Viewer,
        invitedById: owner.id,
        createdAt: invitedAt,
      });
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.album.getMetadataForIds.mockResolvedValue([metadata(space.id, 12)]);
      mocks.user.get.mockResolvedValue(owner);

      const preview = await sut.getPreview(AuthFactory.create(recipient), space.id);

      expect(preview).toEqual(
        expect.objectContaining({
          id: space.id,
          albumName: 'Family',
          icon: 'mdiHomeHeart',
          role: AlbumUserRole.Viewer,
          accepted: false,
          assetCount: 12,
          memberCount: 1,
        }),
      );
      // The preview is a summary, never media: nothing asset-shaped may appear on it.
      expect(preview).not.toHaveProperty('assets');
      expect(preview).not.toHaveProperty('albumThumbnailAssetId');
      expect(preview).not.toHaveProperty('assetIds');
    });

    it('counts with sensitive and Locked media excluded', async () => {
      const recipient = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();

      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Editor,
        invitedById: null,
        createdAt: newDate(),
      });
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.album.getMetadataForIds.mockResolvedValue([metadata(space.id, 3)]);

      await sut.getPreview(AuthFactory.create(recipient), space.id);

      expect(mocks.album.getMetadataForIds).toHaveBeenCalledWith([space.id], { excludeNsfw: true });
    });

    it('tells a stranger nothing, not even that the space exists', async () => {
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      mocks.albumUser.getInvite.mockResolvedValue(void 0);
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await expect(sut.getPreview(AuthFactory.create(), space.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.album.getMetadataForIds).not.toHaveBeenCalled();
    });

    it('refuses an album that is not a shared space', async () => {
      const album = AlbumFactory.from({ kind: AlbumKind.Album }).build();
      mocks.albumUser.getInvite.mockResolvedValue(void 0);
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.getPreview(AuthFactory.create(), album.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('marks the preview accepted for someone already in the space', async () => {
      const memberId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: memberId, role: AlbumUserRole.Editor })
        .build();
      const member = space.albumUsers.find(({ user }) => user.id === memberId)!.user;

      mocks.albumUser.getInvite.mockResolvedValue(void 0);
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.album.getMetadataForIds.mockResolvedValue([metadata(space.id)]);

      const preview = await sut.getPreview(AuthFactory.create(member), space.id);

      expect(preview.accepted).toBe(true);
      expect(preview.memberCount).toBe(2);
    });
  });

  describe('accept', () => {
    it('joins with the role the owner offered, not one from the request', async () => {
      const recipient = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();

      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Viewer,
        invitedById: null,
        createdAt: newDate(),
      });
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await sut.accept(AuthFactory.create(recipient), space.id);

      expect(mocks.albumUser.create).toHaveBeenCalledWith({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Viewer,
      });
      expect(mocks.albumUser.deleteInvite).toHaveBeenCalledWith({ albumId: space.id, userId: recipient.id });
    });

    it('refuses without an invitation, so membership is never self-granted', async () => {
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      mocks.albumUser.getInvite.mockResolvedValue(void 0);

      await expect(sut.accept(AuthFactory.create(), space.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.albumUser.create).not.toHaveBeenCalled();
    });
  });

  describe('decline', () => {
    it('removes the invitation and nothing else', async () => {
      const recipient = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: recipient.id,
        role: AlbumUserRole.Editor,
        invitedById: null,
        createdAt: newDate(),
      });

      await sut.decline(AuthFactory.create(recipient), space.id);

      expect(mocks.albumUser.deleteInvite).toHaveBeenCalledWith({ albumId: space.id, userId: recipient.id });
      expect(mocks.albumUser.delete).not.toHaveBeenCalled();
      expect(mocks.album.delete).not.toHaveBeenCalled();
    });

    it('refuses when there is nothing to decline', async () => {
      mocks.albumUser.getInvite.mockResolvedValue(void 0);
      await expect(sut.decline(AuthFactory.create(), newUuid())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMembers', () => {
    it('lists members and pending invitations', async () => {
      const editorId = newUuid();
      const invitedUser = UserFactory.create();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: editorId, role: AlbumUserRole.Editor })
        .build();
      const owner = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.albumUser.getInvitesForAlbum.mockResolvedValue([
        {
          albumId: space.id,
          userId: invitedUser.id,
          role: AlbumUserRole.Viewer,
          invitedById: owner.id,
          createdAt: newDate(),
        },
      ]);
      mocks.user.get.mockResolvedValue(invitedUser);

      const { members } = await sut.getMembers(AuthFactory.create(owner), space.id);

      expect(members).toHaveLength(3);
      expect(members.filter(({ pending }) => pending)).toEqual([
        expect.objectContaining({ role: AlbumUserRole.Viewer, pending: true }),
      ]);
    });
  });

  describe('removeInvitation', () => {
    it('lets the owner withdraw a pending invitation', async () => {
      const invitedId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      const owner = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!.user;

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: invitedId,
        role: AlbumUserRole.Viewer,
        invitedById: owner.id,
        createdAt: newDate(),
      });

      await sut.removeInvitation(AuthFactory.create(owner), space.id, invitedId);

      expect(mocks.albumUser.deleteInvite).toHaveBeenCalledWith({ albumId: space.id, userId: invitedId });
    });

    it('refuses an editor of the space', async () => {
      const editorId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: editorId, role: AlbumUserRole.Editor })
        .build();
      const editor = space.albumUsers.find(({ user }) => user.id === editorId)!.user;

      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await expect(sut.removeInvitation(AuthFactory.create(editor), space.id, newUuid())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.albumUser.deleteInvite).not.toHaveBeenCalled();
    });
  });

  describe('getInvitations', () => {
    it('skips an invitation whose space has been deleted', async () => {
      const recipient = UserFactory.create();
      mocks.albumUser.getInvitesForUser.mockResolvedValue([
        {
          albumId: newUuid(),
          userId: recipient.id,
          role: AlbumUserRole.Viewer,
          invitedById: null,
          createdAt: newDate(),
        },
      ]);
      mocks.album.getById.mockResolvedValue(void 0);

      await expect(sut.getInvitations(AuthFactory.create(recipient))).resolves.toEqual([]);
    });
  });
});
