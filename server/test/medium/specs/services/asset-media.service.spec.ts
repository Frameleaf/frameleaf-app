import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AssetMediaController } from 'src/controllers/asset-media.controller.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetMediaSize } from 'src/dtos/asset-media.dto.js';
import { AssetFileType, AssetLockReason, CacheControl, Permission, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetRestorationService } from 'src/services/asset-restoration.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(AssetMediaService, {
    database: db || defaultDatabase,
    real: [
      ConfigRepository,
      SystemMetadataRepository,
      PhysicalFileRepository,
      AssetChecksumRepository,
      AccessRepository,
      AlbumRepository,
      AssetRepository,
      SharedLinkRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, MetadataRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetService.name, () => {
  describe('uploadAsset', () => {
    it('should work', async () => {
      const { sut, ctx } = setup();

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const fileSizeInByte = 12_345;

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte });
      const auth = factory.auth({ user: { id: user.id } });

      await expect(
        sut.uploadAsset(
          auth,
          {
            fileModifiedAt: new Date(),
            fileCreatedAt: new Date(),
            assetData: Buffer.from('some data'),
          },
          mediumFactory.uploadFile({ size: fileSizeInByte }),
        ),
      ).resolves.toEqual({
        id: expect.any(String),
        status: AssetMediaStatus.CREATED,
      });

      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AssetCreate', {
        asset: expect.objectContaining({}),
        file: expect.objectContaining({ size: fileSizeInByte }),
      });
    });

    it('should work with an empty metadata list', async () => {
      const { sut, ctx } = setup();

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 12_345 });
      const auth = factory.auth({ user: { id: user.id } });
      const file = mediumFactory.uploadFile();

      await expect(
        sut.uploadAsset(
          auth,
          {
            fileModifiedAt: new Date(),
            fileCreatedAt: new Date(),
            assetData: Buffer.from('some data'),
            metadata: [],
          },
          file,
        ),
      ).resolves.toEqual({
        id: expect.any(String),
        status: AssetMediaStatus.CREATED,
      });
    });

    it('should add to a shared link', async () => {
      const { sut, ctx } = setup();

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(50),
        type: SharedLinkType.Individual,
        description: 'Shared link description',
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const file = mediumFactory.uploadFile();
      const uploadDto = {
        fileModifiedAt: new Date(),
        fileCreatedAt: new Date(),
        assetData: Buffer.from('some data'),
      };

      const response = await sut.uploadAsset(auth, uploadDto, file);
      expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.CREATED });

      const update = await sharedLinkRepo.get(user.id, sharedLink.id);
      const assets = update!.assets;
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({ id: response.id });
    });

    it('should handle adding a duplicate asset to a shared link', async () => {
      const { sut, ctx } = setup();

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 12_345 });

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(50),
        type: SharedLinkType.Individual,
        description: 'Shared link description',
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
        assetIds: [asset.id],
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const uploadDto = {
        fileModifiedAt: new Date(),
        fileCreatedAt: new Date(),
        assetData: Buffer.from('some data'),
      };

      const response = await sut.uploadAsset(auth, uploadDto, mediumFactory.uploadFile({ checksum: asset.checksum }));
      expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.DUPLICATE });

      const update = await sharedLinkRepo.get(user.id, sharedLink.id);
      const assets = update!.assets;
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({ id: response.id });
    });

    it('should add to an album shared link', async () => {
      const { sut, ctx } = setup();

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(50),
        type: SharedLinkType.Album,
        albumId: album.id,
        description: 'Shared link description',
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const uploadDto = {
        fileModifiedAt: new Date(),
        fileCreatedAt: new Date(),
        assetData: Buffer.from('some data'),
      };

      const response = await sut.uploadAsset(auth, uploadDto, mediumFactory.uploadFile());
      expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.CREATED });

      const result = await ctx.get(AlbumRepository).getAssetIds(album.id, [response.id]);
      const assets = [...result];
      expect(assets).toHaveLength(1);
      expect(assets[0]).toEqual(response.id);

      expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AlbumUpdate', {
        id: album.id,
        userIds: [user.id],
        recipientIds: [user.id],
      });
    });

    it('should handle adding a duplicate asset to an album shared link', async () => {
      const { sut, ctx } = setup();

      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      ctx.getMock(StorageRepository).utimes.mockResolvedValue();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      // await ctx.newExif({ assetId: asset.id, fileSizeInByte: 12_345 });

      const sharedLink = await sharedLinkRepo.create({
        key: randomBytes(50),
        type: SharedLinkType.Album,
        albumId: album.id,
        description: 'Shared link description',
        userId: user.id,
        allowDownload: true,
        allowUpload: true,
      });

      const auth = factory.auth({ user: { id: user.id }, sharedLink });
      const uploadDto = {
        fileModifiedAt: new Date(),
        fileCreatedAt: new Date(),
        assetData: Buffer.from('some data'),
      };

      const response = await sut.uploadAsset(auth, uploadDto, mediumFactory.uploadFile({ checksum: asset.checksum }));
      expect(response).toEqual({ id: expect.any(String), status: AssetMediaStatus.DUPLICATE });

      const result = await ctx.get(AlbumRepository).getAssetIds(album.id, [response.id]);
      const assets = [...result];
      expect(assets).toHaveLength(1);
      expect(assets[0]).toEqual(response.id);
    });
  });

  describe('viewThumbnail', () => {
    it.each([AssetMediaSize.PREVIEW, AssetMediaSize.FULLSIZE])(
      'enforces authenticated ownership, locks and revoked links for HDR and SDR %s',
      async (size) => {
        vi.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
        const directory = await mkdtemp(join(tmpdir(), 'frameleaf-hdr-http-'));
        let http: Awaited<ReturnType<typeof controllerSetup>> | undefined;
        try {
          const { sut, ctx } = setup();
          const { user } = await ctx.newUser();
          const { user: outsider } = await ctx.newUser({ isAdmin: true });
          const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'private-camera-name.HEIC' });
          await ctx.newExif({
            assetId: asset.id,
            imageEncoding: { dynamicRange: 'hdr', gainMap: 'iso-21496', reconstructionAvailable: true },
          });
          const sdrType = size === AssetMediaSize.PREVIEW ? AssetFileType.Preview : AssetFileType.FullSize;
          const hdrType = size === AssetMediaSize.PREVIEW ? AssetFileType.HdrPreview : AssetFileType.HdrFullSize;
          for (const type of [sdrType, hdrType]) {
            // Opaque derivative bytes test HTTP transport, not HDR codec correctness.
            await writeFile(join(directory, `${type}.jpg`), Buffer.from(`derivative-${type}`));
            await ctx.newAssetFile({
              assetId: asset.id,
              type,
              path: join(directory, `${type}.jpg`),
              renditionIdentity: 'a'.repeat(64),
            });
          }
          const token = randomBytes(32).toString('hex');
          const { session } = await ctx.newSession({
            userId: user.id,
            token: ctx.get(CryptoRepository).hashSha256(token),
            updatedAt: new Date(),
          });
          const { sut: authentication } = newMediumService(AuthService, {
            database: ctx.database,
            real: [
              ConfigRepository,
              CryptoRepository,
              SessionRepository,
              SharedLinkRepository,
              SystemMetadataRepository,
              UserRepository,
            ],
            mock: [LoggingRepository],
          });
          // This test exercises authentication/authorization; native codec tests verify the sanitized bytes.
          ctx
            .getMock(MetadataRepository)
            .acquireLocationFreeOriginal.mockImplementation((path) => Promise.resolve({ path, release: vi.fn() }));
          const ownerRequest = {
            headers: { authorization: `Bearer ${token}` },
            queryParams: {},
            metadata: {
              adminRoute: false,
              sharedLinkRoute: true,
              permission: Permission.AssetView,
              uri: '/assets/:id/thumbnail',
            },
          };
          const sharedLinks = ctx.get(SharedLinkRepository);
          const key = randomBytes(50);
          const link = await sharedLinks.create({
            key,
            type: SharedLinkType.Individual,
            userId: user.id,
            assetIds: [asset.id],
            allowDownload: false,
            allowUpload: false,
            showExif: false,
          });
          const sharedRequest = { ...ownerRequest, headers: { 'x-immich-share-key': key.toString('hex') } };
          const owner = await authentication.authenticate(ownerRequest);
          const shared = await authentication.authenticate(sharedRequest);
          http = await controllerSetup(AssetMediaController, [
            { provide: LoggingRepository, useValue: ctx.getMock(LoggingRepository) },
            { provide: AssetMediaService, useValue: sut },
            { provide: AuthService, useValue: authentication },
            {
              provide: AssetRestorationService,
              useValue: { getPlaybackChoice: vi.fn().mockResolvedValue({ file: null, revalidate: false }) },
            },
          ]);
          const endpoint = `/assets/${asset.id}/thumbnail?size=${size}`;
          const outsiderToken = randomBytes(32).toString('hex');
          await ctx.newSession({
            userId: outsider.id,
            token: ctx.get(CryptoRepository).hashSha256(outsiderToken),
            updatedAt: new Date(),
          });
          const outsiderHeaders = { authorization: `Bearer ${outsiderToken}` };
          const ownerHeaders = { authorization: `Bearer ${token}` };
          const shareHeaders = { 'x-immich-share-key': key.toString('hex') };
          const other = factory.auth({
            user: { id: outsider.id, isAdmin: true },
            session: { hasElevatedPermission: true },
          });
          for (const dynamicRange of ['hdr', 'auto', 'sdr'] as const) {
            const dto = { size, dynamicRange, edited: true };
            const type = dynamicRange === 'sdr' ? sdrType : hdrType;
            for (const auth of [owner, shared]) {
              const response = await sut.viewThumbnail(auth, asset.id, { ...dto });
              expect(response).toBeInstanceOf(ImmichFileResponse);
              expect(response).toMatchObject({ path: join(directory, `${type}.jpg`), contentType: 'image/jpeg' });
              if (dynamicRange !== 'sdr')
                expect(response).toMatchObject({ cacheControl: CacheControl.PrivateWithoutCache });
              if (auth.sharedLink) expect((response as ImmichFileResponse).fileName).toBe(`${asset.id}_${type}.jpg`);
            }
            for (const headers of [ownerHeaders, shareHeaders]) {
              const response = await request(http.getHttpServer())
                .get(`${endpoint}&dynamicRange=${dynamicRange}`)
                .set(headers);
              expect(response.status).toBe(200);
              expect(response.body).toEqual(Buffer.from(`derivative-${type}`));
              expect(response.headers['content-type']).toMatch(/^image\/jpeg/);
              if (dynamicRange !== 'sdr')
                expect(response.headers['cache-control']).toBe('private, no-cache, no-transform');
              if (headers === shareHeaders)
                expect(response.headers['content-disposition']).not.toContain('private-camera-name');
            }
            expect(
              (await request(http.getHttpServer()).get(`${endpoint}&dynamicRange=${dynamicRange}`).set(outsiderHeaders))
                .status,
            ).toBe(400);
            await expect(sut.viewThumbnail(other, asset.id, { ...dto })).rejects.toThrow('access');
            await defaultDatabase
              .insertInto('asset_lock')
              .values({
                assetId: asset.id,
                reason: AssetLockReason.Marked,
                lockedBy: user.id,
                previousVisibility: null,
              })
              .execute();
            for (const headers of [ownerHeaders, shareHeaders])
              expect(
                (await request(http.getHttpServer()).get(`${endpoint}&dynamicRange=${dynamicRange}`).set(headers))
                  .status,
              ).toBe(400);
            await expect(sut.viewThumbnail(owner, asset.id, { ...dto })).rejects.toThrow('access');
            await expect(sut.viewThumbnail(shared, asset.id, { ...dto })).rejects.toThrow('access');
            await expect(
              sut.viewThumbnail(
                factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } }),
                asset.id,
                { ...dto },
              ),
            ).resolves.toBeInstanceOf(ImmichFileResponse);
            await defaultDatabase.deleteFrom('asset_lock').where('assetId', '=', asset.id).execute();
          }
          expect(
            (await request(http.getHttpServer()).get(`/assets/${asset.id}/original`).set(shareHeaders)).status,
          ).toBe(400);
          await expect(sut.downloadOriginal(shared, asset.id, {})).rejects.toThrow('access');
          // Removal must invalidate even an already-authenticated link's database entitlement.
          await sharedLinks.remove(link.id);
          expect(
            (await request(http.getHttpServer()).get(`${endpoint}&dynamicRange=hdr`).set(shareHeaders)).status,
          ).toBe(401);
          await expect(authentication.authenticate(sharedRequest)).rejects.toThrow('Invalid share key');
          await expect(sut.viewThumbnail(shared, asset.id, { size, dynamicRange: 'hdr' })).rejects.toThrow('access');
          await ctx.get(SessionRepository).delete(session.id);
          expect(
            (await request(http.getHttpServer()).get(`${endpoint}&dynamicRange=hdr`).set(ownerHeaders)).status,
          ).toBe(401);
          await expect(authentication.authenticate(ownerRequest)).rejects.toThrow('Invalid user token');
        } finally {
          await http?.close();
          await rm(directory, { recursive: true, force: true });
          vi.unstubAllEnvs();
        }
      },
    );

    it('should return original thumbnail by default when both exist', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create both original and edited thumbnails
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/edited/preview.jpg',
        isEdited: true,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/original/preview.jpg');
    });

    it('should return edited thumbnail when edited=true', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create both original and edited thumbnails
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/edited/preview.jpg',
        isEdited: true,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW, edited: true });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/edited/preview.jpg');
    });

    it('should return original thumbnail when edited=false', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create both original and edited thumbnails
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/edited/preview.jpg',
        isEdited: true,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW, edited: false });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/original/preview.jpg');
    });

    it('should return original thumbnail when only original exists and edited=false', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create only original thumbnail
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW, edited: false });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/original/preview.jpg');
    });

    it('should return original thumbnail when only original exists and edited=true', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create only original thumbnail
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: '/original/preview.jpg',
        isEdited: false,
      });

      const auth = factory.auth({ user: { id: user.id } });
      const result = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW, edited: true });

      expect(result).toBeInstanceOf(ImmichFileResponse);
      expect((result as ImmichFileResponse).path).toBe('/original/preview.jpg');
    });

    it('should work with thumbnail size', async () => {
      const { sut, ctx } = setup();

      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Create both original and edited thumbnails
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Thumbnail,
        path: '/original/thumbnail.jpg',
        isEdited: false,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Thumbnail,
        path: '/edited/thumbnail.jpg',
        isEdited: true,
      });

      const auth = factory.auth({ user: { id: user.id } });

      // Test default (should get original)
      const resultDefault = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.THUMBNAIL });
      expect(resultDefault).toBeInstanceOf(ImmichFileResponse);
      expect((resultDefault as ImmichFileResponse).path).toBe('/original/thumbnail.jpg');

      // Test edited=true (should get edited)
      const resultEdited = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.THUMBNAIL, edited: true });
      expect(resultEdited).toBeInstanceOf(ImmichFileResponse);
      expect((resultEdited as ImmichFileResponse).path).toBe('/edited/thumbnail.jpg');
    });
  });

  // FL-34: "administrator status never grants another owner's originals", however elevated the session
  describe('an administrator reading another account’s media', () => {
    it('is refused the original, the thumbnail and the video, even with an unlocked session', async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: admin } = await ctx.newUser({ isAdmin: true });
      const { asset } = await ctx.newAsset({ ownerId: owner.id, originalPath: '/owner/original.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: '/owner/preview.jpg' });
      const auth = factory.auth({ user: { id: admin.id, isAdmin: true }, session: { hasElevatedPermission: true } });

      await expect(sut.downloadOriginal(auth, asset.id, {})).rejects.toThrow();
      await expect(sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW })).rejects.toThrow();
      await expect(sut.playbackVideo(auth, asset.id)).rejects.toThrow();
    });
  });
});
