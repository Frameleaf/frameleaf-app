import {
  getAssetInfo,
  LibraryRemovalReviewDto,
  LibraryResponseDto,
  LoginResponseDto,
  searchAssets,
  updateConfig,
} from '@frameleaf/sdk';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, symlinkSync } from 'node:fs';
import { Socket } from 'socket.io-client';
import { createUserDto } from 'src/fixtures.js';
import { ownedWait } from 'src/harness-context.js';
import { requestOnce } from 'src/harness-wait.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, dockerExec, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';
import request from 'supertest';
import { utimes } from 'utimes';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/** FL-78: the server's media storage inside the e2e container, which no library may reach. */
const mediaLocation = '/data';

/** FL-78: a create refused for its import folder, and the reason the server gives. */
const refusedCreate = async (accessToken: string, ownerId: string, importPaths: string[]) => {
  const { status, body } = await request(app)
    .post('/libraries')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ ownerId, importPaths });
  expect(status).toBe(400);
  return body;
};

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

  const scanLibraryAsset = async (libraryId: string, signal: AbortSignal, originalPath?: string) => {
    await utils.scan(admin.accessToken, libraryId, signal);
    const { assets } = await searchAssets(
      { metadataSearchDto: { libraryId, originalPath } },
      { headers: asBearerAuth(admin.accessToken), signal },
    );
    expect(assets.count).toBe(1);
    await utils.waitForAssetReady(admin.accessToken, assets.items[0].id, { signal });
    return getAssetInfo({ id: assets.items[0].id }, { headers: asBearerAuth(admin.accessToken), signal });
  };

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
    it('should process metadata and thumbnails for external asset', async ({ signal }) => {
      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        importPaths: [`${testAssetDirInternal}/temp/directoryA`],
      });

      const asset = await scanLibraryAsset(library.id, signal, `${testAssetDirInternal}/temp/directoryA/assetA.png`);
      expect(asset.exifInfo).not.toBe(null);
      expect(asset.exifInfo?.dateTimeOriginal).not.toBe(null);
      expect(asset.thumbhash).not.toBe(null);
    });

    // Two scans plus two readiness waits, each 60s in CI / 10s locally, and 30s for setup/assertions.
    it('should reimport a modified file', { timeout: process.env.CI ? 270_000 : 70_000 }, async ({ signal }) => {
      const fixtureFolder = `temp/reimport-${randomUUID()}`;
      const fixturePath = `${testAssetDir}/${fixtureFolder}/asset.jpg`;
      utils.createImageFile(fixturePath);
      try {
        const library = await utils.createLibrary(admin.accessToken, {
          ownerId: admin.userId,
          importPaths: [`${testAssetDirInternal}/${fixtureFolder}`],
        });

        await utimes(fixturePath, 447_775_200_000);

        await scanLibraryAsset(library.id, signal);

        cpSync(`${testAssetDir}/albums/nature/tanners_ridge.jpg`, fixturePath);
        await utimes(fixturePath, 447_775_200_001);

        const asset = await scanLibraryAsset(library.id, signal);

        expect(asset).toEqual(
          expect.objectContaining({
            originalFileName: 'asset.jpg',
            exifInfo: expect.objectContaining({
              model: 'NIKON D750',
            }),
          }),
        );
      } finally {
        utils.removeImageFile(fixturePath);
      }
    });

    it(
      'should not reimport a modified file more than once',
      { timeout: process.env.CI ? 390_000 : 90_000 },
      async ({ signal }) => {
        const fixtureFolder = `temp/reimport-twice-${randomUUID()}`;
        utils.createImageFile(`${testAssetDir}/${fixtureFolder}/asset.jpg`);
        const library = await utils.createLibrary(admin.accessToken, {
          ownerId: admin.userId,
          importPaths: [`${testAssetDirInternal}/${fixtureFolder}`],
        });

        await utimes(`${testAssetDir}/${fixtureFolder}/asset.jpg`, 447_775_200_000);

        await scanLibraryAsset(library.id, signal);

        cpSync(`${testAssetDir}/albums/nature/tanners_ridge.jpg`, `${testAssetDir}/${fixtureFolder}/asset.jpg`);
        await utimes(`${testAssetDir}/${fixtureFolder}/asset.jpg`, 447_775_200_001);

        await scanLibraryAsset(library.id, signal);

        cpSync(`${testAssetDir}/albums/nature/el_torcal_rocks.jpg`, `${testAssetDir}/${fixtureFolder}/asset.jpg`);
        await utimes(`${testAssetDir}/${fixtureFolder}/asset.jpg`, 447_775_200_001);

        const asset = await scanLibraryAsset(library.id, signal);

        expect(asset).toEqual(
          expect.objectContaining({
            originalFileName: 'asset.jpg',
            exifInfo: expect.objectContaining({
              model: 'NIKON D750',
            }),
          }),
        );

        utils.removeImageFile(`${testAssetDir}/${fixtureFolder}/asset.jpg`);
      },
    );
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

    it('refuses a folder that climbs out through a parent-directory segment', async () => {
      const body = await refusedCreate(admin.accessToken, admin.userId, [`${testAssetDirInternal}/temp/../../etc`]);
      expect(body).toEqual(
        errorDto.badRequest('Invalid import path: Import path must not use parent-directory segments'),
      );
    });

    it("refuses the server's upload folder", async () => {
      const body = await refusedCreate(admin.accessToken, admin.userId, [`${mediaLocation}/upload`]);
      expect(body).toEqual(
        errorDto.badRequest('Invalid import path: Cannot use media upload folder for external libraries'),
      );
    });

    it('refuses a folder that contains the upload folder', async () => {
      const body = await refusedCreate(admin.accessToken, admin.userId, ['/']);
      expect(body).toEqual(errorDto.badRequest('Invalid import path: Import path contains the media upload folder'));
    });

    it('refuses a symbolic link to the upload folder', async () => {
      // the link is resolved inside the server container, where the upload folder lives
      symlinkSync(`${mediaLocation}/upload`, `${testAssetDir}/temp/fl78-link-to-upload`);
      const body = await refusedCreate(admin.accessToken, admin.userId, [
        `${testAssetDirInternal}/temp/fl78-link-to-upload`,
      ]);
      expect(body).toEqual(
        errorDto.badRequest(
          `Invalid import path: Import path resolves to ${mediaLocation}/upload: Cannot use media upload folder for external libraries`,
        ),
      );
    });

    it('refuses a symbolic link to a folder that contains the upload folder', async () => {
      symlinkSync('/', `${testAssetDir}/temp/fl78-link-to-root`);
      const body = await refusedCreate(admin.accessToken, admin.userId, [
        `${testAssetDirInternal}/temp/fl78-link-to-root`,
      ]);
      expect(body).toEqual(
        errorDto.badRequest(
          'Invalid import path: Import path resolves to /: Import path contains the media upload folder',
        ),
      );
    });

    it('refuses a file where a folder belongs', async () => {
      utils.createImageFile(`${testAssetDir}/temp/fl78-a-file/asset.png`);
      const body = await refusedCreate(admin.accessToken, admin.userId, [
        `${testAssetDirInternal}/temp/fl78-a-file/asset.png`,
      ]);
      expect(body).toEqual(errorDto.badRequest('Invalid import path: Not a directory'));
    });

    it('refuses the same folder listed twice', async () => {
      utils.createImageFile(`${testAssetDir}/temp/fl78-twice/asset.png`);
      const body = await refusedCreate(admin.accessToken, admin.userId, [
        `${testAssetDirInternal}/temp/fl78-twice`,
        `${testAssetDirInternal}/temp/fl78-twice/`,
      ]);
      expect(body).toEqual(errorDto.badRequest('Invalid import path: Import path is listed more than once'));
    });

    it('refuses nested folders in one library', async () => {
      utils.createImageFile(`${testAssetDir}/temp/fl78-nested/inner/asset.png`);
      const body = await refusedCreate(admin.accessToken, admin.userId, [
        `${testAssetDirInternal}/temp/fl78-nested`,
        `${testAssetDirInternal}/temp/fl78-nested/inner`,
      ]);
      expect(body).toEqual(
        errorDto.badRequest('Invalid import path: Import path is inside another import path of this library'),
      );
    });

    it('reports every refusal when checking folders without saving', async () => {
      utils.createImageFile(`${testAssetDir}/temp/fl78-check/asset.png`);
      const library = await utils.createLibrary(admin.accessToken, { ownerId: admin.userId, name: 'FL-78 check' });
      const { status, body } = await request(app)
        .post(`/libraries/${library.id}/validate`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          importPaths: [
            `${testAssetDirInternal}/temp/fl78-link-to-upload`,
            `${testAssetDirInternal}/temp/../etc`,
            `${testAssetDirInternal}/temp/fl78-does-not-exist`,
            `${testAssetDirInternal}/temp/fl78-check`,
          ],
        });
      expect(status).toBe(200);
      expect(body.importPaths.map(({ reason }: { reason: string }) => reason)).toEqual([
        'upload_folder',
        'parent_traversal',
        'not_found',
        'valid',
      ]);
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

  describe('FL-78: a scan never reaches the media storage through a symbolic link', () => {
    it("imports the folder's own files and skips a link into the upload folder", async () => {
      // something of the administrator's in the upload folder, which the link below points at
      await utils.createAsset(admin.accessToken);
      utils.createImageFile(`${testAssetDir}/temp/fl78-linked-uploads/own.png`);
      symlinkSync(`${mediaLocation}/upload`, `${testAssetDir}/temp/fl78-linked-uploads/uploads`);
      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: nonAdmin.userId,
        name: 'FL-78 linked uploads',
        importPaths: [`${testAssetDirInternal}/temp/fl78-linked-uploads`],
      });

      await utils.scan(admin.accessToken, library.id);

      const { assets } = await utils.searchAssets(nonAdmin.accessToken, { libraryId: library.id });
      expect(assets.items.map(({ originalPath }) => originalPath)).toEqual([
        `${testAssetDirInternal}/temp/fl78-linked-uploads/own.png`,
      ]);
    });
  });

  describe('FL-78: the folder watcher', () => {
    afterAll(async () => {
      await utils.resetAdminConfig(admin.accessToken);
    });

    it(
      'imports a file added to a watched folder and marks a deleted one offline',
      { timeout: process.env.CI ? 425_000 : 175_000 },
      async ({ signal }) => {
        const fixtureFolder = `temp/fl78-watch-${randomUUID()}`;
        const folder = `${testAssetDirInternal}/${fixtureFolder}`;
        utils.createImageFile(`${testAssetDir}/${fixtureFolder}/first.png`);
        const library = await utils.createLibrary(admin.accessToken, {
          ownerId: admin.userId,
          name: 'FL-78 watch',
          importPaths: [folder],
        });
        await scanLibraryAsset(library.id, signal);

        const config = await utils.getSystemConfig(admin.accessToken);
        config.library.watch.enabled = true;
        await updateConfig({ adminConfigDto: config }, { headers: asBearerAuth(admin.accessToken) });
        // the watcher starts on the configuration event; give it a moment to be ready
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // written inside the server container, where the watcher listens
        const added = `${folder}/added.jpg`;
        await dockerExec([`cp ${testAssetDirInternal}/albums/nature/tanners_ridge.jpg ${added}`]).promise;

        const findAdded = async () => {
          const { assets } = await utils.searchAssets(admin.accessToken, {
            libraryId: library.id,
            originalPath: added,
          });
          return assets.items[0];
        };
        await expect
          .poll(findAdded, { timeout: 45_000, interval: 1000 })
          .toEqual(expect.objectContaining({ originalPath: added, isOffline: false }));
        const { id } = await findAdded();
        // The row is visible before LibrarySyncFiles queues sidecar discovery and its metadata followups.
        await utils.waitForQueueFinish(admin.accessToken, 'library', undefined, signal);
        await utils.waitForQueueFinish(admin.accessToken, 'sidecar', undefined, signal);
        await utils.waitForAssetReady(admin.accessToken, id, { signal });

        await dockerExec([`rm ${added}`]).promise;

        // a deleted file is not forgotten: its item stays, offline, until the file comes back
        await expect
          .poll(
            async () => {
              const asset = await utils.getAssetInfo(admin.accessToken, id);
              return asset.isOffline;
            },
            {
              timeout: 45_000,
              interval: 1000,
            },
          )
          .toBe(true);
      },
    );
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
      expect(body).toEqual(errorDto.conflict('The library changed after it was reviewed. Review the removal again.'));
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

    // Three queue/scan budgets (60s CI / 10s local), four 5s requests, and 10s setup/assertions.
    it(
      'reviews, then removes the library with the token and typed name, keeping the source files',
      { timeout: process.env.CI ? 210_000 : 60_000 },
      async ({ signal }) => {
        const fixtureFolder = `temp/fl78-removal-${randomUUID()}`;
        const hostFile = `${testAssetDir}/${fixtureFolder}/asset.png`;
        utils.createImageFile(hostFile);
        try {
          const created = await ownedWait(
            'Creating removal fixture library',
            5000,
            (context) =>
              requestOnce(context, () =>
                request(app)
                  .post('/libraries')
                  .set('Authorization', `Bearer ${admin.accessToken}`)
                  .send({
                    ownerId: admin.userId,
                    name: 'FL-78 removal',
                    importPaths: [`${testAssetDirInternal}/${fixtureFolder}`],
                  }),
              ),
            signal,
          );
          expect(created.status).toBe(201);
          const library = created.body as LibraryResponseDto;
          await utils.scan(admin.accessToken, library.id, signal);

          const reviewed = await ownedWait(
            'Reviewing fixture library removal',
            5000,
            (context) =>
              requestOnce(context, () =>
                request(app)
                  .get(`/libraries/${library.id}/removal`)
                  .set('Authorization', `Bearer ${admin.accessToken}`),
              ),
            signal,
          );
          expect(reviewed.status).toBe(200);
          const { reviewToken, ...consequences } = reviewed.body as LibraryRemovalReviewDto;
          expect(reviewToken).toEqual(expect.any(String));
          expect(consequences).toMatchObject({
            libraryId: library.id,
            name: 'FL-78 removal',
            total: 1,
            originalsKept: true,
          });

          const { status } = await ownedWait(
            'Confirming fixture library removal',
            5000,
            (context) =>
              requestOnce(context, () =>
                request(app)
                  .post(`/libraries/${library.id}/removal`)
                  .set('Authorization', `Bearer ${admin.accessToken}`)
                  .send({ reviewToken, confirmName: 'FL-78 removal' }),
              ),
            signal,
          );
          expect(status).toBe(204);

          await utils.waitForQueueFinish(admin.accessToken, 'library', undefined, signal);
          await utils.waitForQueueFinish(admin.accessToken, 'backgroundTask', undefined, signal);

          const { body: libraries } = await ownedWait(
            'Reading libraries after fixture removal',
            5000,
            (context) =>
              requestOnce(context, () =>
                request(app).get('/libraries').set('Authorization', `Bearer ${admin.accessToken}`),
              ),
            signal,
          );
          expect((libraries as LibraryResponseDto[]).map(({ id }) => id)).not.toContain(library.id);

          // Assert source protection before this test removes its own fixture file.
          expect(existsSync(hostFile)).toBe(true);
        } finally {
          utils.removeImageFile(hostFile);
        }
      },
    );
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
