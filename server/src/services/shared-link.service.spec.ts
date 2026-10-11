import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AssetIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { SHARED_LINK_PASSWORD_MASK, mapSharedLink } from 'src/dtos/shared-link.dto.js';
import { SharedLinkType } from 'src/enum.js';
import { SharedLinkService } from 'src/services/shared-link.service.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { SharedLinkFactory } from 'test/factories/shared-link.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { sharedLinkStub } from 'test/fixtures/shared-link.stub.js';
import { getForSharedLink } from 'test/mappers.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/** A link as the list of links loads it: its count and cover, not its contents. */
const listed = (link: Parameters<typeof getForSharedLink>[0]) => ({
  ...getForSharedLink(link),
  assetCount: 0,
  coverAssets: [],
});

describe(SharedLinkService.name, () => {
  let sut: SharedLinkService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SharedLinkService));
    mocks.partner.getAll.mockResolvedValue([]);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getAll', () => {
    it('should return all shared links for a user', async () => {
      const links = [SharedLinkFactory.create(), SharedLinkFactory.create()].map((link) => listed(link));
      mocks.sharedLink.getAll.mockResolvedValue(links);
      await expect(sut.getAll(authStub.user1, {})).resolves.toEqual(
        links.map((link) => mapSharedLink(link, { stripAssetMetadata: false })),
      );
      expect(mocks.sharedLink.getAll).toHaveBeenCalledWith({ userId: authStub.user1.user.id });
    });

    it("should answer a saved album link with the list's album, count and cover", async () => {
      const link = SharedLinkFactory.from({ type: SharedLinkType.Album }).album().build();
      const saved = { ...getForSharedLink(link), album: undefined };
      const coverAssets = [{ id: newUuid() }];
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(link));
      mocks.sharedLink.update.mockResolvedValue(saved);
      mocks.sharedLink.getAll.mockResolvedValue([{ ...getForSharedLink(link), assetCount: 3, coverAssets }]);

      const response = await sut.update(authStub.user1, link.id, { description: 'Renamed' });

      expect(mocks.sharedLink.getAll).toHaveBeenCalledWith({ userId: authStub.user1.user.id, id: link.id });
      expect(response).toMatchObject({ assetCount: 3, coverAssetIds: [coverAssets[0].id] });
      expect(response.album?.assetCount).toBe(3);
    });

    it("should carry an album link's listed count and cover, which the list loads without the album's assets", async () => {
      const link = SharedLinkFactory.from({ type: SharedLinkType.Album }).album().build();
      const coverAssets = [{ id: newUuid() }, { id: newUuid() }];
      mocks.sharedLink.getAll.mockResolvedValue([{ ...getForSharedLink(link), assetCount: 7, coverAssets }]);
      const [response] = await sut.getAll(authStub.user1, {});
      expect(response).toMatchObject({ assetCount: 7, coverAssetIds: coverAssets.map(({ id }) => id) });
      expect(response.album?.assetCount).toBe(7);
    });
  });

  describe('public address (FL-305)', () => {
    it("carries each link's public address on the external domain, by slug or by key", async () => {
      mocks.systemMetadata.get.mockResolvedValue({ server: { externalDomain: 'https://photos.example.com/' } });
      const byKey = SharedLinkFactory.create();
      const bySlug = SharedLinkFactory.create({ slug: 'summer trip/2026' });
      mocks.sharedLink.getAll.mockResolvedValue([listed(byKey), listed(bySlug)]);
      const [first, second] = await sut.getAll(authStub.user1, {});
      expect(first.url).toBe(`https://photos.example.com/share/${first.key}`);
      expect(second.url).toBe('https://photos.example.com/s/summer%20trip%2F2026');
    });

    it('has no address without an external domain', async () => {
      const link = SharedLinkFactory.create();
      mocks.sharedLink.getAll.mockResolvedValue([listed(link)]);
      const [response] = await sut.getAll(authStub.user1, {});
      expect(response.url).toBeNull();
    });
  });

  describe('getMine', () => {
    it('should only work for a public user', async () => {
      await expect(sut.getMine(authStub.admin, [])).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.sharedLink.get).not.toHaveBeenCalled();
    });

    it('should return the shared link for the public user', async () => {
      const authDto = authStub.adminSharedLink;
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      await expect(sut.getMine(authDto, [])).resolves.toEqual(
        mapSharedLink(getForSharedLink(sharedLink), { stripAssetMetadata: false }),
      );
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authDto.user.id, authDto.sharedLink?.id);
    });

    it('should not return metadata', async () => {
      const authDto = factory.auth({
        sharedLink: {
          showExif: false,
          allowDownload: true,
          allowUpload: true,
        },
      });
      mocks.sharedLink.get.mockResolvedValue(
        getForSharedLink(
          SharedLinkFactory.from({ showExif: false })
            .asset({}, (builder) => builder.exif())
            .build(),
        ),
      );
      const response = await sut.getMine(authDto, []);
      expect(response.assets[0]).toMatchObject({ hasMetadata: false });
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authDto.user.id, authDto.sharedLink?.id);
    });

    it('should throw an error for a request without a shared link auth token', async () => {
      const authDto = authStub.adminSharedLink;
      mocks.sharedLink.get.mockResolvedValue(sharedLinkStub.passwordRequired);
      await expect(sut.getMine(authDto, [])).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authDto.user.id, authDto.sharedLink?.id);
    });

    it('should accept a valid shared link auth token', async () => {
      const sharedLink = SharedLinkFactory.create({ password: '123' });
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      const secret = 'auth-token-123';
      mocks.crypto.serverKeyedHash.mockResolvedValue(secret);
      await expect(sut.getMine(authStub.adminSharedLink, [secret])).resolves.toBeDefined();
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(
        authStub.adminSharedLink.user.id,
        authStub.adminSharedLink.sharedLink?.id,
      );
    });
  });

  describe('public owner (FL-83)', () => {
    it('tells a public viewer the link owner display name', async () => {
      const sharedLink = SharedLinkFactory.from().owner({ name: 'Riley Owner' }).album().build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));

      const response = await sut.getMine(authStub.adminSharedLink, []);

      expect(response.owner).toEqual({ name: 'Riley Owner' });
    });

    it('exposes nothing about the owner beyond the display name', async () => {
      const sharedLink = SharedLinkFactory.from()
        .owner({
          name: 'Riley Owner',
          email: 'riley.private@example.com',
          profileImagePath: '/data/profile/riley.jpg',
          avatarColor: null,
          isAdmin: true,
          storageLabel: 'riley-label',
          oauthId: 'oauth-riley',
        })
        .asset({}, (builder) => builder.exif())
        .build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));

      const response = await sut.getMine(authStub.adminSharedLink, []);

      expect(Object.keys(response.owner ?? {})).toEqual(['name']);
      const serialized = JSON.stringify(response);
      for (const secret of ['riley.private@example.com', '/data/profile/riley.jpg', 'riley-label', 'oauth-riley']) {
        expect(serialized).not.toContain(secret);
      }
    });

    it('leaves the owner out when the repository found none', async () => {
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue({ ...getForSharedLink(sharedLink), owner: null });

      const response = await sut.getMine(authStub.adminSharedLink, []);

      expect(response.owner).toBeUndefined();
    });
  });

  describe('get', () => {
    it('should throw an error for an invalid shared link', async () => {
      mocks.sharedLink.get.mockResolvedValue(void 0);

      await expect(sut.get(authStub.user1, 'missing-id')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, 'missing-id');
      expect(mocks.sharedLink.update).not.toHaveBeenCalled();
    });

    it('should get a shared link by id', async () => {
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      await expect(sut.get(authStub.user1, sharedLink.id)).resolves.toEqual(
        mapSharedLink(getForSharedLink(sharedLink), { stripAssetMetadata: true }),
      );
      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, sharedLink.id);
    });
  });

  describe('create', () => {
    it('should not allow an album shared link without an albumId', async () => {
      await expect(sut.create(authStub.admin, { type: SharedLinkType.Album, assetIds: [] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should not allow non-owners to create album shared links', async () => {
      await expect(
        sut.create(authStub.admin, { type: SharedLinkType.Album, assetIds: [], albumId: 'album-1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should not allow individual shared links with no assets', async () => {
      await expect(
        sut.create(authStub.admin, { type: SharedLinkType.Individual, assetIds: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should require asset ownership to make an individual shared link', async () => {
      await expect(
        sut.create(authStub.admin, { type: SharedLinkType.Individual, assetIds: ['asset-1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should create an album shared link', async () => {
      const album = AlbumFactory.from().asset().build();
      const sharedLink = SharedLinkFactory.from().album(album).build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.create(authStub.admin, { type: SharedLinkType.Album, albumId: album.id });

      expect(mocks.access.album.checkOwnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set([album.id]));
      expect(mocks.sharedLink.create).toHaveBeenCalledWith({
        type: SharedLinkType.Album,
        userId: authStub.admin.user.id,
        albumId: album.id,
        allowDownload: true,
        allowUpload: true,
        description: null,
        expiresAt: null,
        slug: null,
        showExif: true,
        key: Buffer.from('random-bytes', 'utf8'),
      });
    });

    it('should create an individual shared link', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from()
        .asset(asset, (builder) => builder.exif())
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.create(authStub.admin, {
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
        showMetadata: true,
        allowDownload: true,
        allowUpload: true,
      });

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set([asset.id]),
        false,
      );
      expect(mocks.sharedLink.create).toHaveBeenCalledWith({
        type: SharedLinkType.Individual,
        userId: authStub.admin.user.id,
        albumId: null,
        allowDownload: true,
        slug: null,
        allowUpload: true,
        assetIds: [asset.id],
        description: null,
        expiresAt: null,
        showExif: true,
        key: Buffer.from('random-bytes', 'utf8'),
      });
    });

    it('should create a shared link with allowDownload set to false when showMetadata is false', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from({ allowDownload: false })
        .asset(asset, (builder) => builder.exif())
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.create(authStub.admin, {
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
        showMetadata: false,
        allowDownload: true,
        allowUpload: true,
      });

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set([asset.id]),
        false,
      );
      expect(mocks.sharedLink.create).toHaveBeenCalledWith({
        type: SharedLinkType.Individual,
        userId: authStub.admin.user.id,
        albumId: null,
        allowDownload: false,
        allowUpload: true,
        assetIds: [asset.id],
        description: null,
        expiresAt: null,
        showExif: false,
        slug: null,
        key: Buffer.from('random-bytes', 'utf8'),
      });
    });
    it('should say when the custom address is already used by another link (FL-83 AL-26)', async () => {
      const album = AlbumFactory.from().asset().build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.sharedLink.create.mockRejectedValue({ constraint_name: 'shared_link_slug_uq' });

      await expect(
        sut.create(authStub.admin, { type: SharedLinkType.Album, albumId: album.id, slug: 'summer-trip' }),
      ).rejects.toThrow(new BadRequestException('Shared link slug is already in use'));
    });
  });

  describe('update', () => {
    it('should throw an error for an invalid shared link', async () => {
      mocks.sharedLink.get.mockResolvedValue(void 0);

      await expect(sut.update(authStub.user1, 'missing-id', {})).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, 'missing-id');
      expect(mocks.sharedLink.update).not.toHaveBeenCalled();
    });

    it('should say when the new custom address is already used by another link (FL-83 AL-26)', async () => {
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockRejectedValue({ constraint_name: 'shared_link_slug_uq' });

      await expect(sut.update(authStub.user1, sharedLinkStub.valid.id, { slug: 'summer-trip' })).rejects.toThrow(
        new BadRequestException('Shared link slug is already in use'),
      );
    });

    it('should update a shared link', async () => {
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.update(authStub.user1, sharedLinkStub.valid.id, { allowDownload: false });

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, sharedLinkStub.valid.id);
      expect(mocks.sharedLink.update).toHaveBeenCalledWith({
        id: sharedLinkStub.valid.id,
        slug: null,
        userId: authStub.user1.user.id,
        allowDownload: false,
      });
    });

    it('should turn off downloads when an update hides the metadata', async () => {
      const sharedLink = SharedLinkFactory.create({ showExif: true, allowDownload: true });
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.update(authStub.user1, sharedLink.id, { showMetadata: false, allowDownload: true });

      expect(mocks.sharedLink.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: sharedLink.id, showExif: false, allowDownload: false }),
      );
    });

    it('should keep downloads off when the link already hides the metadata', async () => {
      const sharedLink = SharedLinkFactory.create({ showExif: false, allowDownload: false });
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.update(authStub.user1, sharedLink.id, { allowDownload: true });

      expect(mocks.sharedLink.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: sharedLink.id, allowDownload: false }),
      );
    });

    it('should allow downloads when an update shows the metadata again', async () => {
      const sharedLink = SharedLinkFactory.create({ showExif: false, allowDownload: false });
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.update(authStub.user1, sharedLink.id, { showMetadata: true, allowDownload: true });

      expect(mocks.sharedLink.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: sharedLink.id, showExif: true, allowDownload: true }),
      );
    });

    it('should refetch an updated shared link with hidden content filters', async () => {
      const auth = { ...authStub.user1, hideNsfwAssets: true };
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.update(auth, sharedLinkStub.valid.id, { allowDownload: false });

      expect(mocks.sharedLink.get).toHaveBeenNthCalledWith(1, auth.user.id, sharedLinkStub.valid.id, {
        excludeNsfw: true,
      });
      expect(mocks.sharedLink.get).toHaveBeenNthCalledWith(2, auth.user.id, sharedLinkStub.valid.id, {
        excludeNsfw: true,
      });
    });
  });

  describe('remove', () => {
    it('should throw an error for an invalid shared link', async () => {
      mocks.sharedLink.get.mockResolvedValue(void 0);

      await expect(sut.remove(authStub.user1, 'missing-id')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, 'missing-id');
      expect(mocks.sharedLink.update).not.toHaveBeenCalled();
    });

    it('should remove a key', async () => {
      const sharedLink = SharedLinkFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.remove.mockResolvedValue();

      await sut.remove(authStub.user1, sharedLink.id);

      expect(mocks.sharedLink.get).toHaveBeenCalledWith(authStub.user1.user.id, sharedLink.id);
      expect(mocks.sharedLink.remove).toHaveBeenCalledWith(sharedLink.id);
    });
  });

  describe('addAssets', () => {
    it('should not work on album shared links', async () => {
      const sharedLink = SharedLinkFactory.from().album().build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));

      await expect(sut.addAssets(authStub.admin, 'link-1', { assetIds: ['asset-1'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should add assets to a shared link', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from()
        .asset(asset, (builder) => builder.exif())
        .build();
      const newAsset = AssetFactory.create();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([newAsset.id]));

      await expect(
        sut.addAssets(authStub.admin, sharedLink.id, { assetIds: [asset.id, 'asset-2', newAsset.id] }),
      ).resolves.toEqual([
        { assetId: asset.id, success: false, error: AssetIdErrorReason.DUPLICATE },
        { assetId: 'asset-2', success: false, error: AssetIdErrorReason.NO_PERMISSION },
        { assetId: newAsset.id, success: true },
      ]);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledTimes(1);
      expect(mocks.sharedLink.update).toHaveBeenCalled();
      expect(mocks.sharedLink.update).toHaveBeenCalledWith({
        ...getForSharedLink(sharedLink),
        slug: null,
        assetIds: [newAsset.id],
      });
    });
  });

  describe('removeAssets', () => {
    it('should not work on album shared links', async () => {
      const sharedLink = SharedLinkFactory.from().album().build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));

      await expect(sut.removeAssets(authStub.admin, sharedLink.id, { assetIds: ['asset-1'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should remove assets from a shared link', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from()
        .asset(asset, (builder) => builder.exif())
        .build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLinkAsset.remove.mockResolvedValue([asset.id]);

      await expect(
        sut.removeAssets(authStub.admin, sharedLink.id, { assetIds: [asset.id, 'asset-2'] }),
      ).resolves.toEqual([
        { assetId: asset.id, success: true },
        { assetId: 'asset-2', success: false, error: AssetIdErrorReason.NOT_FOUND },
      ]);

      expect(mocks.sharedLinkAsset.remove).toHaveBeenCalledWith(sharedLink.id, [asset.id]);
      expect(mocks.sharedLink.update).not.toHaveBeenCalled();
    });
  });

  describe('getMetadataTags', () => {
    it('should return null when auth is not a shared link', async () => {
      await expect(sut.getMetadataTags(authStub.admin)).resolves.toBe(null);

      expect(mocks.sharedLink.get).not.toHaveBeenCalled();
    });

    it('should return null when shared link has a password', async () => {
      const auth = factory.auth({ user: {}, sharedLink: { password: 'password' } });

      await expect(sut.getMetadataTags(auth)).resolves.toBe(null);

      expect(mocks.sharedLink.get).not.toHaveBeenCalled();
    });

    it('should return metadata tags', async () => {
      const sharedLink = SharedLinkFactory.from({ description: null })
        .asset({}, (builder) => builder.exif())
        .build();
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));

      await expect(sut.getMetadataTags(authStub.adminSharedLink, 'https://photos.example.com')).resolves.toEqual({
        description: '1 shared photos & videos',
        imageUrl: `https://photos.example.com/api/assets/${sharedLink.assets[0].id}/thumbnail?key=${sharedLink.key.toString('base64url')}`,
        title: 'Public Share',
      });

      expect(mocks.sharedLink.get).toHaveBeenCalled();
    });

    it('should return metadata tags with a default image path if the asset id is not set', async () => {
      mocks.sharedLink.get.mockResolvedValue({ ...sharedLinkStub.individual, album: null, assets: [] });
      await expect(sut.getMetadataTags(authStub.adminSharedLink, 'https://photos.example.com')).resolves.toEqual({
        description: '0 shared photos & videos',
        imageUrl: `https://photos.example.com/feature-panel.png`,
        title: 'Public Share',
      });

      expect(mocks.sharedLink.get).toHaveBeenCalled();
    });

    it('should leave the image out when the server has no address to give it (FL-190)', async () => {
      mocks.sharedLink.get.mockResolvedValue({ ...sharedLinkStub.individual, album: null, assets: [] });
      await expect(sut.getMetadataTags(authStub.adminSharedLink)).resolves.toEqual({
        description: '0 shared photos & videos',
        imageUrl: undefined,
        title: 'Public Share',
      });
    });
  });

  describe('Locked media (FL-32)', () => {
    const elevatedAdmin = authStub.adminWithElevatedPermission;

    it('refuses an individual link over Locked media even for an elevated session', async () => {
      const locked = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([locked.id]));
      mocks.asset.getLockedAssetIds.mockResolvedValue(new Set([locked.id]));

      await expect(
        sut.create(elevatedAdmin, { type: SharedLinkType.Individual, assetIds: [locked.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        elevatedAdmin.user.id,
        new Set([locked.id]),
        true,
      );
      expect(mocks.asset.getLockedAssetIds).toHaveBeenCalledWith([locked.id]);
      expect(mocks.sharedLink.create).not.toHaveBeenCalled();
    });

    it('creates an individual link for an elevated session when nothing is Locked', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from()
        .asset(asset, (builder) => builder.exif())
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getLockedAssetIds.mockResolvedValue(new Set());
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.create(elevatedAdmin, { type: SharedLinkType.Individual, assetIds: [asset.id] });

      expect(mocks.sharedLink.create).toHaveBeenCalled();
    });

    it('does not look Locked media up for an ordinary session, which the access check already refuses', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from()
        .asset(asset, (builder) => builder.exif())
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.create(authStub.admin, { type: SharedLinkType.Individual, assetIds: [asset.id] });

      expect(mocks.asset.getLockedAssetIds).not.toHaveBeenCalled();
    });

    it('marks Locked media as not permitted when an elevated session adds it to a link', async () => {
      const asset = AssetFactory.create();
      const sharedLink = SharedLinkFactory.from()
        .asset(asset, (builder) => builder.exif())
        .build();
      const [locked, plain] = [AssetFactory.create(), AssetFactory.create()];
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([locked.id, plain.id]));
      mocks.asset.getLockedAssetIds.mockResolvedValue(new Set([locked.id]));

      await expect(sut.addAssets(elevatedAdmin, sharedLink.id, { assetIds: [locked.id, plain.id] })).resolves.toEqual([
        { assetId: locked.id, success: false, error: AssetIdErrorReason.NO_PERMISSION },
        { assetId: plain.id, success: true },
      ]);

      expect(mocks.sharedLink.update).toHaveBeenCalledWith({
        ...getForSharedLink(sharedLink),
        slug: null,
        assetIds: [plain.id],
      });
    });
  });

  describe('passwords (FL-161)', () => {
    const hash = `$2b$10$${'a'.repeat(53)}`;
    // the crypto mock's keyed hash: `${purpose}:${value} (keyed)`
    const tokenFor = (id: string, stored: string) => `shared-link-unlock:${id}-${stored} (keyed)`;

    it('unlocks a link by its bcrypt hash and derives the token from the hash', async () => {
      const sharedLink = SharedLinkFactory.create({ password: hash });
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.crypto.compareBcrypt.mockReturnValue(true);

      const result = await sut.login(authStub.adminSharedLink, { password: 'secret' });

      expect(mocks.crypto.compareBcrypt).toHaveBeenCalledWith('secret', hash);
      expect(result.token).toBe(tokenFor(sharedLink.id, hash));
      // keyed with the server's own key, kept outside the database
      expect(mocks.crypto.serverKeyedHash).toHaveBeenCalledWith(
        expect.any(String),
        'shared-link-unlock',
        `${sharedLink.id}-${hash}`,
      );
      expect(mocks.crypto.hashSha256).not.toHaveBeenCalled();
      expect(result.sharedLink.password).toBe(SHARED_LINK_PASSWORD_MASK);
      expect(JSON.stringify(result.sharedLink)).not.toContain(hash);
      expect(mocks.sharedLink.replaceLegacyPassword).not.toHaveBeenCalled();
    });

    it('refuses a wrong password', async () => {
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(SharedLinkFactory.create({ password: hash })));
      mocks.crypto.compareBcrypt.mockReturnValue(false);

      await expect(sut.login(authStub.adminSharedLink, { password: 'wrong' })).rejects.toThrow('Invalid password');
    });

    it('opens a link whose password is still plaintext, and hashes it on that first correct use', async () => {
      const sharedLink = SharedLinkFactory.create({ password: 'secret' });
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.replaceLegacyPassword.mockResolvedValue(true);

      const result = await sut.login(authStub.adminSharedLink, { password: 'secret' });

      expect(mocks.crypto.compareBcrypt).not.toHaveBeenCalled();
      expect(mocks.crypto.hashBcrypt).toHaveBeenCalledWith('secret', 10);
      // conditional: only a row that still holds exactly this plaintext is changed
      expect(mocks.sharedLink.replaceLegacyPassword).toHaveBeenCalledWith(sharedLink.id, 'secret', 'secret (hashed)');
      expect(mocks.sharedLink.update).not.toHaveBeenCalled();
      expect(result.token).toBe(tokenFor(sharedLink.id, 'secret (hashed)'));
    });

    it('uses the hash a concurrent first unlock stored, and refuses a password changed meanwhile', async () => {
      const legacy = getForSharedLink(SharedLinkFactory.create({ password: 'secret' }));
      mocks.sharedLink.replaceLegacyPassword.mockResolvedValue(false);

      mocks.sharedLink.get.mockResolvedValueOnce(legacy).mockResolvedValueOnce({ ...legacy, password: hash });
      mocks.crypto.compareBcrypt.mockReturnValueOnce(true);
      const result = await sut.login(authStub.adminSharedLink, { password: 'secret' });
      expect(mocks.crypto.compareBcrypt).toHaveBeenCalledWith('secret', hash);
      expect(result.token).toBe(tokenFor(legacy.id, hash));

      mocks.sharedLink.get.mockResolvedValueOnce(legacy).mockResolvedValueOnce({ ...legacy, password: hash });
      mocks.crypto.compareBcrypt.mockReturnValueOnce(false);
      await expect(sut.login(authStub.adminSharedLink, { password: 'secret' })).rejects.toThrow('Invalid password');
    });

    it('refuses a wrong plaintext password without touching the link', async () => {
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(SharedLinkFactory.create({ password: 'secret' })));

      await expect(sut.login(authStub.adminSharedLink, { password: 'secreT' })).rejects.toThrow('Invalid password');
      await expect(sut.login(authStub.adminSharedLink, { password: 'secret-and-more' })).rejects.toThrow(
        'Invalid password',
      );
      expect(mocks.sharedLink.replaceLegacyPassword).not.toHaveBeenCalled();
      expect(mocks.crypto.hashBcrypt).not.toHaveBeenCalled();
    });

    it('accepts only the token of the current password', async () => {
      const sharedLink = SharedLinkFactory.create({ password: hash });
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));

      await expect(
        sut.getMine(authStub.adminSharedLink, ['other', tokenFor(sharedLink.id, hash)]),
      ).resolves.toBeDefined();
      await expect(sut.getMine(authStub.adminSharedLink, [tokenFor(sharedLink.id, 'secret')])).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(sut.getMine(authStub.adminSharedLink, [''])).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('stores a new link’s password as a hash, and an empty one as none', async () => {
      const album = AlbumFactory.from().asset().build();
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([album.id]));
      mocks.sharedLink.create.mockResolvedValue(getForSharedLink(SharedLinkFactory.from().album(album).build()));

      await sut.create(authStub.admin, { type: SharedLinkType.Album, albumId: album.id, password: 'secret' });
      expect(mocks.sharedLink.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ password: 'secret (hashed)' }),
      );

      await sut.create(authStub.admin, { type: SharedLinkType.Album, albumId: album.id, password: '' });
      expect(mocks.sharedLink.create).toHaveBeenLastCalledWith(expect.objectContaining({ password: null }));
    });

    it('hashes a changed password, keeps it for the mask and removes it for null', async () => {
      const sharedLink = SharedLinkFactory.create({ password: hash });
      mocks.sharedLink.get.mockResolvedValue(getForSharedLink(sharedLink));
      mocks.sharedLink.update.mockResolvedValue(getForSharedLink(sharedLink));

      await sut.update(authStub.user1, sharedLink.id, { password: 'new-secret' });
      expect(mocks.sharedLink.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ password: 'new-secret (hashed)' }),
      );

      await sut.update(authStub.user1, sharedLink.id, { password: SHARED_LINK_PASSWORD_MASK, description: 'x' });
      expect(mocks.sharedLink.update.mock.lastCall?.[0].password).toBeUndefined();

      await sut.update(authStub.user1, sharedLink.id, { password: null });
      expect(mocks.sharedLink.update).toHaveBeenLastCalledWith(expect.objectContaining({ password: null }));
    });

    it('never returns the stored password', () => {
      const withPassword = mapSharedLink(getForSharedLink(SharedLinkFactory.create({ password: hash })), {
        stripAssetMetadata: false,
      });
      const without = mapSharedLink(getForSharedLink(SharedLinkFactory.create({ password: null })), {
        stripAssetMetadata: false,
      });

      expect(withPassword.password).toBe(SHARED_LINK_PASSWORD_MASK);
      expect(without.password).toBeNull();
    });
  });
});
