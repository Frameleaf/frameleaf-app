import { AssetMediaResponseDto, AssetVisibility, LoginResponseDto, SharedLinkType } from '@frameleaf/sdk';
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

    // FL-326: a partner downloads their own copy, never the source, and keeps the copy after unsharing
    it("refuses a partner's source item and keeps the recipient's copy once the partner stops sharing", async () => {
      const partner = await utils.userSetup(admin.accessToken, {
        email: 'download-partner@example.com',
        name: 'Download Partner',
        password: 'password',
      });
      const partnerAsset = await utils.createAsset(partner.accessToken);
      await utils.createPartner(partner.accessToken, admin.userId);
      const copyId = await utils.waitForPartnerCopy(admin.userId, partnerAsset.id);
      const db = await utils.connectDatabase();
      const origin = async () => {
        const { rows } = await db.query(
          `SELECT copy.id, copy."ownerId", origin."sourceAssetId", origin."rootOwnerId", origin.following
           FROM public.asset_origin origin JOIN public.asset copy ON copy.id = origin."assetId"
           WHERE origin."sourceAssetId" = $1 AND origin."ownerId" = $2`,
          [partnerAsset.id, admin.userId],
        );
        return rows;
      };
      const expectedOrigin = {
        id: copyId,
        ownerId: admin.userId,
        sourceAssetId: partnerAsset.id,
        rootOwnerId: partner.userId,
      };
      expect(copyId).not.toBe(partnerAsset.id);
      expect(await origin()).toEqual([{ ...expectedOrigin, following: true }]);
      const { rows: receivedInventory } = await db.query(
        'SELECT id FROM public.asset WHERE "ownerId" = $1 ORDER BY id',
        [admin.userId],
      );

      const info = (assetIds: string[]) =>
        request(app).post('/download/info').set('Authorization', `Bearer ${admin.accessToken}`).send({ assetIds });
      const expectOnlyCopy = async () => {
        const source = await info([partnerAsset.id]);
        expect(source.status).toBe(400);
        expect(JSON.stringify(source.body)).not.toContain('example.png');
        const copy = await info([copyId]);
        expect(copy.status).toBe(201);
        expect(copy.body.archives).toEqual([expect.objectContaining({ assetIds: [copyId] })]);
        expect(copy.body.totalSize).toBeGreaterThan(0);
        const original = await request(app)
          .get(`/assets/${copyId}/original`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .expect(200);
        const sourceOriginal = await request(app)
          .get(`/assets/${partnerAsset.id}/original`)
          .set('Authorization', `Bearer ${partner.accessToken}`)
          .expect(200);
        expect(Buffer.isBuffer(original.body)).toBe(true);
        expect(original.body.length).toBeGreaterThan(0);
        expect(original.body).toEqual(sourceOriginal.body);
        await request(app)
          .get(`/assets/${partnerAsset.id}/original`)
          .set('Authorization', `Bearer ${admin.accessToken}`)
          // Media's sendFile wrapper conceals unauthorized originals as not found.
          .expect(404);
      };

      await expectOnlyCopy();
      await request(app)
        .delete(`/partners/${admin.userId}`)
        .set('Authorization', `Bearer ${partner.accessToken}`)
        .expect(204);
      await utils.waitForAllQueuesFinish(admin.accessToken);
      expect(await origin()).toEqual([{ ...expectedOrigin, following: false }]);
      await expectOnlyCopy();

      const later = await utils.createAsset(partner.accessToken);
      expect(later.id).toEqual(expect.any(String));
      const { rows: laterSource } = await db.query('SELECT id, "ownerId" FROM public.asset WHERE id = $1', [later.id]);
      expect(laterSource).toEqual([{ id: later.id, ownerId: partner.userId }]);
      // The postprocess job emits partner delivery. An empty active queue does not prove it ran.
      await expect
        .poll(
          async () => {
            const { rows: jobs } = await db.query<{ name: string; state: string }>(
              `SELECT name, state FROM public.job
               WHERE (name IN ('AssetExtractMetadata', 'AssetMetadataPostprocess') AND data->>'id' = $1)
                  OR "dedupKey" = 'partner-copy/' || $1 || '/' || $2
               ORDER BY name, id`,
              [later.id, admin.userId],
            );
            return {
              extracted: jobs.some(({ name, state }) => name === 'AssetExtractMetadata' && state === 'completed'),
              postprocessed: jobs.some(
                ({ name, state }) => name === 'AssetMetadataPostprocess' && state === 'completed',
              ),
              unfinished: jobs.filter(({ state }) => state !== 'completed'),
            };
          },
          { timeout: 20_000 },
        )
        .toEqual({ extracted: true, postprocessed: true, unfinished: [] });
      const { rows: laterOrigins } = await db.query(
        'SELECT "assetId" FROM public.asset_origin WHERE "sourceAssetId" = $1 AND "ownerId" = $2',
        [later.id, admin.userId],
      );
      expect(laterOrigins).toEqual([]);
      const { rows: retainedInventory } = await db.query(
        'SELECT id FROM public.asset WHERE "ownerId" = $1 ORDER BY id',
        [admin.userId],
      );
      expect(retainedInventory).toEqual(receivedInventory);
      expect(await origin()).toEqual([{ ...expectedOrigin, following: false }]);
      const laterInfo = await info([later.id]);
      expect(laterInfo.status).toBe(400);
      await expectOnlyCopy();
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
