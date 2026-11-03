import { ExifDateTime } from 'exiftool-vendored';
import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetType } from 'src/enum.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB, newTestService } from 'test/utils.js';

let db: Kysely<DB>;
let root: string;
beforeAll(async () => {
  db = await getKyselyDB();
  root = await mkdtemp(join(tmpdir(), 'frameleaf-import-clocks-'));
});
afterAll(async () => {
  await db?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
});

// PostgreSQL publication and editing transactions are real; extraction I/O supplies stale synthetic tags.
it.each([false, true])(
  'preserves manual clocks through accepted metadata publication (late edit: %s)',
  async (lateEdit) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const path = join(root, `${user.id}.jpg`);
    await copyFile(new URL('../../../../src/library-import/fixtures/ente/media/photo.jpg', import.meta.url), path);
    const original = await readFile(path);
    const checksum = createHash('sha1').update(original).digest();
    const oldDate = new Date('2021-01-01T00:00:00Z');
    await utimes(path, oldDate, oldDate);
    const manualDate = new Date('2026-06-21T22:56:00Z');
    const manualLocal = new Date('2026-06-21T16:56:00Z');
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Image,
      originalPath: path,
      originalFileName: 'original.jpg',
      checksum,
      fileCreatedAt: oldDate,
      localDateTime: oldDate,
    });
    const assets = new AssetRepository(db);
    const jobs = new AssetJobRepository(db);
    await assets.upsertExif({
      exif: { assetId: asset.id, dateTimeOriginal: oldDate, timeZone: 'UTC' },
      lockedPropertiesBehavior: 'append',
    });
    const edit = () =>
      publicationTransaction.exit(() =>
        db.transaction().execute((tx) =>
          publicationTransaction.run(tx, async () => {
            await assets.upsertExif({
              exif: {
                assetId: asset.id,
                dateTimeOriginal: manualDate,
                timeZone: 'America/Edmonton',
                lockedProperties: ['dateTimeOriginal', 'timeZone'],
              },
              lockedPropertiesBehavior: 'append',
            });
            await assets.update({ id: asset.id, fileCreatedAt: manualDate, localDateTime: manualLocal });
          }),
        ),
      );
    if (!lateEdit) await edit();
    const { sut, mocks } = newTestService(MetadataService, { asset: assets, assetJob: jobs });
    mocks.storage.stat.mockResolvedValue(await stat(path));
    mocks.metadata.readTags.mockResolvedValue({
      DateTimeOriginal: ExifDateTime.fromISO('2001-01-01T12:00:00Z'),
      zone: 'UTC',
    });
    if (lateEdit) {
      const inspect = mocks.media.inspectImageEncoding.getMockImplementation()!;
      mocks.media.inspectImageEncoding.mockImplementationOnce(async (...args) => {
        await edit();
        return inspect(...args);
      });
    }
    try {
      await db
        .transaction()
        .execute((tx) => publicationTransaction.run(tx, () => sut.handleMetadataExtraction({ id: asset.id })));
      await expect(
        db
          .selectFrom('asset')
          .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
          .select(['asset.fileCreatedAt', 'asset.localDateTime', 'asset_exif.dateTimeOriginal', 'asset_exif.timeZone'])
          .where('asset.id', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        fileCreatedAt: manualDate,
        localDateTime: manualLocal,
        dateTimeOriginal: manualDate,
        timeZone: 'America/Edmonton',
      });
      expect(await readFile(path)).toEqual(original);
    } finally {
      await sut.onShutdown();
    }
  },
);
