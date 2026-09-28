import { LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FL-46: the Folders browser's summary counts only what the folder views list: the owner's Timeline
 * items, never an archived, trashed or another user's one, and it agrees with the folder listing.
 */
describe('/view', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);

    await utils.createAsset(user.accessToken);
    await utils.createAsset(user.accessToken);
    const archived = await utils.createAsset(user.accessToken);
    const trashed = await utils.createAsset(user.accessToken);
    await utils.createAsset(admin.accessToken);
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
    await utils.archiveAssets(user.accessToken, [archived.id]);
    await utils.deleteAssets(user.accessToken, [trashed.id]);
  });

  describe('GET /view/folder/summary', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).get('/view/folder/summary');
      expect(status).toBe(401);
    });

    it('should count the listable originals in each folder, with their size', async () => {
      const { status, body } = await request(app)
        .get('/view/folder/summary')
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);

      const paths = await request(app)
        .get('/view/folder/unique-paths')
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(body.map(({ path }: { path: string }) => path)).toEqual(paths.body);
      expect(body.reduce((sum: number, { count }: { count: number }) => sum + count, 0)).toBe(2);

      for (const { path, count, size } of body as { path: string; count: number; size: number }[]) {
        const listed = await request(app)
          .get('/view/folder')
          .query({ path })
          .set('Authorization', `Bearer ${user.accessToken}`);
        expect(listed.body).toHaveLength(count);
        expect(size).toBe(
          listed.body.reduce(
            (sum: number, asset: { exifInfo?: { fileSizeInByte?: number } }) =>
              sum + (asset.exifInfo?.fileSizeInByte ?? 0),
            0,
          ),
        );
      }
    });
  });
});
