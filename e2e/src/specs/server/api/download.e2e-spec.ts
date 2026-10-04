import { AssetMediaResponseDto, AssetVisibility, LoginResponseDto, SharedLinkType } from '@immich/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { app, tempDir, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

describe('/download', () => {
  let admin: LoginResponseDto;
  let asset1: AssetMediaResponseDto;
  let asset2: AssetMediaResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    [asset1, asset2] = await Promise.all([utils.createAsset(admin.accessToken), utils.createAsset(admin.accessToken)]);
  });

  describe('POST /download/info', () => {
    it('should download info', async () => {
      const { status, body } = await request(app)
        .post('/download/info')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ assetIds: [asset1.id] });

      expect(status).toBe(201);
      expect(body).toEqual(
        expect.objectContaining({
          archives: [expect.objectContaining({ assetIds: [asset1.id] })],
        }),
      );
    });
  });

  // FL-45: the download API's boundaries, restrictions and revocations, checked before any file name or
  // address is handed out.
  describe('POST /download/info restrictions (FL-45)', () => {
    it('splits the plan at the archive size', async () => {
      const { status, body } = await request(app)
        .post('/download/info')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ assetIds: [asset1.id, asset2.id], archiveSize: 1 });

      expect(status).toBe(201);
      expect(body.archives).toHaveLength(2);
      expect(
        body.archives
          .flatMap((archive: { assetIds: string[] }) => archive.assetIds)
          .toSorted((a: string, b: string) => a.localeCompare(b)),
      ).toEqual([asset1.id, asset2.id].toSorted((a, b) => a.localeCompare(b)));
      expect(body.totalSize).toBe(
        body.archives.reduce((sum: number, archive: { size: number }) => sum + archive.size, 0),
      );
    });

    it('keeps everything in one archive under the size', async () => {
      const { body } = await request(app)
        .post('/download/info')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ assetIds: [asset1.id, asset2.id], archiveSize: 1024 * 1024 * 1024 });
      expect(body.archives).toHaveLength(1);
    });

    it('never plans a Locked item for a session that has not unlocked', async () => {
      const locked = await utils.createAsset(admin.accessToken);
      await request(app)
        .put(`/assets/${locked.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ visibility: AssetVisibility.Locked });

      const direct = await request(app)
        .post('/download/info')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ assetIds: [locked.id] });
      expect(direct.status).toBe(400);

      const library = await request(app)
        .post('/download/info')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ userId: admin.userId });
      expect(library.status).toBe(201);
      expect(library.body.archives.flatMap((archive: { assetIds: string[] }) => archive.assetIds)).not.toContain(
        locked.id,
      );

      const archive = await request(app)
        .post('/download/archive')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ assetIds: [locked.id] });
      expect(archive.status).toBe(400);
    });

    it('keeps received copies after sharing stops and refuses source IDs or new delivery', async () => {
      const users: LoginResponseDto[] = [];
      let sharing = false;
      try {
        const partner = await utils.userSetup(admin.accessToken, {
          email: 'download-partner@example.com',
          name: 'Download Partner',
          password: 'password',
        });
        users.push(partner);
        const recipient = await utils.userSetup(admin.accessToken, {
          email: 'download-recipient@example.com',
          name: 'Download Recipient',
          password: 'password',
        });
        users.push(recipient);
        const partnerAsset = await utils.createAsset(partner.accessToken);
        await utils.createPartner(partner.accessToken, recipient.userId);
        sharing = true;
        await utils.waitForAllQueuesFinish(admin.accessToken);
        const db = await utils.connectDatabase();
        const { rows } = await db.query<{ id: string; ownerId: string; sourceAssetId: string; following: boolean }>(
          `SELECT copy.id, copy."ownerId", origin."sourceAssetId", origin.following
           FROM immich_fork.asset_origin origin JOIN asset copy ON copy.id = origin."assetId"
           WHERE origin."sourceAssetId" = $1 AND origin."ownerId" = $2`,
          [partnerAsset.id, recipient.userId],
        );
        expect(rows).toHaveLength(1);
        const [copy] = rows;
        expect(copy.id).not.toBe(partnerAsset.id);
        expect(copy).toMatchObject({ ownerId: recipient.userId, sourceAssetId: partnerAsset.id, following: true });
        const plan = await request(app)
          .post('/download/info')
          .set('Authorization', `Bearer ${recipient.accessToken}`)
          .send({ assetIds: [copy.id] })
          .expect(201);
        expect(plan.body.archives.flatMap((archive: { assetIds: string[] }) => archive.assetIds)).toEqual([copy.id]);
        await request(app)
          .post('/download/info')
          .set('Authorization', `Bearer ${recipient.accessToken}`)
          .send({ assetIds: [partnerAsset.id] })
          .expect(400);
        await request(app)
          .delete(`/partners/${recipient.userId}`)
          .set('Authorization', `Bearer ${partner.accessToken}`)
          .expect(204);
        sharing = false;
        await utils.waitForAllQueuesFinish(admin.accessToken);
        const retained = await request(app)
          .post('/download/info')
          .set('Authorization', `Bearer ${recipient.accessToken}`)
          .send({ assetIds: [copy.id] })
          .expect(201);
        expect(retained.body.archives.flatMap((archive: { assetIds: string[] }) => archive.assetIds)).toEqual([
          copy.id,
        ]);
        const retainedOrigin = await db.query('SELECT following FROM immich_fork.asset_origin WHERE "assetId" = $1', [
          copy.id,
        ]);
        expect(retainedOrigin.rows).toEqual([{ following: false }]);
        const later = await utils.createAsset(partner.accessToken);
        await utils.waitForAllQueuesFinish(admin.accessToken);
        const laterOrigin = await db.query(
          'SELECT "assetId" FROM immich_fork.asset_origin WHERE "sourceAssetId" = $1 AND "ownerId" = $2',
          [later.id, recipient.userId],
        );
        expect(laterOrigin.rows).toEqual([]);
        await request(app)
          .post('/download/info')
          .set('Authorization', `Bearer ${recipient.accessToken}`)
          .send({ assetIds: [later.id] })
          .expect(400);
      } finally {
        if (sharing && users.length === 2) {
          await request(app)
            .delete(`/partners/${users[1].userId}`)
            .set('Authorization', `Bearer ${users[0].accessToken}`)
            .expect(204);
        }
        await utils.waitForAllQueuesFinish(admin.accessToken);
        for (const user of users) {
          await request(app)
            .delete(`/admin/users/${user.userId}`)
            .set('Authorization', `Bearer ${admin.accessToken}`)
            .send({ force: true })
            .expect(200);
        }
        await utils.waitForAllQueuesFinish(admin.accessToken);
        const db = await utils.connectDatabase();
        for (const user of users) {
          const deletedUser = await db.query('SELECT id FROM "user" WHERE id = $1', [user.userId]);
          expect(deletedUser.rows).toEqual([]);
          // Fork provenance has no official-schema foreign keys; remove the drained fixture's orphan rows.
          await db.query('DELETE FROM immich_fork.asset_origin WHERE "ownerId" = $1 OR "partnerSharedById" = $1', [
            user.userId,
          ]);
          await db.query('DELETE FROM immich_fork.partner_backfill WHERE "sharedById" = $1 OR "sharedWithId" = $1', [
            user.userId,
          ]);
        }
      }
    }, 90_000);

    it('refuses a public link that does not allow downloads, before naming any file', async () => {
      const closed = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [asset1.id],
        allowDownload: false,
      });
      const info = await request(app)
        .post(`/download/info?key=${closed.key}`)
        .send({ assetIds: [asset1.id] });
      expect(info.status).toBe(400);
      expect(JSON.stringify(info.body)).not.toContain(asset1.id);

      const archive = await request(app)
        .post(`/download/archive?key=${closed.key}`)
        .send({ assetIds: [asset1.id] });
      expect(archive.status).toBe(400);

      const open = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [asset1.id],
        allowDownload: true,
      });
      const allowed = await request(app)
        .post(`/download/info?key=${open.key}`)
        .send({ assetIds: [asset1.id] });
      expect(allowed.status).toBe(201);
      expect(allowed.body.archives[0].assetIds).toEqual([asset1.id]);
    });
  });

  describe('POST /download/archive', () => {
    it('should download an archive', async () => {
      const { status, body } = await request(app)
        .post('/download/archive')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ assetIds: [asset1.id, asset2.id] });

      expect(status).toBe(200);
      expect(body instanceof Buffer).toBe(true);

      await writeFile(`${tempDir}/archive.zip`, body);
      await utils.unzip(`${tempDir}/archive.zip`, `${tempDir}/archive`);
      const files = [
        { filename: 'example.png', id: asset1.id },
        { filename: 'example+1.png', id: asset2.id },
      ];
      for (const { id, filename } of files) {
        const bytes = await readFile(`${tempDir}/archive/${filename}`);
        const asset = await utils.getAssetInfo(admin.accessToken, id);
        // New uploads use SHA-256; legacy fixtures may still be SHA-1. Match by length.
        const expected = asset.checksum.length === 44 ? utils.sha256(bytes) : utils.sha1(bytes);
        expect(expected).toBe(asset.checksum);
      }
    });
  });
});
