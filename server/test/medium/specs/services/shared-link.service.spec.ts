import { UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetLockReason, AssetVisibility, Permission, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { DB } from 'src/schema/index.js';
import { SharedLinkService } from 'src/services/shared-link.service.js';
import { checkAccess, requireUploadAccess } from 'src/utils/access.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(SharedLinkService, {
    database: db || defaultDatabase,
    real: [AccessRepository, DatabaseRepository, SharedLinkRepository, SharedLinkAssetRepository],
    mock: [LoggingRepository, StorageRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SharedLinkService.name, () => {
  describe('get', () => {
    it('should return the correct dates on the shared link album', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const dates = ['2021-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'];

      for (const date of dates) {
        const { asset } = await ctx.newAsset({ fileCreatedAt: date, localDateTime: date, ownerId: user.id });
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
        await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      }

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: true,
        type: SharedLinkType.Album,
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({
        album: expect.objectContaining({
          startDate: '2020-01-01T00:00:00+00:00',
          endDate: '2022-01-01T00:00:00+00:00',
        }),
      });
    });
  });

  it('should share individually assets', async () => {
    const { sut, ctx } = setup();

    const { user } = await ctx.newUser();

    const assets = await Promise.all([
      ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2020-01-01T00:00:00.000Z' }),
      ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2020-01-02T00:00:00.000Z' }),
      ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2020-01-03T00:00:00.000Z' }),
    ]);

    for (const { asset } of assets) {
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    }

    const sharedLinkRepo = ctx.get(SharedLinkRepository);

    const sharedLink = await sharedLinkRepo.create({
      key: randomBytes(16),
      id: factory.uuid(),
      userId: user.id,
      allowUpload: false,
      type: SharedLinkType.Individual,
      assetIds: assets.map(({ asset }) => asset.id),
    });

    await expect(sut.getMine({ user, sharedLink }, [])).resolves.toMatchObject({
      assets: assets.map(({ asset }) => expect.objectContaining({ id: asset.id })),
    });
  });

  describe('getAll', () => {
    it('should return all shared links even when they share the same createdAt', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sameTimestamp = '2024-01-01T00:00:00.000Z';

      const link1 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: sameTimestamp,
      });

      const link2 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: sameTimestamp,
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.id);
      expect(ids).toContain(link1.id);
      expect(ids).toContain(link2.id);
    });

    it('should return shared links sorted by createdAt in descending order', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const link1 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: '2021-01-01T00:00:00.000Z',
      });

      const link2 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: '2023-01-01T00:00:00.000Z',
      });

      const link3 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        createdAt: '2022-01-01T00:00:00.000Z',
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(3);
      expect(result.map((r) => r.id)).toEqual([link2.id, link3.id, link1.id]);
    });

    it('should not return shared links belonging to other users', async () => {
      const { sut, ctx } = setup();

      const { user: userA } = await ctx.newUser();
      const { user: userB } = await ctx.newUser();
      const authA = factory.auth({ user: userA });
      const authB = factory.auth({ user: userB });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const linkA = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: userA.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
      });

      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: userB.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
      });

      const resultA = await sut.getAll(authA, {});
      expect(resultA).toHaveLength(1);
      expect(resultA[0].id).toBe(linkA.id);

      const resultB = await sut.getAll(authB, {});
      expect(resultB).toHaveLength(1);
      expect(resultB[0].id).not.toBe(linkA.id);
    });

    it('should filter by albumId', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { album: album1 } = await ctx.newAlbum({ ownerId: user.id });
      const { album: album2 } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const link1 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album1.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album2.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const result = await sut.getAll(auth, { albumId: album1.id });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(link1.id);
    });

    it('should return album shared links with album data', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(1);
      expect(result[0].album).toBeDefined();
      expect(result[0].album!.id).toBe(album.id);
    });

    it('should return multiple album shared links without sql error from json group by', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { album: album1 } = await ctx.newAlbum({ ownerId: user.id });
      const { album: album2 } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const link1 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album1.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const link2 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album2.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.id);
      expect(ids).toContain(link1.id);
      expect(ids).toContain(link2.id);
      expect(result[0].album).toBeDefined();
      expect(result[1].album).toBeDefined();
    });

    it('should return mixed album and individual shared links together', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const albumLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const albumLink2 = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      const individualLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(3);
      const ids = result.map((r) => r.id);
      expect(ids).toContain(albumLink.id);
      expect(ids).toContain(albumLink2.id);
      expect(ids).toContain(individualLink.id);
    });

    it('should return only the first asset as cover for an individual shared link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const assets = await Promise.all([
        ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2021-01-01T00:00:00.000Z' }),
        ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2023-01-01T00:00:00.000Z' }),
        ctx.newAsset({ ownerId: user.id, fileCreatedAt: '2022-01-01T00:00:00.000Z' }),
      ]);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: assets.map(({ asset }) => asset.id),
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(1);
      expect(result[0].assets).toHaveLength(1);
      expect(result[0].assets[0].id).toBe(assets[0].asset.id);
    });
  });

  describe('get', () => {
    it('should return an album shared link with assets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const [{ asset: asset1 }, { asset: asset2 }] = await Promise.all([
        ctx.newAsset({ ownerId: user.id }),
        ctx.newAsset({ ownerId: user.id }),
      ]);
      await Promise.all([
        ctx.newExif({ assetId: asset1.id, make: 'Canon' }),
        ctx.newExif({ assetId: asset2.id, make: 'Canon' }),
      ]);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: true,
        type: SharedLinkType.Album,
      });

      await sharedLinkRepo.addAssets(sharedLink.id, [asset1.id, asset2.id]);
      const result = await sut.get(auth, sharedLink.id);
      const assetIds = result.assets.map((asset) => asset.id);

      expect(result).toMatchObject({
        id: sharedLink.id,
        album: expect.objectContaining({ id: album.id }),
      });
      expect(assetIds).toHaveLength(2);
      expect(assetIds).toEqual(expect.arrayContaining([asset1.id, asset2.id]));
    });

    it('tells a public viewer only the link owner display name (FL-83)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser({ name: 'Riley Owner', email: 'riley.private@example.com' });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const sharedLink = await ctx.get(SharedLinkRepository).create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
      });

      const auth = factory.auth({ user, sharedLink: { id: sharedLink.id, userId: user.id } });
      const result = await sut.getMine(auth, []);

      expect(result.owner).toEqual({ name: 'Riley Owner' });
      expect(JSON.stringify(result)).not.toContain('riley.private@example.com');
    });

    it('should not return trashed assets for an individual shared link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { asset: visibleAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: visibleAsset.id, make: 'Canon' });

      const { asset: trashedAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: trashedAsset.id, make: 'Canon' });
      await ctx.softDeleteAsset(trashedAsset.id);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [visibleAsset.id, trashedAsset.id],
      });

      const result = await sut.get(auth, sharedLink.id);
      expect(result).toBeDefined();
      expect(result!.assets).toHaveLength(1);
      expect(result!.assets[0].id).toBe(visibleAsset.id);
    });

    it('should return empty assets when all individually shared assets are trashed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.softDeleteAsset(asset.id);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({
        assets: [],
      });
    });

    it('should not return trashed assets in a shared album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const { asset: visibleAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: visibleAsset.id, make: 'Canon' });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: visibleAsset.id });

      const { asset: trashedAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: trashedAsset.id, make: 'Canon' });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: trashedAsset.id });
      await ctx.softDeleteAsset(trashedAsset.id);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: true,
        type: SharedLinkType.Album,
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({
        album: expect.objectContaining({ assetCount: 1 }),
      });
    });

    it('should return an empty asset count when all album assets are trashed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      await ctx.softDeleteAsset(asset.id);

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({
        album: expect.objectContaining({ assetCount: 0 }),
      });
    });

    it('should not return an album shared link when the album is trashed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      await ctx.softDeleteAlbum(album.id);

      await expect(sut.get(auth, sharedLink.id)).rejects.toThrow('Shared link not found');
    });
  });

  describe('getAll', () => {
    it('should not return trashed assets as cover for an individual shared link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const { asset: trashedAsset } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: '2020-01-01T00:00:00.000Z',
      });
      await ctx.softDeleteAsset(trashedAsset.id);

      const { asset: visibleAsset } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: '2021-01-01T00:00:00.000Z',
      });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [trashedAsset.id, visibleAsset.id],
      });

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(1);
      expect(result[0].assets).toHaveLength(1);
      expect(result[0].assets[0].id).toBe(visibleAsset.id);
    });

    it('should not return an album shared link when the album is trashed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLinkRepo = ctx.get(SharedLinkRepository);
      await sharedLinkRepo.create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: false,
        type: SharedLinkType.Album,
      });

      await ctx.softDeleteAlbum(album.id);

      const result = await sut.getAll(auth, {});
      expect(result).toHaveLength(0);
    });
  });

  it('should remove individually shared asset', async () => {
    const { sut, ctx } = setup();

    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });

    const sharedLinkRepo = ctx.get(SharedLinkRepository);

    const sharedLink = await sharedLinkRepo.create({
      key: randomBytes(16),
      id: factory.uuid(),
      userId: user.id,
      allowUpload: false,
      type: SharedLinkType.Individual,
      assetIds: [asset.id],
    });

    await expect(sut.getMine({ user, sharedLink }, [])).resolves.toMatchObject({
      assets: [expect.objectContaining({ id: asset.id })],
    });

    await sut.removeAssets(auth, sharedLink.id, {
      assetIds: [asset.id],
    });

    await expect(sut.getMine({ user, sharedLink }, [])).resolves.toHaveProperty('assets', []);
  });

  describe('Locked media (FL-32)', () => {
    it('never lists or reaches an album’s Locked members through its shared link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      for (const asset of [plain, locked]) {
        await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      }
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [plain.id, locked.id]);

      const sharedLink = await ctx.get(SharedLinkRepository).create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        albumId: album.id,
        allowUpload: true,
        type: SharedLinkType.Album,
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({ album: { id: album.id } });
      const stored = await ctx.get(SharedLinkRepository).get(user.id, sharedLink.id);
      expect(stored?.album?.assets.map(({ id }) => id)).toEqual([plain.id]);

      const access = ctx.get(AccessRepository);
      await expect(access.asset.checkSharedLinkAccess(sharedLink.id, new Set([plain.id, locked.id]))).resolves.toEqual(
        new Set([plain.id]),
      );
    });

    it('drops an individually linked asset from the link once it moves into the Locked folder', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });

      const sharedLink = await ctx.get(SharedLinkRepository).create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: true,
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
      });

      await expect(sut.get(auth, sharedLink.id)).resolves.toMatchObject({
        assets: [expect.objectContaining({ id: asset.id })],
      });

      await ctx.database
        .insertInto('asset_lock')
        .values({ assetId: asset.id, reason: AssetLockReason.Marked, lockedBy: null })
        .execute();

      await expect(sut.get(auth, sharedLink.id)).resolves.toHaveProperty('assets', []);
      await expect(
        ctx.get(AccessRepository).asset.checkSharedLinkAccess(sharedLink.id, new Set([asset.id])),
      ).resolves.toEqual(new Set());
    });

    it("never hands back a partner's item that moved into their Locked folder when the link is edited", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
      const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
      const { asset: mine } = await ctx.newAsset({ ownerId: user.id });
      const { asset: theirs } = await ctx.newAsset({ ownerId: partner.id });
      for (const { id } of [mine, theirs]) {
        await ctx.newExif({ assetId: id, make: 'Canon' });
      }

      const sharedLink = await ctx.get(SharedLinkRepository).create({
        key: randomBytes(16),
        id: factory.uuid(),
        userId: user.id,
        allowUpload: false,
        type: SharedLinkType.Individual,
        assetIds: [mine.id, theirs.id],
      });

      await ctx.database
        .insertInto('asset_lock')
        .values({ assetId: theirs.id, reason: AssetLockReason.Marked, lockedBy: null })
        .execute();

      const updated = await sut.update(auth, sharedLink.id, { description: 'Lake day' });
      expect(updated?.assets.map(({ id }) => id)).toEqual([mine.id]);
    });
  });
});

// FL-56: what a link allows is decided by the server's access checks against the real database.
describe('shared link permissions (FL-56)', () => {
  const linkAuth = async (
    allow: { allowDownload: boolean; allowUpload: boolean },
    sharedAssets: 'album' | 'none' = 'album',
  ) => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const { album: otherAlbum } = await ctx.newAlbum({ ownerId: user.id });
    const { asset: shared } = await ctx.newAsset({ ownerId: user.id });
    const { asset: outside } = await ctx.newAsset({ ownerId: user.id });
    if (sharedAssets === 'album') {
      await ctx.newAlbumAsset({ albumId: album.id, assetId: shared.id });
    }
    await ctx.newAlbumAsset({ albumId: otherAlbum.id, assetId: outside.id });
    const link = await ctx.get(SharedLinkRepository).create({
      key: randomBytes(16),
      id: factory.uuid(),
      userId: user.id,
      albumId: album.id,
      type: SharedLinkType.Album,
      ...allow,
    });
    const auth = { ...factory.auth({ user }), sharedLink: link } as unknown as AuthDto;
    return { access: ctx.get(AccessRepository), auth, album, otherAlbum, shared, outside };
  };

  it('refuses originals and archives when the link does not allow download', async () => {
    const { access, auth, album, shared } = await linkAuth({ allowDownload: false, allowUpload: false });

    await expect(
      checkAccess(access, { auth, permission: Permission.AssetDownload, ids: [shared.id] }),
    ).resolves.toEqual(new Set());
    await expect(checkAccess(access, { auth, permission: Permission.AlbumDownload, ids: [album.id] })).resolves.toEqual(
      new Set(),
    );
    // Viewing is still allowed.
    await expect(checkAccess(access, { auth, permission: Permission.AssetView, ids: [shared.id] })).resolves.toEqual(
      new Set([shared.id]),
    );
  });

  it('lets a link that allows download take only what it shares', async () => {
    const { access, auth, album, otherAlbum, shared, outside } = await linkAuth({
      allowDownload: true,
      allowUpload: false,
    });

    await expect(
      checkAccess(access, { auth, permission: Permission.AssetDownload, ids: [shared.id, outside.id] }),
    ).resolves.toEqual(new Set([shared.id]));
    await expect(
      checkAccess(access, { auth, permission: Permission.AlbumDownload, ids: [album.id, otherAlbum.id] }),
    ).resolves.toEqual(new Set([album.id]));
  });

  it('refuses uploads when the link does not allow them', async () => {
    const { access, auth, album } = await linkAuth({ allowDownload: true, allowUpload: false });

    expect(() => requireUploadAccess(auth)).toThrow(UnauthorizedException);
    await expect(
      checkAccess(access, { auth, permission: Permission.AssetUpload, ids: [auth.user.id] }),
    ).resolves.toEqual(new Set());
    await expect(
      checkAccess(access, { auth, permission: Permission.AlbumAssetCreate, ids: [album.id] }),
    ).resolves.toEqual(new Set());
  });

  it('allows uploads into the link album only', async () => {
    const { access, auth, album, otherAlbum, outside } = await linkAuth({ allowDownload: false, allowUpload: true });

    expect(requireUploadAccess(auth)).toBe(auth);
    await expect(
      checkAccess(access, { auth, permission: Permission.AlbumAssetCreate, ids: [album.id, otherAlbum.id] }),
    ).resolves.toEqual(new Set([album.id]));
    await expect(checkAccess(access, { auth, permission: Permission.AssetRead, ids: [outside.id] })).resolves.toEqual(
      new Set(),
    );
  });
});
