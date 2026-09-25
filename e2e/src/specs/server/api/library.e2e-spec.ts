import { LibraryRemovalReviewDto, LibraryResponseDto, LoginResponseDto } from '@immich/sdk';
import { cpSync, existsSync } from 'node:fs';
import { Socket } from 'socket.io-client';
import { createUserDto } from 'src/fixtures.js';
import { errorDto } from 'src/responses.js';
import { app, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';
import request from 'supertest';
import { utimes } from 'utimes';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/** FL-78: the first stage of a library removal, as an administrator sees it. */
const removalReview = async (accessToken: string, id: string) => {
  const { status, body } = await request(app)
    .get(`/libraries/${id}/removal`)
    .set('Authorization', `Bearer ${accessToken}`);
  expect(status).toBe(200);
  return body as LibraryRemovalReviewDto;
};

describe('/libraries', () => {
  let admin: LoginResponseDto;
  let nonAdmin: LoginResponseDto;
  let websocket: Socket;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    nonAdmin = await utils.userSetup(admin.accessToken, createUserDto.user1);
    await utils.resetAdminConfig(admin.accessToken);
    websocket = await utils.connectWebsocket(admin.accessToken);
    utils.createImageFile(`${testAssetDir}/temp/directoryA/assetA.png`);
  });

  afterAll(() => {
    utils.disconnectWebsocket(websocket);
    utils.resetTempFolder();
  });

  beforeEach(() => {
    utils.resetEvents();
  });

  describe('POST /libraries/:id/scan', () => {
    it('should process metadata and thumbnails for external asset', async () => {
      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        importPaths: [`${testAssetDirInternal}/temp/directoryA`],
      });

      await utils.scan(admin.accessToken, library.id);

      const { assets } = await utils.searchAssets(admin.accessToken, {
        originalPath: `${testAssetDirInternal}/temp/directoryA/assetA.png`,
        libraryId: library.id,
      });
      expect(assets.count).toBe(1);
      const asset = assets.items[0];
      expect(asset.exifInfo).not.toBe(null);
      expect(asset.exifInfo?.dateTimeOriginal).not.toBe(null);
      expect(asset.thumbhash).not.toBe(null);
    });

    it('should reimport a modified file', async () => {
      utils.createImageFile(`${testAssetDir}/temp/reimport/asset.jpg`);
      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        importPaths: [`${testAssetDirInternal}/temp/reimport`],
      });

      await utimes(`${testAssetDir}/temp/reimport/asset.jpg`, 447_775_200_000);

      await utils.scan(admin.accessToken, library.id);

      cpSync(`${testAssetDir}/albums/nature/tanners_ridge.jpg`, `${testAssetDir}/temp/reimport/asset.jpg`);
      await utimes(`${testAssetDir}/temp/reimport/asset.jpg`, 447_775_200_001);

      await utils.scan(admin.accessToken, library.id);

      const { assets } = await utils.searchAssets(admin.accessToken, {
        libraryId: library.id,
      });

      expect(assets.count).toEqual(1);

      const asset = await utils.getAssetInfo(admin.accessToken, assets.items[0].id);

      expect(asset).toEqual(
        expect.objectContaining({
          originalFileName: 'asset.jpg',
          exifInfo: expect.objectContaining({
            model: 'NIKON D750',
          }),
        }),
      );

      utils.removeImageFile(`${testAssetDir}/temp/reimport/asset.jpg`);
    });

    it('should not reimport a modified file more than once', async () => {
      utils.createImageFile(`${testAssetDir}/temp/reimport-twice/asset.jpg`);
      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        importPaths: [`${testAssetDirInternal}/temp/reimport-twice`],
      });

      await utimes(`${testAssetDir}/temp/reimport-twice/asset.jpg`, 447_775_200_000);

      await utils.scan(admin.accessToken, library.id);

      cpSync(`${testAssetDir}/albums/nature/tanners_ridge.jpg`, `${testAssetDir}/temp/reimport-twice/asset.jpg`);
      await utimes(`${testAssetDir}/temp/reimport-twice/asset.jpg`, 447_775_200_001);

      await utils.scan(admin.accessToken, library.id);

      cpSync(`${testAssetDir}/albums/nature/el_torcal_rocks.jpg`, `${testAssetDir}/temp/reimport-twice/asset.jpg`);
      await utimes(`${testAssetDir}/temp/reimport-twice/asset.jpg`, 447_775_200_001);

      await utils.scan(admin.accessToken, library.id);

      const { assets } = await utils.searchAssets(admin.accessToken, {
        libraryId: library.id,
      });

      expect(assets.count).toEqual(1);

      const asset = await utils.getAssetInfo(admin.accessToken, assets.items[0].id);

      expect(asset).toEqual(
        expect.objectContaining({
          originalFileName: 'asset.jpg',
          exifInfo: expect.objectContaining({
            model: 'NIKON D750',
          }),
        }),
      );

      utils.removeImageFile(`${testAssetDir}/temp/reimport-twice/asset.jpg`);
    });
  });

  describe('FL-78: only administrators manage external libraries', () => {
    let library: LibraryResponseDto;

    beforeAll(async () => {
      utils.createImageFile(`${testAssetDir}/temp/fl78-permissions/asset.png`);
      library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        name: 'FL-78 permissions',
        importPaths: [`${testAssetDirInternal}/temp/fl78-permissions`],
      });
    });

    it('refuses a non-admin creating a library', async () => {
      const { status } = await request(app)
        .post('/libraries')
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`)
        .send({ ownerId: nonAdmin.userId, importPaths: [`${testAssetDirInternal}/temp/fl78-permissions`] });
      expect(status).toBe(403);
    });

    it('refuses a non-admin scanning a library', async () => {
      const { status } = await request(app)
        .post(`/libraries/${library.id}/scan`)
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`);
      expect(status).toBe(403);
    });

    it('refuses a non-admin reviewing or confirming a removal, or deleting a library', async () => {
      const review = await request(app)
        .get(`/libraries/${library.id}/removal`)
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`);
      expect(review.status).toBe(403);

      const confirm = await request(app)
        .post(`/libraries/${library.id}/removal`)
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`)
        .send({ reviewToken: 'token', confirmName: library.name });
      expect(confirm.status).toBe(403);

      const legacy = await request(app)
        .delete(`/libraries/${library.id}`)
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`);
      expect(legacy.status).toBe(403);
    });
  });

  describe('FL-78: import folders are checked before a library exists', () => {
    it('refuses a folder that does not exist', async () => {
      const { status, body } = await request(app)
        .post('/libraries')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ownerId: admin.userId, importPaths: [`${testAssetDirInternal}/temp/fl78-does-not-exist`] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Invalid import path: Path does not exist (ENOENT)'));
    });

    it('refuses a relative folder', async () => {
      const { status, body } = await request(app)
        .post('/libraries')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ownerId: admin.userId, importPaths: ['relative/photos'] });
      expect(status).toBe(400);
      // the suggestion that follows depends on the server's working directory
      expect(body).toEqual(
        errorDto.badRequest(expect.stringContaining('Invalid import path: Import path must be absolute, try ')),
      );
    });

    it("refuses a folder that overlaps another library's folder", async () => {
      utils.createImageFile(`${testAssetDir}/temp/fl78-overlap/nested/asset.png`);
      await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        name: 'FL-78 overlap',
        importPaths: [`${testAssetDirInternal}/temp/fl78-overlap`],
      });

      const { status, body } = await request(app)
        .post('/libraries')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ownerId: admin.userId, importPaths: [`${testAssetDirInternal}/temp/fl78-overlap/nested`] });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.badRequest('Invalid import path: Import path overlaps an import path of library FL-78 overlap'),
      );
    });
  });

  describe('FL-78: two-stage library removal', () => {
    it('refuses a review made before the library was renamed', async () => {
      utils.createImageFile(`${testAssetDir}/temp/fl78-stale/asset.png`);
      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        name: 'FL-78 stale',
        importPaths: [`${testAssetDirInternal}/temp/fl78-stale`],
      });

      const stale = await removalReview(admin.accessToken, library.id);
      await utils.updateLibrary(admin.accessToken, library.id, { name: 'FL-78 stale renamed' });

      const { status, body } = await request(app)
        .post(`/libraries/${library.id}/removal`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reviewToken: stale.reviewToken, confirmName: 'FL-78 stale renamed' });
      expect(status).toBe(409);
      expect(body).toEqual({
        message: 'The library changed after it was reviewed. Review the removal again.',
      });
    });

    it('refuses a confirmation whose typed name does not match', async () => {
      utils.createImageFile(`${testAssetDir}/temp/fl78-typed-name/asset.png`);
      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        name: 'FL-78 typed name',
        importPaths: [`${testAssetDirInternal}/temp/fl78-typed-name`],
      });
      const { reviewToken } = await removalReview(admin.accessToken, library.id);

      const { status, body } = await request(app)
        .post(`/libraries/${library.id}/removal`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reviewToken, confirmName: 'FL-78 typed' });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Type the library name to confirm'));
    });

    it('reviews, then removes the library with the token and typed name, keeping the source files', async () => {
      const hostFile = `${testAssetDir}/temp/fl78-removal/asset.png`;
      utils.createImageFile(hostFile);
      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        name: 'FL-78 removal',
        importPaths: [`${testAssetDirInternal}/temp/fl78-removal`],
      });
      await utils.scan(admin.accessToken, library.id);

      const { reviewToken, ...consequences } = await removalReview(admin.accessToken, library.id);
      expect(reviewToken).toEqual(expect.any(String));
      expect(consequences).toMatchObject({
        libraryId: library.id,
        name: 'FL-78 removal',
        total: 1,
        originalsKept: true,
      });

      const { status } = await request(app)
        .post(`/libraries/${library.id}/removal`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ reviewToken, confirmName: 'FL-78 removal' });
      expect(status).toBe(204);

      await utils.waitForQueueFinish(admin.accessToken, 'library');
      await utils.waitForQueueFinish(admin.accessToken, 'backgroundTask');

      const { body: libraries } = await request(app)
        .get('/libraries')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect((libraries as LibraryResponseDto[]).map(({ id }) => id)).not.toContain(library.id);

      // the removal only ever forgets the indexed entries; the file stays in its folder
      expect(existsSync(hostFile)).toBe(true);
    });
  });

  describe("FL-78: a deleted owner's libraries are not scanned", () => {
    it('refuses to scan a library whose owner account is deleted', async () => {
      const owner = await utils.userSetup(admin.accessToken, createUserDto.create('fl78-owner'));
      utils.createImageFile(`${testAssetDir}/temp/fl78-owner/asset.png`);
      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: owner.userId,
        name: 'FL-78 owner',
        importPaths: [`${testAssetDirInternal}/temp/fl78-owner`],
      });

      // the soft delete: the library stays, so the refusal is about its owner, not a missing library
      const deleted = await request(app)
        .delete(`/admin/users/${owner.userId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({});
      expect(deleted.status).toBe(200);

      const { status, body } = await request(app)
        .post(`/libraries/${library.id}/scan`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('The library owner account is deleted. Restore it before scanning.'));

      // and no new library can be given to that account
      const created = await request(app)
        .post('/libraries')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ownerId: owner.userId, importPaths: [] });
      expect(created.status).toBe(400);
      expect(created.body).toEqual(errorDto.badRequest('Choose an active account to own the library'));
    });
  });
});
