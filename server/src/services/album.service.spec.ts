import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CreateAlbumDto } from 'src/dtos/album.dto.js';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AlbumKind, AlbumUserRole, AssetOrder, AssetVisibility, UserMetadataKey } from 'src/enum.js';
import { AlbumService } from 'src/services/album.service.js';
import { AlbumUserFactory } from 'test/factories/album-user.factory.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { PartnerFactory } from 'test/factories/partner.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForAlbum, getForPartner } from 'test/mappers.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(AlbumService.name, () => {
  let sut: AlbumService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumService));
    mocks.partner.getAll.mockResolvedValue([]);
    mocks.album.getPositions.mockResolvedValue(new Map());
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getStatistics', () => {
    it('should get the album count', async () => {
      mocks.album.getAll.mockResolvedValue([]);
      await expect(sut.getStatistics(authStub.admin)).resolves.toEqual({
        owned: 0,
        shared: 0,
        notShared: 0,
      });

      expect(mocks.album.getAll).toHaveBeenCalledWith(authStub.admin.user.id, { isOwned: true });
      expect(mocks.album.getAll).toHaveBeenCalledWith(authStub.admin.user.id, { isShared: true });
      expect(mocks.album.getAll).toHaveBeenCalledWith(authStub.admin.user.id, { isOwned: true, isShared: false });
    });
  });

  describe('getAll', () => {
    it('gets list of albums for auth user', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const sharedWithUserAlbum = AlbumFactory.from().owner(owner).albumUser().build();
      mocks.album.getAll.mockResolvedValue([getForAlbum(album), getForAlbum(sharedWithUserAlbum)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 0,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
        {
          albumId: sharedWithUserAlbum.id,
          assetCount: 0,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), {});
      expect(result).toHaveLength(2);
      expect(result[0].id).toEqual(album.id);
      expect(result[1].id).toEqual(sharedWithUserAlbum.id);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, { isOwned: undefined, isShared: undefined });
    });

    it('should mask NSFW album thumbnails and metadata when privacy hiding is active', async () => {
      const thumbnailAssetId = newUuid();
      const album = AlbumFactory.from({ albumThumbnailAssetId: thumbnailAssetId }).albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const auth = { ...AuthFactory.create(owner), hideNsfwAssets: true };

      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set([thumbnailAssetId]));
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 0,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
      ]);

      const result = await sut.getAll(auth, {});

      expect(result[0].albumThumbnailAssetId).toBeNull();
      expect(mocks.asset.getHiddenContentAssetIds).toHaveBeenCalledWith([thumbnailAssetId], { excludeNsfw: true });
      expect(mocks.album.getMetadataForIds).toHaveBeenCalledWith([album.id], { excludeNsfw: true });
    });

    it('should use suppressed album thumbnails when suppressedOnly is active', async () => {
      const regularThumbnailId = newUuid();
      const suppressedThumbnailId = newUuid();
      const album = AlbumFactory.from({ albumThumbnailAssetId: regularThumbnailId }).albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const suppressedContent = {
        userId: owner.id,
        includeNsfw: true,
        tagIds: [],
        personIds: [],
        petIds: [],
        scope: 'owned' as const,
      };
      const auth = {
        ...AuthFactory.from(owner).session({ hasElevatedPermission: true }).build(),
        suppressedContent,
      };

      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          thumbnailAssetId: suppressedThumbnailId,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
      ]);

      const result = await sut.getAll(auth, { suppressedOnly: true });

      expect(result[0].albumThumbnailAssetId).toEqual(suppressedThumbnailId);
      expect(mocks.asset.getHiddenContentAssetIds).not.toHaveBeenCalled();
      // An elevated session also sees its own Locked media, so it passes lockedOwnerId (FL-32).
      expect(mocks.album.getMetadataForIds).toHaveBeenCalledWith([album.id], {
        onlyHiddenContent: suppressedContent,
        lockedOwnerId: owner.id,
      });
    });

    it('gets list of albums that have a specific asset', async () => {
      const album = AlbumFactory.from()
        .owner({ isAdmin: true })
        .albumUser()
        .asset({}, (builder) => builder.exif())
        .asset({}, (builder) => builder.exif())
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getByAssetId.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { assetId: album.assets[0].id });
      expect(result).toHaveLength(1);
      expect(result[0].id).toEqual(album.id);
      expect(mocks.album.getByAssetId).toHaveBeenCalledWith(owner.id, album.assets[0].id, {});
    });

    it('gets list of albums that are shared', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 0,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isShared: true });
      expect(result).toHaveLength(1);
      expect(result[0].id).toEqual(album.id);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, expect.objectContaining({ isShared: true }));
    });

    it('gets list of albums that are NOT shared', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 0,
          startDate: null,
          endDate: null,
          lastModifiedAssetTimestamp: null,
        },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isShared: false });
      expect(result).toHaveLength(1);
      expect(result[0].id).toEqual(album.id);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, expect.objectContaining({ isShared: false }));
    });

    it('gets only owned albums when isOwned=true', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: album.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isOwned: true });
      expect(result).toHaveLength(1);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, expect.objectContaining({ isOwned: true }));
    });

    it('gets only shared-with-me albums when isOwned=false', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: album.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isOwned: false });
      expect(result).toHaveLength(1);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, expect.objectContaining({ isOwned: false }));
    });

    it('gets owned shared-out albums when isOwned=true and isShared=true', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: album.id, assetCount: 0, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);

      const result = await sut.getAll(AuthFactory.create(owner), { isOwned: true, isShared: true });
      expect(result).toHaveLength(1);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, { isOwned: true, isShared: true });
    });

    it('returns empty list when isOwned=false and isShared=false', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getAll.mockResolvedValue([]);

      const result = await sut.getAll(AuthFactory.create(owner), { isOwned: false, isShared: false });
      expect(result).toHaveLength(0);
      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, { isOwned: false, isShared: false });
    });
  });

  it('counts assets correctly', async () => {
    const album = AlbumFactory.create();
    const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
    mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
    mocks.album.getMetadataForIds.mockResolvedValue([
      {
        albumId: album.id,
        assetCount: 1,
        startDate: new Date('1970-01-01'),
        endDate: new Date('1970-01-01'),
        lastModifiedAssetTimestamp: new Date('1970-01-01'),
      },
    ]);

    const result = await sut.getAll(AuthFactory.create(owner), {});
    expect(result).toHaveLength(1);
    expect(result[0].assetCount).toEqual(1);
    expect(mocks.album.getAll).toHaveBeenCalledTimes(1);
  });

  describe('create', () => {
    it('creates album', async () => {
      const assetId = newUuid();
      const albumUser = { userId: newUuid(), role: AlbumUserRole.Editor };
      const album = AlbumFactory.from({ albumName: 'test', description: 'description' })
        .asset({ id: assetId }, (asset) => asset.exif())
        .albumUser(albumUser)
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;

      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(UserFactory.create(album.albumUsers[0].user));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

      await sut.create(AuthFactory.create(owner), {
        albumName: 'test',
        albumUsers: [albumUser],
        description: 'description',
        assetIds: [assetId],
      });

      expect(mocks.album.create).toHaveBeenCalledWith(
        {
          albumName: 'test',
          description: 'description',
          order: album.order,
          albumThumbnailAssetId: assetId,
          parentId: null,
          icon: null,
          kind: AlbumKind.Album,
        },
        [assetId],
        [
          { userId: owner.id, role: AlbumUserRole.Owner },
          { userId: albumUser.userId, role: AlbumUserRole.Editor },
        ],
        owner.id,
      );

      expect(mocks.user.get).toHaveBeenCalledWith(albumUser.userId, {});
      expect(mocks.user.getMetadata).toHaveBeenCalledWith(owner.id);
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([assetId]), false);
      expect(mocks.event.emit).toHaveBeenCalledTimes(1);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumInvite', {
        id: album.id,
        userId: albumUser.userId,
        senderName: owner.name,
      });
    });

    it('creates album with assetOrder from user preferences', async () => {
      const assetId = newUuid();
      const albumUser = { userId: newUuid(), role: AlbumUserRole.Editor };
      const album = AlbumFactory.from()
        .asset({ id: assetId }, (asset) => asset.exif())
        .albumUser(albumUser)
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.create.mockResolvedValue(album.albumUsers[0]);
      mocks.user.get.mockResolvedValue(UserFactory.create(album.albumUsers[1].user));
      mocks.user.getMetadata.mockResolvedValue([
        {
          key: UserMetadataKey.Preferences,
          value: {
            albums: {
              defaultAssetOrder: AssetOrder.Asc,
            },
          },
        },
      ]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

      await sut.create(AuthFactory.create(owner), {
        albumName: album.albumName,
        albumUsers: [albumUser],
        description: album.description,
        assetIds: [assetId],
      });

      expect(mocks.album.create).toHaveBeenCalledWith(
        {
          albumName: album.albumName,
          description: album.description,
          order: 'asc',
          albumThumbnailAssetId: assetId,
          parentId: null,
          icon: null,
          kind: AlbumKind.Album,
        },
        [assetId],
        [{ userId: owner.id, role: AlbumUserRole.Owner }, albumUser],
        owner.id,
      );

      expect(mocks.user.get).toHaveBeenCalledWith(albumUser.userId, {});
      expect(mocks.user.getMetadata).toHaveBeenCalledWith(owner.id);
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([assetId]), false);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumInvite', {
        id: album.id,
        userId: albumUser.userId,
        senderName: owner.name,
      });
    });

    it('should require valid userIds', async () => {
      mocks.user.get.mockResolvedValue(void 0);
      await expect(
        sut.create(AuthFactory.create(), {
          albumName: 'Empty album',
          albumUsers: [{ userId: 'unknown-user', role: AlbumUserRole.Editor }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.user.get).toHaveBeenCalledWith('unknown-user', {});
      expect(mocks.album.create).not.toHaveBeenCalled();
    });

    it('should only add assets the user is allowed to access', async () => {
      const assetId = newUuid();
      const album = AlbumFactory.from()
        .asset({ id: assetId }, (asset) => asset.exif())
        .albumUser()
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.user.get.mockResolvedValue(album.albumUsers[0].user);
      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));

      await sut.create(AuthFactory.create(owner), {
        albumName: album.albumName,
        description: album.description,
        assetIds: [assetId, 'asset-2'],
      });

      expect(mocks.album.create).toHaveBeenCalledWith(
        {
          albumName: album.albumName,
          description: album.description,
          order: 'desc',
          albumThumbnailAssetId: assetId,
          parentId: null,
          icon: null,
          kind: AlbumKind.Album,
        },
        [assetId],
        [{ userId: owner.id, role: AlbumUserRole.Owner }],
        owner.id,
      );
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([assetId, 'asset-2']), false);
    });

    it('should deduplicate owner from albumUsers on create', async () => {
      const auth = AuthFactory.create();
      const album = AlbumFactory.from().build();
      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await sut.create(auth, {
        albumName: 'Empty album',
        albumUsers: [{ userId: auth.user.id, role: AlbumUserRole.Editor }],
      });

      expect(mocks.user.get).not.toHaveBeenCalled();
      expect(mocks.album.create).toHaveBeenCalledWith(
        expect.objectContaining({ albumName: 'Empty album' }),
        [],
        [{ userId: auth.user.id, role: AlbumUserRole.Owner }],
        auth.user.id,
      );
    });
  });

  describe('update', () => {
    it('should prevent updating an album that does not exist', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.album.getById.mockResolvedValue(void 0);

      await expect(
        sut.update(AuthFactory.create(), 'invalid-id', {
          albumName: 'Album',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should prevent updating a not owned album (shared with auth user)', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(
        sut.update(AuthFactory.create(owner), album.id, { albumName: 'new album name' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should require a valid thumbnail asset id', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set());

      await expect(
        sut.update(AuthFactory.create(owner), album.id, { albumThumbnailAssetId: 'not-in-album' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.getAssetIds).not.toHaveBeenCalled();
      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it("should refuse the caller's own Locked photo as the cover with a clear error (FL-53)", async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const locked = AssetFactory.create({ ownerId: owner.id, visibility: AssetVisibility.Locked });
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.asset.getById.mockResolvedValue(locked as never);

      await expect(
        sut.update(AuthFactory.create(owner), album.id, { albumThumbnailAssetId: locked.id }),
      ).rejects.toThrow('A Locked photo cannot be an album cover');

      expect(mocks.asset.getById).toHaveBeenCalledWith(locked.id);
      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it("should not reveal that another person's photo is Locked when it is refused as the cover", async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const othersLocked = AssetFactory.create({ visibility: AssetVisibility.Locked });
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.asset.getById.mockResolvedValue(othersLocked as never);

      await expect(
        sut.update(AuthFactory.create(owner), album.id, { albumThumbnailAssetId: othersLocked.id }),
      ).rejects.toThrow('Invalid album thumbnail');

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should allow the owner to update the album', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.update.mockResolvedValue(getForAlbum(album));

      await sut.update(AuthFactory.create(owner), album.id, { albumName: 'new album name' });

      expect(mocks.album.update).toHaveBeenCalledTimes(1);
      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        { id: album.id, albumName: 'new album name' },
        owner.id,
      );
    });
  });

  describe('delete', () => {
    it('should require permissions', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.delete(AuthFactory.create(owner), album.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.delete).not.toHaveBeenCalled();
    });

    it('should not let a shared user delete the album', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.delete(AuthFactory.create(owner), album.id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.delete).not.toHaveBeenCalled();
    });

    it('should let the owner delete an album', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await sut.delete(AuthFactory.create(owner), album.id);

      expect(mocks.album.delete).toHaveBeenCalledTimes(1);
      expect(mocks.album.delete).toHaveBeenCalledWith(album.id);
    });
  });

  describe('addUsers', () => {
    it('should throw an error if the auth user is not the owner', async () => {
      const album = AlbumFactory.create();
      const user = UserFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(
        sut.addUsers(AuthFactory.create(user), album.id, { albumUsers: [{ userId: newUuid() }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should skip if the userId is already added', async () => {
      const userId = newUuid();
      const album = AlbumFactory.from().albumUser({ userId }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      await expect(sut.addUsers(AuthFactory.create(owner), album.id, { albumUsers: [{ userId }] })).resolves.toEqual(
        expect.objectContaining({ id: album.id }),
      );
      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.user.get).not.toHaveBeenCalled();
      expect(mocks.albumUser.create).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should throw an error if the userId does not exist', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(void 0);
      await expect(
        sut.addUsers(AuthFactory.create(owner), album.id, { albumUsers: [{ userId: 'unknown-user' }] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.user.get).toHaveBeenCalledWith('unknown-user', {});
    });

    it('should skip if the userId is the ownerId', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      await expect(
        sut.addUsers(AuthFactory.create(owner), album.id, {
          albumUsers: [{ userId: owner.id }],
        }),
      ).resolves.toEqual(expect.objectContaining({ id: album.id }));
      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.user.get).not.toHaveBeenCalled();
      expect(mocks.albumUser.create).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should add valid shared users', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const user = UserFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.update.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(user);
      mocks.albumUser.create.mockResolvedValue(AlbumUserFactory.from().album(album).user(user).build());

      await sut.addUsers(AuthFactory.create(owner), album.id, { albumUsers: [{ userId: user.id }] });

      expect(mocks.albumUser.create).toHaveBeenCalledWith({
        userId: user.id,
        albumId: album.id,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumInvite', {
        id: album.id,
        userId: user.id,
        senderName: owner.name,
      });
    });

    it('should add new users when already-added users are included', async () => {
      const existingUserId = newUuid();
      const album = AlbumFactory.from().albumUser({ userId: existingUserId }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const user = UserFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(user);
      mocks.albumUser.create.mockResolvedValue(AlbumUserFactory.from().album(album).user(user).build());

      await sut.addUsers(AuthFactory.create(owner), album.id, {
        albumUsers: [{ userId: existingUserId }, { userId: user.id }],
      });

      expect(mocks.user.get).toHaveBeenCalledTimes(1);
      expect(mocks.user.get).toHaveBeenCalledWith(user.id, {});
      expect(mocks.albumUser.create).toHaveBeenCalledTimes(1);
      expect(mocks.albumUser.create).toHaveBeenCalledWith({
        userId: user.id,
        albumId: album.id,
      });
      expect(mocks.event.emit).toHaveBeenCalledTimes(1);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumInvite', {
        id: album.id,
        userId: user.id,
        senderName: owner.name,
      });
    });
  });

  describe('removeUser', () => {
    it('should require a valid album id', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set(['album-1']));
      mocks.album.getById.mockResolvedValue(void 0);
      await expect(sut.removeUser(AuthFactory.create(), 'album-1', 'user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should remove a shared user from an owned album', async () => {
      const userId = newUuid();
      const album = AlbumFactory.from().albumUser({ userId }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.delete.mockResolvedValue();

      await expect(sut.removeUser(AuthFactory.create(owner), album.id, userId)).resolves.toBeUndefined();

      expect(mocks.albumUser.delete).toHaveBeenCalledTimes(1);
      expect(mocks.albumUser.delete).toHaveBeenCalledWith({ albumId: album.id, userId });
      expect(mocks.album.getById).toHaveBeenCalledWith(album.id, { withAssets: false }, owner.id);
    });

    it('should prevent removing a shared user from a not-owned album (shared with auth user)', async () => {
      const user1 = UserFactory.create();
      const user2 = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user1.id }).albumUser({ userId: user2.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.removeUser(AuthFactory.create(user1), album.id, user2.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.albumUser.delete).not.toHaveBeenCalled();
      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(user1.id, new Set([album.id]));
    });

    it('should allow a shared user to remove themselves', async () => {
      const user1 = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user1.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.delete.mockResolvedValue();

      await sut.removeUser(AuthFactory.create(user1), album.id, user1.id);

      expect(mocks.albumUser.delete).toHaveBeenCalledTimes(1);
      expect(mocks.albumUser.delete).toHaveBeenCalledWith({ albumId: album.id, userId: user1.id });
    });

    it('lets the last member leave: the album stays with its owner and everyone is told (FL-53)', async () => {
      const member = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: member.id }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.delete.mockResolvedValue();

      await sut.removeUser(AuthFactory.create(member), album.id, 'me');

      expect(mocks.albumUser.delete).toHaveBeenCalledWith({ albumId: album.id, userId: member.id });
      // Leaving never deletes the album or its items.
      expect(mocks.album.delete).not.toHaveBeenCalled();
      const payload = { albumId: album.id, userId: member.id, role: null };
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AlbumUserUpdateV1', member.id, payload);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AlbumUserUpdateV1', owner.id, payload);
    });

    it('should allow a shared user to remove themselves using "me"', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.delete.mockResolvedValue();

      await sut.removeUser(AuthFactory.create(user), album.id, 'me');

      expect(mocks.albumUser.delete).toHaveBeenCalledTimes(1);
      expect(mocks.albumUser.delete).toHaveBeenCalledWith({ albumId: album.id, userId: user.id });
    });

    it('should not allow the owner to be removed', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.removeUser(AuthFactory.create(owner), album.id, owner.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should throw an error for a user not in the album', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.removeUser(AuthFactory.create(owner), album.id, 'user-3')).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.album.update).not.toHaveBeenCalled();
    });
  });

  describe('updateUser', () => {
    it('should update user role', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.update.mockResolvedValue();

      await sut.updateUser(AuthFactory.create(owner), album.id, user.id, { role: AlbumUserRole.Viewer });

      expect(mocks.albumUser.update).toHaveBeenCalledWith(
        { albumId: album.id, userId: user.id },
        { role: AlbumUserRole.Viewer },
      );
    });

    it('tells the downgraded member and the album at once, so open pages drop controls (FL-53)', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.albumUser.update.mockResolvedValue();

      await sut.updateUser(AuthFactory.create(owner), album.id, user.id, { role: AlbumUserRole.Viewer });

      const payload = { albumId: album.id, userId: user.id, role: AlbumUserRole.Viewer };
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AlbumUserUpdateV1', user.id, payload);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('AlbumUserUpdateV1', owner.id, payload);
    });
  });

  describe('collections', () => {
    const emptyMetadata = (albumId: string) => ({
      albumId,
      assetCount: 0,
      startDate: null,
      endDate: null,
      lastModifiedAssetTimestamp: null,
    });

    it('creates a collection at the top level', async () => {
      const collection = AlbumFactory.from({ albumName: 'Family', kind: AlbumKind.Collection }).build();
      const { user: owner } = collection.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.create.mockResolvedValue(getForAlbum(collection));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      const result = await sut.create(AuthFactory.create(owner), {
        albumName: 'Family',
        kind: AlbumKind.Collection,
        icon: 'mdiFolderMultipleOutline',
      });

      expect(result.kind).toBe(AlbumKind.Collection);
      expect(mocks.album.create).toHaveBeenCalledWith(
        expect.objectContaining({ albumName: 'Family', kind: AlbumKind.Collection, icon: 'mdiFolderMultipleOutline' }),
        [],
        [{ userId: owner.id, role: AlbumUserRole.Owner }],
        owner.id,
      );
    });

    it('creates an album inside a collection the user can edit', async () => {
      const collection = AlbumFactory.from({ kind: AlbumKind.Collection }).build();
      const { user: owner } = collection.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album = AlbumFactory.from({ parentId: collection.id }).owner(owner).build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([collection.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(collection));
      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await sut.create(AuthFactory.create(owner), { albumName: 'Rockies', parentId: collection.id });

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([collection.id]));
      expect(mocks.album.create).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: collection.id, kind: AlbumKind.Album }),
        [],
        expect.anything(),
        owner.id,
      );
    });

    it('refuses to nest an album inside a plain album', async () => {
      const parent = AlbumFactory.create();
      const { user: owner } = parent.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([parent.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(parent));

      await expect(sut.create(AuthFactory.create(owner), { albumName: 'Nested', parentId: parent.id })).rejects.toThrow(
        'Albums nest only inside a collection',
      );
      expect(mocks.album.create).not.toHaveBeenCalled();
    });

    it('refuses to nest a collection or a shared space', async () => {
      const collection = AlbumFactory.from({ kind: AlbumKind.Collection }).build();
      const { user: owner } = collection.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;

      for (const kind of [AlbumKind.Collection, AlbumKind.Space]) {
        await expect(
          sut.create(AuthFactory.create(owner), { albumName: 'Nested', parentId: collection.id, kind }),
        ).rejects.toThrow('Collections and shared spaces stay at the top level');
      }
      expect(mocks.access.album.checkOwnerAccess).not.toHaveBeenCalled();
      expect(mocks.album.create).not.toHaveBeenCalled();
    });

    it('refuses to create inside a collection the user cannot see', async () => {
      const auth = AuthFactory.create();
      const collectionId = newUuid();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());

      await expect(sut.create(auth, { albumName: 'Nested', parentId: collectionId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.album.getById).not.toHaveBeenCalled();
      expect(mocks.album.create).not.toHaveBeenCalled();
    });

    it('moves an owned album into a collection and returns the refreshed album', async () => {
      const collection = AlbumFactory.from({ kind: AlbumKind.Collection }).build();
      // The factory always adds an owner, so `.owner()` would give the album a second one.
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      // The access check answers only for the ids it is asked about, as the real one does.
      mocks.access.album.checkOwnerAccess.mockImplementation((_userId, ids) =>
        Promise.resolve(new Set([...ids].filter((id) => id === album.id || id === collection.id))),
      );
      // The album stands alone until reparent moves it; the refreshed read then shows the new parent.
      let moved = false;
      mocks.album.reparent.mockImplementation(() => {
        moved = true;
        return Promise.resolve();
      });
      mocks.album.getById.mockImplementation((id: string) =>
        Promise.resolve(
          getForAlbum(id === collection.id ? collection : { ...album, parentId: moved ? collection.id : null }),
        ),
      );
      mocks.album.getMetadataForIds.mockResolvedValue([emptyMetadata(album.id)]);

      const result = await sut.moveToCollection(AuthFactory.create(owner), album.id, {
        collectionId: collection.id,
      });

      expect(mocks.album.reparent).toHaveBeenCalledWith(album.id, collection.id);
      expect(result.parentId).toBe(collection.id);
    });

    it('takes an album out of its collection with a null destination', async () => {
      const album = AlbumFactory.from({ parentId: newUuid() }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getMetadataForIds.mockResolvedValue([emptyMetadata(album.id)]);

      await sut.moveToCollection(AuthFactory.create(owner), album.id, { collectionId: null });

      expect(mocks.album.reparent).toHaveBeenCalledWith(album.id, null);
    });

    it('refuses a move decided on an outdated directory (stale moved node)', async () => {
      // The client saw the album standing on its own, but it was moved into a collection since.
      const album = AlbumFactory.from({ parentId: newUuid() }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(
        sut.moveToCollection(AuthFactory.create(owner), album.id, { collectionId: newUuid(), expectedParentId: null }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.album.reparent).not.toHaveBeenCalled();
    });

    it('passes the expected parent on so the move is checked again inside its transaction', async () => {
      const previous = newUuid();
      const album = AlbumFactory.from({ parentId: previous }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getMetadataForIds.mockResolvedValue([emptyMetadata(album.id)]);

      await sut.moveToCollection(AuthFactory.create(owner), album.id, {
        collectionId: null,
        expectedParentId: previous,
      });

      expect(mocks.album.reparent).toHaveBeenCalledWith(album.id, null, previous);
    });

    it('does not reparent when the album is already in the destination', async () => {
      const collectionId = newUuid();
      const album = AlbumFactory.from({ parentId: collectionId }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getMetadataForIds.mockResolvedValue([emptyMetadata(album.id)]);

      await sut.moveToCollection(AuthFactory.create(owner), album.id, { collectionId });

      expect(mocks.album.reparent).not.toHaveBeenCalled();
    });

    it('refuses to move a collection or a shared space', async () => {
      for (const kind of [AlbumKind.Collection, AlbumKind.Space]) {
        const item = AlbumFactory.from({ kind }).build();
        const { user: owner } = item.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
        mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([item.id]));
        mocks.album.getById.mockResolvedValue(getForAlbum(item));

        await expect(
          sut.moveToCollection(AuthFactory.create(owner), item.id, { collectionId: newUuid() }),
        ).rejects.toThrow('Collections and shared spaces stay at the top level');
      }
      expect(mocks.album.reparent).not.toHaveBeenCalled();
    });

    it('lets only the album owner move it, even when an editor can update it', async () => {
      const album = AlbumFactory.from().albumUser({ role: AlbumUserRole.Editor }).build();
      const editor = album.albumUsers.find(({ role }) => role === AlbumUserRole.Editor)!.user;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(
        sut.moveToCollection(AuthFactory.create(editor), album.id, { collectionId: newUuid() }),
      ).rejects.toThrow('Only the album owner can move it');
      expect(mocks.album.reparent).not.toHaveBeenCalled();
    });

    it('refuses a destination that is not a collection', async () => {
      const destination = AlbumFactory.create();
      // The factory always adds an owner, so `.owner()` would give the album a second one.
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      // The access check answers only for the ids it is asked about, as the real one does.
      mocks.access.album.checkOwnerAccess.mockImplementation((_userId, ids) =>
        Promise.resolve(new Set([...ids].filter((id) => id === album.id || id === destination.id))),
      );
      mocks.album.getById.mockImplementation((id: string) =>
        Promise.resolve(getForAlbum(id === destination.id ? destination : album)),
      );

      await expect(
        sut.moveToCollection(AuthFactory.create(owner), album.id, { collectionId: destination.id }),
      ).rejects.toThrow('Albums nest only inside a collection');
      expect(mocks.album.reparent).not.toHaveBeenCalled();
    });

    it('applies the same nesting rules to PATCH parentId', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.update(AuthFactory.create(owner), album.id, { parentId: album.id })).rejects.toThrow(
        'An album cannot be its own parent',
      );
      expect(mocks.album.reparent).not.toHaveBeenCalled();
      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('rejects an icon outside the catalogue at the DTO boundary', () => {
      expect(CreateAlbumDto.schema.safeParse({ albumName: 'x', icon: 'mdiNotARealIcon' }).success).toBe(false);
      expect(CreateAlbumDto.schema.safeParse({ albumName: 'x', icon: 'mdiCameraOutline' }).success).toBe(true);
      expect(CreateAlbumDto.schema.safeParse({ albumName: 'x', icon: 'folder-heart' }).success).toBe(true);
    });

    it('deleting a collection leaves its albums standing on their own', async () => {
      const collection = AlbumFactory.from({ kind: AlbumKind.Collection }).build();
      const { user: owner } = collection.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const childIds = [newUuid(), newUuid()];
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([collection.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(collection));
      mocks.album.getChildIds.mockResolvedValue(childIds);

      await sut.delete(AuthFactory.create(owner), collection.id);

      expect(mocks.album.reparent).toHaveBeenCalledTimes(2);
      for (const childId of childIds) {
        expect(mocks.album.reparent).toHaveBeenCalledWith(childId, null);
      }
      expect(mocks.album.delete).toHaveBeenCalledWith(collection.id);
    });

    it('deleting a plain album does not touch other albums', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await sut.delete(AuthFactory.create(owner), album.id);

      expect(mocks.album.getChildIds).not.toHaveBeenCalled();
      expect(mocks.album.reparent).not.toHaveBeenCalled();
    });
  });

  describe('getTree', () => {
    it('returns empty groups when the user has no albums', async () => {
      mocks.album.getAll.mockResolvedValue([]);
      await expect(sut.getTree(AuthFactory.create())).resolves.toEqual({ collections: [], albums: [], spaces: [] });
      expect(mocks.album.getMetadataForIds).not.toHaveBeenCalled();
    });

    it('lists only what the user owns or is shared with, shaped as shelves, albums and spaces', async () => {
      const collection = AlbumFactory.from({ albumName: 'Family', kind: AlbumKind.Collection }).build();
      const { user: owner } = collection.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const inside = AlbumFactory.from({ parentId: collection.id }).owner(owner).build();
      const loose = AlbumFactory.from().owner(owner).build();
      const sharedWithMe = AlbumFactory.from().albumUser({ userId: owner.id, role: AlbumUserRole.Viewer }).build();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).owner(owner).build();
      const auth = AuthFactory.create(owner);
      mocks.album.getAll.mockResolvedValue(
        [collection, inside, loose, sharedWithMe, space].map((item) => getForAlbum(item)),
      );
      mocks.album.getMetadataForIds.mockResolvedValue([
        { albumId: collection.id, assetCount: 1, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
        { albumId: inside.id, assetCount: 4, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
        { albumId: loose.id, assetCount: 2, startDate: null, endDate: null, lastModifiedAssetTimestamp: null },
      ]);
      mocks.smartAlbum.getSmartBackedAlbumIds.mockResolvedValue(new Set([loose.id]));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([collection.id]));

      const tree = await sut.getTree(auth);

      expect(mocks.album.getAll).toHaveBeenCalledWith(owner.id, {});
      expect(tree.collections).toHaveLength(1);
      expect(tree.collections[0].collection.id).toBe(collection.id);
      expect(tree.collections[0].albums.map(({ id }) => id)).toEqual([inside.id]);
      expect(tree.collections[0]).toMatchObject({ albumCount: 1, assetCount: 5 });
      expect(tree.albums.map(({ id }) => id)).toEqual([loose.id, sharedWithMe.id]);
      expect(tree.albums.find(({ id }) => id === loose.id)?.isSmart).toBe(true);
      expect(tree.albums.find(({ id }) => id === sharedWithMe.id)?.isSmart).toBe(false);
      expect(tree.spaces.map(({ id }) => id)).toEqual([space.id]);
    });

    it('never shows a member the owner’s private collection of an album shared with them (FL-52)', async () => {
      const member = UserFactory.create();
      const privateCollectionId = newUuid();
      const shared = AlbumFactory.from({ parentId: privateCollectionId })
        .albumUser({ userId: member.id, role: AlbumUserRole.Viewer })
        .build();
      mocks.album.getAll.mockResolvedValue([getForAlbum(shared)]);
      mocks.album.getMetadataForIds.mockResolvedValue([]);
      mocks.smartAlbum.getSmartBackedAlbumIds.mockResolvedValue(new Set());
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());

      const tree = await sut.getTree(AuthFactory.create(member));

      expect(tree.albums.map(({ id, parentId }) => ({ id, parentId }))).toEqual([{ id: shared.id, parentId: null }]);
      expect(JSON.stringify(tree)).not.toContain(privateCollectionId);
    });

    it('masks hidden thumbnails in the tree exactly as in the list', async () => {
      const thumbnailAssetId = newUuid();
      const album = AlbumFactory.from({ albumThumbnailAssetId: thumbnailAssetId }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const auth = { ...AuthFactory.create(owner), hideNsfwAssets: true };
      mocks.album.getAll.mockResolvedValue([getForAlbum(album)]);
      mocks.album.getMetadataForIds.mockResolvedValue([]);
      mocks.smartAlbum.getSmartBackedAlbumIds.mockResolvedValue(new Set());
      mocks.asset.getHiddenContentAssetIds.mockResolvedValue(new Set([thumbnailAssetId]));

      const tree = await sut.getTree(auth);

      expect(tree.albums[0].albumThumbnailAssetId).toBeNull();
      expect(mocks.album.getMetadataForIds).toHaveBeenCalledWith([album.id], { excludeNsfw: true });
    });
  });

  describe('custom order (FL-52)', () => {
    const setup = () => {
      const collection = AlbumFactory.from({ albumName: 'Family', kind: AlbumKind.Collection }).build();
      const { user: owner } = collection.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const first = AlbumFactory.from({ parentId: collection.id }).owner(owner).build();
      const second = AlbumFactory.from({ parentId: collection.id }).owner(owner).build();
      const loose = AlbumFactory.from().owner(owner).build();
      const sharedWithMe = AlbumFactory.from().albumUser({ userId: owner.id, role: AlbumUserRole.Viewer }).build();
      const visible = [collection, first, second, loose, sharedWithMe];
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([collection.id]));
      mocks.album.getAll.mockResolvedValue(visible.map((item) => getForAlbum(item)));
      // The repository reads the directory inside its transaction and hands it to the check.
      mocks.album.setPositions.mockImplementation((_userId, _albumIds, validate) => {
        validate?.(visible.map(({ id, kind, parentId }) => ({ id, kind, parentId: parentId ?? null })));
        return Promise.resolve();
      });
      return { auth: AuthFactory.create(owner), collection, first, second, loose, sharedWithMe };
    };

    it("returns every group of the tree in the person's own order", async () => {
      const { auth, first, second, loose, sharedWithMe } = setup();
      mocks.album.getMetadataForIds.mockResolvedValue([]);
      mocks.smartAlbum.getSmartBackedAlbumIds.mockResolvedValue(new Set());
      mocks.album.getPositions.mockResolvedValue(
        new Map([
          [second.id, 0],
          [first.id, 1],
          [sharedWithMe.id, 0],
          [loose.id, 1],
        ]),
      );

      const tree = await sut.getTree(auth);

      expect(mocks.album.getPositions).toHaveBeenCalledWith(auth.user.id);
      expect(tree.collections[0].albums.map(({ id }) => id)).toEqual([second.id, first.id]);
      expect(tree.albums.map(({ id }) => id)).toEqual([sharedWithMe.id, loose.id]);
    });

    it('saves the order of the albums inside a collection for this person only', async () => {
      const { auth, collection, first, second } = setup();

      await sut.setOrder(auth, { parentId: collection.id, albumIds: [second.id, first.id] });

      expect(mocks.album.setPositions).toHaveBeenCalledWith(auth.user.id, [second.id, first.id], expect.any(Function));
      // Organization only: no album row, membership or access changes.
      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.album.reparent).not.toHaveBeenCalled();
    });

    it('orders a top-level group, including albums shared with the person', async () => {
      const { auth, loose, sharedWithMe } = setup();

      await sut.setOrder(auth, { parentId: null, albumIds: [sharedWithMe.id, loose.id] });

      expect(mocks.album.setPositions).toHaveBeenCalledWith(
        auth.user.id,
        [sharedWithMe.id, loose.id],
        expect.any(Function),
      );
    });

    it('refuses an order made from an outdated tree (an album moved out of the group since)', async () => {
      const { auth, collection, first, loose } = setup();

      // `loose` is not in the collection any more (or never was): the client's tree is stale.
      await expect(
        sut.setOrder(auth, { parentId: collection.id, albumIds: [loose.id, first.id] }),
      ).rejects.toBeInstanceOf(ConflictException);
      // The check runs before anything is written, inside the repository's transaction.
    });

    it('refuses an order that leaves out an album now in the group', async () => {
      const { auth, collection, first } = setup();

      await expect(sut.setOrder(auth, { parentId: collection.id, albumIds: [first.id] })).rejects.toBeInstanceOf(
        ConflictException,
      );
      // The check runs before anything is written, inside the repository's transaction.
    });

    it('refuses a collection the person can no longer see', async () => {
      const { auth, first } = setup();

      await expect(sut.setOrder(auth, { parentId: newUuid(), albumIds: [first.id] })).rejects.toBeInstanceOf(
        ConflictException,
      );
      // The check runs before anything is written, inside the repository's transaction.
    });

    it('refuses an album the person cannot see', async () => {
      const { auth } = setup();

      await expect(sut.setOrder(auth, { parentId: null, albumIds: [newUuid()] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // The check runs before anything is written, inside the repository's transaction.
    });

    it('refuses a repeated id', async () => {
      const { auth, loose } = setup();

      await expect(sut.setOrder(auth, { parentId: null, albumIds: [loose.id, loose.id] })).rejects.toThrow(
        'Each album may appear only once',
      );
      expect(mocks.album.setPositions).not.toHaveBeenCalled();
    });
  });

  describe('getIconCatalogue', () => {
    it('serves the pinned catalogue version, every name and the suggested groups', () => {
      const catalogue = sut.getIconCatalogue();
      expect(catalogue.version).toBe('7.4.47');
      expect(catalogue.names.length).toBeGreaterThan(7000);
      expect(catalogue.names).toContain('mdiCameraOutline');
      expect(catalogue.suggested.flatMap(({ icons }) => icons)).toHaveLength(227);
      expect(catalogue.suggested[0]).toMatchObject({ label: 'Albums and photos' });
    });
  });

  describe('getAlbumInfo', () => {
    it('should get a shared album', async () => {
      const album = AlbumFactory.from().albumUser().build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);

      await sut.get(AuthFactory.create(owner), album.id);

      expect(mocks.album.getById).toHaveBeenCalledWith(album.id, { withAssets: false }, owner.id);
      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([album.id]));
    });

    it('should get a shared album via a shared link', async () => {
      const album = AlbumFactory.from().albumUser().build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);

      const auth = AuthFactory.from().sharedLink().build();
      await sut.get(auth, album.id);

      expect(mocks.album.getById).toHaveBeenCalledWith(album.id, { withAssets: false }, auth.user.id);
      expect(mocks.access.album.checkSharedLinkAccess).toHaveBeenCalledWith(auth.sharedLink!.id, new Set([album.id]));
    });

    it('should get a shared album via shared with user', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id }).build();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getMetadataForIds.mockResolvedValue([
        {
          albumId: album.id,
          assetCount: 1,
          startDate: new Date('1970-01-01'),
          endDate: new Date('1970-01-01'),
          lastModifiedAssetTimestamp: new Date('1970-01-01'),
        },
      ]);

      await sut.get(AuthFactory.create(user), album.id);

      expect(mocks.album.getById).toHaveBeenCalledWith(album.id, { withAssets: false }, user.id);
      expect(mocks.access.album.checkSharedAlbumAccess).toHaveBeenCalledWith(
        user.id,
        new Set([album.id]),
        AlbumUserRole.Viewer,
      );
    });

    it('should throw an error for no access', async () => {
      const auth = AuthFactory.create();
      await expect(sut.get(auth, 'album-123')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(auth.user.id, new Set(['album-123']));
      expect(mocks.access.album.checkSharedAlbumAccess).toHaveBeenCalledWith(
        auth.user.id,
        new Set(['album-123']),
        AlbumUserRole.Viewer,
      );
    });
  });

  describe('getMapMarkers (FL-51)', () => {
    const albumId = newUuid();
    const after = new Date('2026-01-01T00:00:00.000Z');
    const before = new Date('2026-06-30T00:00:00.000Z');

    beforeEach(() => {
      mocks.map.getAlbumMapMarkers.mockResolvedValue([]);
    });

    it('leaves out the markers of an owner who hides locations from the viewer (FL-54)', async () => {
      const me = UserFactory.create();
      const hiding = UserFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      mocks.partner.getAll.mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(hiding).sharedWith(me).build()),
      ]);

      await sut.getMapMarkers(AuthFactory.create(me), albumId, {});

      expect(mocks.map.getAlbumMapMarkers).toHaveBeenCalledWith(
        albumId,
        expect.objectContaining({ locationHiddenOwnerIds: [hiding.id] }),
      );
    });

    it("judges a shared album link's markers by the link creator's partner settings (FL-54)", async () => {
      const creator = UserFactory.create();
      const hiding = UserFactory.create();
      const auth = AuthFactory.from(creator).sharedLink({ userId: creator.id, albumId, showExif: true }).build();
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set([albumId]));
      mocks.partner.getAll.mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(hiding).sharedWith(creator).build()),
      ]);

      await sut.getMapMarkers(auth, albumId, {});

      expect(mocks.partner.getAll).toHaveBeenCalledWith(creator.id);
      expect(mocks.map.getAlbumMapMarkers).toHaveBeenCalledWith(albumId, { locationHiddenOwnerIds: [hiding.id] });
    });

    it('requires album read access before reading any markers', async () => {
      const auth = AuthFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());

      await expect(sut.getMapMarkers(auth, albumId, { isFavorite: true })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.map.getAlbumMapMarkers).not.toHaveBeenCalled();
    });

    it("narrows a member's album map by the settings sheet, with favorites scoped to the viewer", async () => {
      const auth = AuthFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));

      await sut.getMapMarkers(auth, albumId, {
        isArchived: false,
        isFavorite: true,
        fileCreatedAfter: after,
        fileCreatedBefore: before,
      });

      expect(mocks.map.getAlbumMapMarkers).toHaveBeenCalledWith(albumId, {
        isArchived: false,
        isFavorite: true,
        fileCreatedAfter: after,
        fileCreatedBefore: before,
        favoriteOwnerId: auth.user.id,
      });
    });

    it('keeps the album behaviour for a client that sends no filters', async () => {
      const auth = AuthFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));

      await sut.getMapMarkers(auth, albumId);

      expect(mocks.map.getAlbumMapMarkers).toHaveBeenCalledWith(albumId, { favoriteOwnerId: auth.user.id });
    });

    it("keeps only the viewer's own items when Partner items is off, as the prototype does", async () => {
      const auth = AuthFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));

      await sut.getMapMarkers(auth, albumId, { withPartners: false, withSharedAlbums: true });
      expect(mocks.map.getAlbumMapMarkers).toHaveBeenLastCalledWith(albumId, {
        favoriteOwnerId: auth.user.id,
        onlyOwnerId: auth.user.id,
      });

      // "Shared spaces" only hides the viewer's own shared-space-only items, which album markers never are
      await sut.getMapMarkers(auth, albumId, { withPartners: true, withSharedAlbums: false });
      expect(mocks.map.getAlbumMapMarkers).toHaveBeenLastCalledWith(albumId, { favoriteOwnerId: auth.user.id });

      await sut.getMapMarkers(auth, albumId, { withPartners: true, withSharedAlbums: true });
      expect(mocks.map.getAlbumMapMarkers).toHaveBeenLastCalledWith(albumId, { favoriteOwnerId: auth.user.id });
    });

    it("ignores the filters on a shared link, which would otherwise reveal the owner's favorites", async () => {
      const auth = AuthFactory.from().sharedLink({ showExif: true }).build();
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set([albumId]));

      await sut.getMapMarkers(auth, albumId, {
        isFavorite: true,
        isArchived: false,
        fileCreatedAfter: after,
        withPartners: false,
        withSharedAlbums: false,
      });

      expect(mocks.map.getAlbumMapMarkers).toHaveBeenCalledWith(albumId, {});
    });

    it('returns nothing to a shared link that hides metadata, filters or not', async () => {
      const auth = AuthFactory.from().sharedLink({ showExif: false }).build();
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set([albumId]));

      await expect(sut.getMapMarkers(auth, albumId, { isFavorite: false })).resolves.toEqual([]);
      expect(mocks.map.getAlbumMapMarkers).not.toHaveBeenCalled();
    });
  });

  describe('addAssets', () => {
    it('should allow the owner to add assets', async () => {
      const owner = UserFactory.create({ isAdmin: true });
      const album = AlbumFactory.from().owner(owner).build();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset1.id, asset2.id, asset3.id] }),
      ).resolves.toEqual([
        { success: true, id: asset1.id },
        { success: true, id: asset2.id },
        { success: true, id: asset3.id },
      ]);

      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        {
          id: album.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIds).toHaveBeenCalledWith(album.id, [asset1.id, asset2.id, asset3.id]);
    });

    it('should not set the thumbnail if the album has one already', async () => {
      const [asset1, asset2] = [AssetFactory.create(), AssetFactory.create()];
      const album = AlbumFactory.from({ albumThumbnailAssetId: asset1.id }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset2.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset2.id] })).resolves.toEqual([
        { success: true, id: asset2.id },
      ]);

      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        {
          id: album.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIds).toHaveBeenCalled();
    });

    it('should allow a shared user to add assets', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Editor }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssets(AuthFactory.create(user), album.id, { ids: [asset1.id, asset2.id, asset3.id] }),
      ).resolves.toEqual([
        { success: true, id: asset1.id },
        { success: true, id: asset2.id },
        { success: true, id: asset3.id },
      ]);

      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        {
          id: album.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        user.id,
      );
      expect(mocks.album.addAssetIds).toHaveBeenCalledWith(album.id, [asset1.id, asset2.id, asset3.id]);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: album.id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [owner.id],
      });
    });

    it('should not allow a shared user with viewer access to add assets', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Viewer }).build();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(
        sut.addAssets(AuthFactory.create(user), album.id, { ids: [asset1.id, asset2.id, asset3.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should allow adding assets shared via partner sharing', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const asset = AssetFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: true, id: asset.id },
      ]);

      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        {
          id: album.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset.id,
        },
        owner.id,
      );
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(owner.id, new Set([asset.id]));
    });

    it('should skip duplicate assets', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set([asset.id]));

      await expect(sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: false, id: asset.id, error: BulkIdErrorReason.DUPLICATE },
      ]);

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should skip assets not shared with user', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await expect(sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: false, id: asset.id, error: BulkIdErrorReason.NO_PERMISSION },
      ]);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([asset.id]), false);
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(owner.id, new Set([asset.id]));
    });

    it('should not allow unauthorized access to the album', async () => {
      const user = UserFactory.create();
      const album = AlbumFactory.create();
      const asset = AssetFactory.create({ ownerId: user.id });
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(sut.addAssets(AuthFactory.create(user), album.id, { ids: [asset.id] })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalled();
      expect(mocks.access.album.checkSharedAlbumAccess).toHaveBeenCalled();
    });

    it('should not allow unauthorized shared link access to the album', async () => {
      const album = AlbumFactory.create();
      const asset = AssetFactory.create();
      mocks.album.getById.mockResolvedValue(getForAlbum(album));

      await expect(
        sut.addAssets(AuthFactory.from().sharedLink({ allowUpload: true }).build(), album.id, { ids: [asset.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.album.checkSharedLinkAccess).toHaveBeenCalled();
    });
  });

  describe('addAssetsToAlbums', () => {
    it('should allow the owner to add assets', async () => {
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(2);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album1.id,
        {
          id: album1.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        2,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album1.id, assetId: asset1.id },
        { albumId: album1.id, assetId: asset2.id },
        { albumId: album1.id, assetId: asset3.id },
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
    });

    it('should not set the thumbnail if the album has one already', async () => {
      const asset = AssetFactory.create();
      const album1 = AlbumFactory.from({ albumThumbnailAssetId: asset.id }).build();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.from({ albumThumbnailAssetId: asset.id }).build();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(2);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album1.id,
        {
          id: album1.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset.id,
        },
        owner.id,
      );
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        2,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album1.id, assetId: asset1.id },
        { albumId: album1.id, assetId: asset2.id },
        { albumId: album1.id, assetId: asset3.id },
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
    });

    it('should allow a shared user to add assets', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Editor }).build();
      const { user: owner1 } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Editor }).build();
      const { user: owner2 } = album2.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(user), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(2);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album1.id,
        {
          id: album1.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        user.id,
      );
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        2,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        user.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album1.id, assetId: asset1.id },
        { albumId: album1.id, assetId: asset2.id },
        { albumId: album1.id, assetId: asset3.id },
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: album1.id,
        userIds: album1.albumUsers.map(({ user }) => user.id),
        recipientIds: [owner1.id],
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: album2.id,
        userIds: album2.albumUsers.map(({ user }) => user.id),
        recipientIds: [owner2.id],
      });
    });

    it('should not allow a shared user with viewer access to add assets', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Viewer }).build();
      const album2 = AlbumFactory.from().albumUser({ userId: user.id, role: AlbumUserRole.Viewer }).build();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(user), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.NO_PERMISSION,
      });

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should allow adding assets shared via partner sharing', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [
        AssetFactory.create({ ownerId: user.id }),
        AssetFactory.create({ ownerId: user.id }),
        AssetFactory.create({ ownerId: user.id }),
      ];
      mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(2);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album1.id,
        {
          id: album1.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        2,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album1.id, assetId: asset1.id },
        { albumId: album1.id, assetId: asset2.id },
        { albumId: album1.id, assetId: asset3.id },
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(
        owner.id,
        new Set([asset1.id, asset2.id, asset3.id]),
      );
    });

    it('should skip some duplicate assets', async () => {
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();

      mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album1.id, album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getAssetIds
        .mockResolvedValueOnce(new Set([asset1.id, asset2.id, asset3.id]))
        .mockResolvedValueOnce(new Set());
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.update).toHaveBeenCalledTimes(1);
      expect(mocks.album.update).toHaveBeenNthCalledWith(
        1,
        album2.id,
        {
          id: album2.id,
          updatedAt: expect.any(Date),
          albumThumbnailAssetId: asset1.id,
        },
        owner.id,
      );
      expect(mocks.album.addAssetIdsToAlbums).toHaveBeenCalledWith([
        { albumId: album2.id, assetId: asset1.id },
        { albumId: album2.id, assetId: asset2.id },
        { albumId: album2.id, assetId: asset3.id },
      ]);
    });

    it('should skip all duplicate assets', async () => {
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();
      mocks.access.album.checkOwnerAccess
        .mockResolvedValueOnce(new Set([album1.id]))
        .mockResolvedValueOnce(new Set([album2.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValue(new Set([asset1.id, asset2.id, asset3.id]));

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.DUPLICATE,
      });

      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
    });

    it('should skip assets not shared with user', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.create();
      const { user: owner } = album1.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [
        AssetFactory.create({ ownerId: user.id }),
        AssetFactory.create({ ownerId: user.id }),
        AssetFactory.create({ ownerId: user.id }),
      ];
      mocks.access.album.checkSharedAlbumAccess
        .mockResolvedValueOnce(new Set([album1.id]))
        .mockResolvedValueOnce(new Set([album2.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set());

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(owner), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.NO_PERMISSION,
      });

      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        owner.id,
        new Set([asset1.id, asset2.id, asset3.id]),
        false,
      );
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(
        owner.id,
        new Set([asset1.id, asset2.id, asset3.id]),
      );
    });

    it('should not allow unauthorized access to the albums', async () => {
      const user = UserFactory.create();
      const album1 = AlbumFactory.create();
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));

      await expect(
        sut.addAssetsToAlbums(AuthFactory.create(user), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.NO_PERMISSION,
      });

      expect(mocks.album.update).not.toHaveBeenCalled();
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalled();
      expect(mocks.access.album.checkSharedAlbumAccess).toHaveBeenCalled();
    });

    it('should not allow unauthorized shared link access to the album', async () => {
      const album1 = AlbumFactory.create();
      const album2 = AlbumFactory.create();
      const [asset1, asset2, asset3] = [AssetFactory.create(), AssetFactory.create(), AssetFactory.create()];
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album1)).mockResolvedValueOnce(getForAlbum(album2));

      await expect(
        sut.addAssetsToAlbums(AuthFactory.from().sharedLink({ allowUpload: true }).build(), {
          albumIds: [album1.id, album2.id],
          assetIds: [asset1.id, asset2.id, asset3.id],
        }),
      ).resolves.toEqual({
        success: false,
        error: BulkIdErrorReason.NO_PERMISSION,
      });

      expect(mocks.access.album.checkSharedLinkAccess).toHaveBeenCalled();
    });
  });

  describe('removeAssets', () => {
    it('should allow the owner to remove assets', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set([asset.id]));

      await expect(sut.removeAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: true, id: asset.id },
      ]);

      expect(mocks.album.removeAssetIds).toHaveBeenCalledWith(album.id, [asset.id]);
    });

    it('should skip assets not in the album', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set());

      await expect(sut.removeAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: false, id: asset.id, error: BulkIdErrorReason.NOT_FOUND },
      ]);

      expect(mocks.album.update).not.toHaveBeenCalled();
    });

    it('should allow owner to remove all assets from the album', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set([asset.id]));

      await expect(sut.removeAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] })).resolves.toEqual([
        { success: true, id: asset.id },
      ]);
    });

    it('should reset the thumbnail if it is removed', async () => {
      const asset1 = AssetFactory.create();
      const asset2 = AssetFactory.create();
      const album = AlbumFactory.from({ albumThumbnailAssetId: asset1.id }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset1.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValue(new Set([asset1.id, asset2.id]));

      await expect(sut.removeAssets(AuthFactory.create(owner), album.id, { ids: [asset1.id] })).resolves.toEqual([
        { success: true, id: asset1.id },
      ]);

      expect(mocks.album.updateThumbnails).toHaveBeenCalled();
    });
  });

  // // it('removes assets from shared album (shared with auth user)', async () => {
  // //   const albumEntity = _getOwnedSharedAlbum();
  // //   albumRepositoryMock.get.mockImplementation(() => Promise.resolve<AlbumEntity>(albumEntity));
  // //   albumRepositoryMock.removeAssets.mockImplementation(() => Promise.resolve<AlbumEntity>(albumEntity));

  // //   await expect(
  // //     sut.removeAssetsFromAlbum(
  // //       auth,
  // //       {
  // //         ids: ['1'],
  // //       },
  // //       albumEntity.id,
  // //     ),
  // //   ).resolves.toBeUndefined();
  // //   expect(albumRepositoryMock.removeAssets).toHaveBeenCalledTimes(1);
  // //   expect(albumRepositoryMock.removeAssets).toHaveBeenCalledWith(albumEntity, {
  // //     ids: ['1'],
  // //   });
  // // });

  // it('prevents removing assets from a not owned / shared album', async () => {
  //   const albumEntity = _getNotOwnedNotSharedAlbum();

  //   const albumResponse: AddAssetsResponseDto = {
  //     alreadyInAlbum: [],
  //     successfullyAdded: 1,
  //   };

  //   const albumId = albumEntity.id;

  //   albumRepositoryMock.get.mockImplementation(() => Promise.resolve<AlbumEntity>(albumEntity));
  //   albumRepositoryMock.addAssets.mockImplementation(() => Promise.resolve<AddAssetsResponseDto>(albumResponse));

  //   await expect(sut.removeAssets(auth, albumId, { ids: ['1'] })).rejects.toBeInstanceOf(ForbiddenException);
  // });

  describe('hierarchy', () => {
    describe('create', () => {
      it('passes parentId through to the repository when it is set', async () => {
        // Albums nest only inside a collection, so the parent here is one.
        const collection = AlbumFactory.from({ kind: AlbumKind.Collection }).build();
        const parentId = collection.id;
        const album = AlbumFactory.from({ parentId }).albumUser().build();
        const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
        const auth = AuthFactory.create(owner);

        mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([parentId]));
        mocks.album.getById.mockResolvedValue(getForAlbum(collection));
        mocks.album.create.mockResolvedValue(getForAlbum(album));
        mocks.user.getMetadata.mockResolvedValue([]);

        await sut.create(auth, { albumName: album.albumName, parentId });

        expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([parentId]));
        expect(mocks.album.create).toHaveBeenCalledWith(
          expect.objectContaining({ parentId }),
          expect.anything(),
          expect.anything(),
          owner.id,
        );
      });

      it('rejects creating under a parent the caller cannot update', async () => {
        const parentId = newUuid();
        const auth = AuthFactory.create();
        mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set()); // no access granted
        mocks.user.getMetadata.mockResolvedValue([]);

        await expect(sut.create(auth, { albumName: 'child', parentId })).rejects.toBeInstanceOf(BadRequestException);
        expect(mocks.album.create).not.toHaveBeenCalled();
      });
    });

    describe('update', () => {
      it('reparents an album when parentId changes to a new uuid', async () => {
        const album = AlbumFactory.from().albumUser().build();
        const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
        // Albums nest only inside a collection, so the new parent is one.
        const collection = AlbumFactory.from({ kind: AlbumKind.Collection }).build();
        const newParentId = collection.id;
        const auth = AuthFactory.create(owner);

        mocks.access.album.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(new Set(ids)));
        mocks.album.getById.mockImplementation((id: string) =>
          Promise.resolve(getForAlbum(id === collection.id ? collection : album)),
        );
        mocks.album.update.mockResolvedValue(getForAlbum(album));

        await sut.update(auth, album.id, { parentId: newParentId });

        expect(mocks.album.reparent).toHaveBeenCalledWith(album.id, newParentId);
      });

      it('reparents to the root when parentId is set to null', async () => {
        const album = AlbumFactory.from({ parentId: newUuid() }).albumUser().build();
        const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
        const auth = AuthFactory.create(owner);

        mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
        mocks.album.getById.mockResolvedValue(getForAlbum(album));
        mocks.album.update.mockResolvedValue(getForAlbum(album));

        await sut.update(auth, album.id, { parentId: null });

        expect(mocks.album.reparent).toHaveBeenCalledWith(album.id, null);
      });

      it('rejects an album becoming its own parent', async () => {
        const album = AlbumFactory.from().albumUser().build();
        const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
        const auth = AuthFactory.create(owner);

        mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
        mocks.album.getById.mockResolvedValue(getForAlbum(album));

        await expect(sut.update(auth, album.id, { parentId: album.id })).rejects.toBeInstanceOf(BadRequestException);
        expect(mocks.album.reparent).not.toHaveBeenCalled();
      });

      it('propagates the cycle rejection raised atomically inside reparent', async () => {
        // The descendant/cycle check now runs inside albumRepository.reparent's
        // transaction (atomic with the parent update) to close the TOCTOU window.
        // The service delegates to reparent and surfaces its BadRequestException.
        const album = AlbumFactory.from().albumUser().build();
        const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
        // Albums nest only inside a collection; the cycle is what the repository refuses.
        const descendant = AlbumFactory.from({ kind: AlbumKind.Collection }).build();
        const descendantId = descendant.id;
        const auth = AuthFactory.create(owner);

        mocks.access.album.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(new Set(ids)));
        mocks.album.getById.mockImplementation((id: string) =>
          Promise.resolve(getForAlbum(id === descendant.id ? descendant : album)),
        );
        mocks.album.reparent.mockRejectedValue(
          new BadRequestException('Cannot move an album under one of its own descendants'),
        );

        await expect(sut.update(auth, album.id, { parentId: descendantId })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(mocks.album.reparent).toHaveBeenCalledWith(album.id, descendantId);
      });

      it('rejects moving under a parent the caller does not own', async () => {
        const album = AlbumFactory.from().albumUser().build();
        const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
        const auth = AuthFactory.create(owner);
        const someoneElsesAlbumId = newUuid();

        // First requireAccess (for albumId) passes, second (for newParentId) fails.
        mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album.id]));
        mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set());
        mocks.album.getById.mockResolvedValue(getForAlbum(album));

        await expect(sut.update(auth, album.id, { parentId: someoneElsesAlbumId })).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(mocks.album.reparent).not.toHaveBeenCalled();
      });
    });

    describe('getDescendantCount', () => {
      it('returns the count from the repository', async () => {
        const album = AlbumFactory.from().albumUser().build();
        const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
        const auth = AuthFactory.create(owner);
        mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
        mocks.album.getDescendantCount.mockResolvedValue(5);

        await expect(sut.getDescendantCount(auth, album.id)).resolves.toEqual({ count: 5 });
        expect(mocks.album.getDescendantCount).toHaveBeenCalledWith(album.id);
      });
    });
  });

  describe('shared space membership (FL-55)', () => {
    beforeEach(() => {
      // The album-user repository mock is strict. These are the membership writes the paths
      // below make; each test asserts which of them ran.
      mocks.albumUser.createInvite.mockImplementation(({ albumId, userId, role, invitedById }) =>
        Promise.resolve({
          albumId,
          userId,
          role: role ?? AlbumUserRole.Viewer,
          invitedById: invitedById ?? null,
          createdAt: new Date(),
        }),
      );
      mocks.albumUser.create.mockImplementation(({ albumId, userId, role }) =>
        Promise.resolve({ albumId, userId, role: role ?? AlbumUserRole.Editor }),
      );
      mocks.albumUser.update.mockResolvedValue();
      mocks.albumUser.delete.mockResolvedValue();
      mocks.albumUser.createSpaceEvent.mockResolvedValue();
    });

    it('invites rather than adds, so nobody is put into a space without agreeing', async () => {
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      const { user: owner } = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      const user = UserFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.user.get.mockResolvedValue(user);

      await sut.addUsers(AuthFactory.create(owner), space.id, {
        albumUsers: [{ userId: user.id, role: AlbumUserRole.Viewer }],
      });

      expect(mocks.albumUser.create).not.toHaveBeenCalled();
      expect(mocks.albumUser.createInvite).toHaveBeenCalledWith({
        albumId: space.id,
        userId: user.id,
        role: AlbumUserRole.Viewer,
        invitedById: owner.id,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumInvite', {
        id: space.id,
        userId: user.id,
        senderName: owner.name,
      });
    });

    it('refuses an editor of a space inviting anyone', async () => {
      const editorId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: editorId, role: AlbumUserRole.Editor })
        .build();
      const { user: editor } = space.albumUsers.find(({ user }) => user.id === editorId)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await expect(
        sut.addUsers(AuthFactory.create(editor), space.id, { albumUsers: [{ userId: newUuid() }] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.albumUser.createInvite).not.toHaveBeenCalled();
      expect(mocks.albumUser.create).not.toHaveBeenCalled();
    });

    it('still lets an editor of a plain album share it', async () => {
      const editorId = newUuid();
      const album = AlbumFactory.from().albumUser({ userId: editorId, role: AlbumUserRole.Editor }).build();
      const { user: editor } = album.albumUsers.find(({ user }) => user.id === editorId)!;
      const user = UserFactory.create();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.user.get.mockResolvedValue(user);

      await sut.addUsers(AuthFactory.create(editor), album.id, { albumUsers: [{ userId: user.id }] });

      expect(mocks.albumUser.create).toHaveBeenCalled();
      expect(mocks.albumUser.createInvite).not.toHaveBeenCalled();
    });

    it('refuses to offer the owner role in a space', async () => {
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      const { user: owner } = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await expect(
        sut.addUsers(AuthFactory.create(owner), space.id, {
          albumUsers: [{ userId: newUuid(), role: AlbumUserRole.Owner }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets the space owner change a member role', async () => {
      const viewerId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: viewerId, role: AlbumUserRole.Viewer })
        .build();
      const { user: owner } = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.albumUser.getInvite.mockResolvedValue(void 0);

      await sut.updateUser(AuthFactory.create(owner), space.id, viewerId, { role: AlbumUserRole.Editor });

      expect(mocks.albumUser.update).toHaveBeenCalledWith(
        { albumId: space.id, userId: viewerId },
        { role: AlbumUserRole.Editor },
      );
    });

    it('changes the offer, not a role, when the person has not joined yet', async () => {
      const invitedId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space }).build();
      const { user: owner } = space.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));
      mocks.albumUser.getInvite.mockResolvedValue({
        albumId: space.id,
        userId: invitedId,
        role: AlbumUserRole.Viewer,
        invitedById: owner.id,
        createdAt: new Date(),
      });

      await sut.updateUser(AuthFactory.create(owner), space.id, invitedId, { role: AlbumUserRole.Editor });

      expect(mocks.albumUser.update).not.toHaveBeenCalled();
      expect(mocks.albumUser.createInvite).toHaveBeenCalledWith({
        albumId: space.id,
        userId: invitedId,
        role: AlbumUserRole.Editor,
        invitedById: owner.id,
      });
    });

    it('refuses an editor of a space removing another member, but lets them leave', async () => {
      const editorId = newUuid();
      const viewerId = newUuid();
      const space = AlbumFactory.from({ kind: AlbumKind.Space })
        .albumUser({ userId: editorId, role: AlbumUserRole.Editor })
        .albumUser({ userId: viewerId, role: AlbumUserRole.Viewer })
        .build();
      const { user: editor } = space.albumUsers.find(({ user }) => user.id === editorId)!;
      const auth = AuthFactory.create(editor);
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([space.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(space));

      await expect(sut.removeUser(auth, space.id, viewerId)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.albumUser.delete).not.toHaveBeenCalled();

      await sut.removeUser(auth, space.id, 'me');
      expect(mocks.albumUser.delete).toHaveBeenCalledWith({ albumId: space.id, userId: editorId });
    });
  });

  describe('Locked media in albums (FL-32)', () => {
    const elevated = (user: { id: string }) => AuthFactory.from(user).session({ hasElevatedPermission: true }).build();

    it('reads an album with the elevated owner as the Locked owner', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getMetadataForIds.mockResolvedValue([]);

      await sut.get(elevated(owner), album.id);

      expect(mocks.album.getById).toHaveBeenCalledWith(
        album.id,
        { withAssets: false, lockedOwnerId: owner.id },
        owner.id,
      );
      expect(mocks.album.getMetadataForIds).toHaveBeenCalledWith([album.id], { lockedOwnerId: owner.id });
    });

    it('reads an album without a Locked owner for an ordinary session', async () => {
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getMetadataForIds.mockResolvedValue([]);

      await sut.get(AuthFactory.create(owner), album.id);

      expect(mocks.album.getById.mock.calls[0][1].lockedOwnerId).toBeUndefined();
      expect(mocks.album.getMetadataForIds).toHaveBeenCalledWith([album.id], {});
    });

    it('never offers Locked media as a cover choice, even to the elevated owner', async () => {
      const album = AlbumFactory.from()
        .asset({}, (builder) => builder.exif())
        .build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.update.mockResolvedValue(getForAlbum(album));

      await sut.update(elevated(owner), album.id, { albumName: 'renamed' });

      expect(mocks.album.getById.mock.calls[0][1]).toMatchObject({ withAssets: true });
      expect(mocks.album.getById.mock.calls[0][1].lockedOwnerId).toBeUndefined();
    });

    it('lets an elevated owner add Locked items and picks a cover that is not Locked', async () => {
      const [locked, plain] = [AssetFactory.create(), AssetFactory.create()];
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([locked.id, plain.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());
      mocks.album.getFirstCoverCandidate.mockResolvedValue(plain.id);

      await expect(sut.addAssets(elevated(owner), album.id, { ids: [locked.id, plain.id] })).resolves.toEqual([
        { success: true, id: locked.id },
        { success: true, id: plain.id },
      ]);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([locked.id, plain.id]), true);
      expect(mocks.album.getFirstCoverCandidate).toHaveBeenCalledWith([locked.id, plain.id]);
      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        { id: album.id, updatedAt: expect.any(Date), albumThumbnailAssetId: plain.id },
        owner.id,
      );
      expect(mocks.album.addAssetIds).toHaveBeenCalledWith(album.id, [locked.id, plain.id]);
    });

    it('leaves the cover unset when an elevated owner adds only Locked items to an uncovered album', async () => {
      const locked = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([locked.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());
      mocks.album.getFirstCoverCandidate.mockResolvedValue(undefined);

      await sut.addAssets(elevated(owner), album.id, { ids: [locked.id] });

      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        { id: album.id, updatedAt: expect.any(Date), albumThumbnailAssetId: undefined },
        owner.id,
      );
    });

    it('does not consult the database for the cover of an ordinary session', async () => {
      const asset = AssetFactory.create();
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.album.getById.mockResolvedValue(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());

      await sut.addAssets(AuthFactory.create(owner), album.id, { ids: [asset.id] });

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([asset.id]), false);
      expect(mocks.album.getFirstCoverCandidate).not.toHaveBeenCalled();
      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        { id: album.id, updatedAt: expect.any(Date), albumThumbnailAssetId: asset.id },
        owner.id,
      );
    });

    it('creates an album from Locked items with a null cover when nothing else was added', async () => {
      const locked = AssetFactory.create();
      const album = AlbumFactory.from({ albumName: 'private' }).build();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.album.create.mockResolvedValue(getForAlbum(album));
      mocks.user.getMetadata.mockResolvedValue([]);
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([locked.id]));
      mocks.album.getFirstCoverCandidate.mockResolvedValue(undefined);

      await sut.create(elevated(owner), { albumName: 'private', assetIds: [locked.id] });

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(owner.id, new Set([locked.id]), true);
      expect(mocks.album.create).toHaveBeenCalledWith(
        expect.objectContaining({ albumName: 'private', albumThumbnailAssetId: null }),
        [locked.id],
        [{ userId: owner.id, role: AlbumUserRole.Owner }],
        owner.id,
      );
    });

    it('adds Locked items to several albums and covers each with a candidate that is not Locked', async () => {
      const [locked, plain] = [AssetFactory.create(), AssetFactory.create()];
      const album = AlbumFactory.create();
      const { user: owner } = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;
      mocks.access.album.checkOwnerAccess.mockResolvedValueOnce(new Set([album.id]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([locked.id, plain.id]));
      mocks.album.getById.mockResolvedValueOnce(getForAlbum(album));
      mocks.album.getAssetIds.mockResolvedValueOnce(new Set());
      mocks.album.getFirstCoverCandidate.mockResolvedValue(plain.id);

      await expect(
        sut.addAssetsToAlbums(elevated(owner), { albumIds: [album.id], assetIds: [locked.id, plain.id] }),
      ).resolves.toEqual({ success: true, error: undefined });

      expect(mocks.album.getFirstCoverCandidate).toHaveBeenCalledWith([locked.id, plain.id]);
      expect(mocks.album.update).toHaveBeenCalledWith(
        album.id,
        { id: album.id, updatedAt: expect.any(Date), albumThumbnailAssetId: plain.id },
        owner.id,
      );
    });
  });
});
