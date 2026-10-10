import { Kysely, sql } from 'kysely';
import { AssetOrder, AssetOrderBy, AssetVisibility, CalendarHeatmapType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

// Metadata extraction is repeatable: probing improves, files get repaired,
// and a re-run has to be able to correct what an earlier run stored.
const audioRow = (assetId: string, n: number) => ({
  assetId,
  bitrate: 100_000 + n,
  index: n,
  profile: n,
  codecName: `codec-${n}`,
  // FL-102: channel-aware audio is persisted alongside the codec facts.
  channels: 2 * n,
  channelLayout: n === 1 ? 'stereo' : '5.1',
  sampleRate: 48_000 * n,
});

const videoRow = (assetId: string, n: number) => ({
  assetId,
  bitrate: 200_000 + n,
  frameCount: 300 + n,
  timeBase: 600 + n,
  index: n,
  profile: n,
  level: n,
  colorPrimaries: n,
  colorTransfer: n,
  colorMatrix: n,
  dvProfile: n,
  dvLevel: n,
  dvBlSignalCompatibilityId: n,
  codecName: `vcodec-${n}`,
  formatName: `format-${n}`,
  formatLongName: `format long ${n}`,
  pixelFormat: `pixfmt-${n}`,
});

const keyframeRow = (assetId: string, n: number) => ({
  assetId,
  pts: [n],
  accDuration: [n],
  ownDuration: [n],
  totalDuration: 1000 + n,
  packetCount: 10 + n,
  outputFrames: 20 + n,
});

describe(AssetRepository.name, () => {
  describe('getTimeBucket', () => {
    it('should order assets by local day first and fileCreatedAt within each day', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const [{ asset: previousLocalDayAsset }, { asset: nextLocalDayEarlierAsset }, { asset: nextLocalDayLaterAsset }] =
        await Promise.all([
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
            localDateTime: new Date('2026-03-08T22:30:00.000Z'),
          }),
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-08T23:30:00.000Z'),
            localDateTime: new Date('2026-03-09T01:30:00.000Z'),
          }),
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-08T23:45:00.000Z'),
            localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          }),
        ]);

      await Promise.all([
        ctx.newExif({ assetId: previousLocalDayAsset.id, timeZone: 'UTC-2' }),
        ctx.newExif({ assetId: nextLocalDayEarlierAsset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: nextLocalDayLaterAsset.id, timeZone: 'UTC+2' }),
      ]);

      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        { order: AssetOrder.Desc, userIds: [user.id], visibility: AssetVisibility.Timeline },
        auth,
      );
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [nextLocalDayLaterAsset.id, nextLocalDayEarlierAsset.id, previousLocalDayAsset.id],
        }),
      );

      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        { order: AssetOrder.Asc, userIds: [user.id], visibility: AssetVisibility.Timeline },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [previousLocalDayAsset.id, nextLocalDayEarlierAsset.id, nextLocalDayLaterAsset.id],
        }),
      );
    });

    it('should order assets by originalFileName when fileCreatedAt is the same (takenAt)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      // create all the fake photos
      const [
        { asset: time1DSC0001Asset },
        { asset: time1DSC0002Asset },
        { asset: time2DSC0003Asset },
        { asset: time2DSC0004Asset },
      ] = await Promise.all([
        // both at 12:30AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0001.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0002.jpg',
        }),
        // both at 1:45AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0003.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0004.jpg',
        }),
      ]);

      // even though im not gonna do anything with these it's required!
      await Promise.all([
        ctx.newExif({ assetId: time1DSC0001Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time1DSC0002Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0003Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0004Asset.id, timeZone: 'UTC+2' }),
      ]);

      // check the values given by the bucket when descending
      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Desc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.TakenAt,
        },
        auth,
      );
      // make sure they're ordered correctly
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time2DSC0004Asset.id, time2DSC0003Asset.id, time1DSC0002Asset.id, time1DSC0001Asset.id],
        }),
      );

      // now do the same when ascending
      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Asc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.TakenAt,
        },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time1DSC0001Asset.id, time1DSC0002Asset.id, time2DSC0003Asset.id, time2DSC0004Asset.id],
        }),
      );
    });

    it('should order assets by originalFileName when fileCreatedAt is the same (createdAt)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      // create all the fake photos
      const [
        { asset: time1DSC0001Asset },
        { asset: time1DSC0002Asset },
        { asset: time2DSC0003Asset },
        { asset: time2DSC0004Asset },
      ] = await Promise.all([
        // createdAt = uploadedAt, fileCreatedAt = file metadata
        // both at 12:30AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          createdAt: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0001.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
          localDateTime: new Date('2026-03-09T00:30:00.000Z'),
          createdAt: new Date('2026-03-09T00:30:00.000Z'),
          originalFileName: 'DSC0002.jpg',
        }),
        // both at 1:45AM
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          createdAt: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0003.jpg',
        }),
        ctx.newAsset({
          ownerId: user.id,
          fileCreatedAt: new Date('2026-03-09T01:45:00.000Z'),
          localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          createdAt: new Date('2026-03-09T01:45:00.000Z'),
          originalFileName: 'DSC0004.jpg',
        }),
      ]);

      // even though im not gonna do anything with these it's required!
      await Promise.all([
        ctx.newExif({ assetId: time1DSC0001Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time1DSC0002Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0003Asset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: time2DSC0004Asset.id, timeZone: 'UTC+2' }),
      ]);

      // check the values given by the bucket when descending
      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Desc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.CreatedAt,
        },
        auth,
      );
      // make sure they're ordered correctly
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time2DSC0004Asset.id, time2DSC0003Asset.id, time1DSC0002Asset.id, time1DSC0001Asset.id],
        }),
      );

      // now do the same when ascending
      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        {
          order: AssetOrder.Asc,
          userIds: [user.id],
          visibility: AssetVisibility.Timeline,
          orderBy: AssetOrderBy.CreatedAt,
        },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [time1DSC0001Asset.id, time1DSC0002Asset.id, time2DSC0003Asset.id, time2DSC0004Asset.id],
        }),
      );
    });
  });

  describe('upsertExif', () => {
    it('updates image encoding on existing EXIF while unrelated metadata edits preserve it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const sdr = { dynamicRange: 'sdr' as const, gainMap: 'none', reconstructionAvailable: false };
      const hdr = { dynamicRange: 'hdr' as const, gainMap: 'ultra-hdr', reconstructionAvailable: true };
      for (const imageEncoding of [sdr, hdr]) {
        await sut.upsertExif({ exif: { assetId: asset.id, imageEncoding }, lockedPropertiesBehavior: 'skip' });
        const row = await ctx.database
          .selectFrom('asset_exif')
          .select('imageEncoding')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow();
        expect(row.imageEncoding).toEqual(imageEncoding);
      }
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'Edited caption' },
        lockedPropertiesBehavior: 'override',
      });
      const row = await ctx.database
        .selectFrom('asset_exif')
        .select(['imageEncoding', 'description'])
        .where('assetId', '=', asset.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ imageEncoding: hdr, description: 'Edited caption' });
    });
    it.each(['make', 'model', null] as const)(
      'atomically writes evidence with EXIF and respects camera lock %s',
      async (lock) => {
        const { ctx, sut } = setup();
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        const evidence = {
          version: 1 as const,
          recorded: { make: 'A', model: 'one', source: 'original' as const },
          alternatives: [],
          suggestion: null,
        };
        await sut.upsertExif({
          exif: { assetId: asset.id, make: 'A', model: 'one' },
          cameraEvidence: evidence,
          expectedUpdateId: null,
          lockedPropertiesBehavior: 'skip',
        });
        const previous = await ctx.database
          .selectFrom('asset_exif')
          .select('updateId')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow();
        if (lock) {
          // Seed persisted camera locks directly: the public edit API exposes a narrower union.
          await ctx.database
            .updateTable('asset_exif')
            .set({ make: null, model: null, lockedProperties: sql`array[${lock}]::varchar[]` })
            .where('assetId', '=', asset.id)
            .execute();
        }
        const current = await ctx.database
          .selectFrom('asset_exif')
          .select('updateId')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow();
        const newer = { ...evidence, recorded: { ...evidence.recorded, model: 'two' } };
        await sut.upsertExif({
          exif: { assetId: asset.id, make: 'A', model: 'two' },
          cameraEvidence: newer,
          expectedUpdateId: current.updateId,
          lockedPropertiesBehavior: 'skip',
        });
        expect((await sut.getMetadata(asset.id))[0].value).toEqual(lock ? evidence : newer);
        if (lock) {
          expect(
            await ctx.database
              .selectFrom('asset_exif')
              .select(lock)
              .where('assetId', '=', asset.id)
              .executeTakeFirstOrThrow(),
          ).toEqual({ [lock]: null });
        }
        // The original revision is stale after either the edit or the successful extraction.
        await sut.upsertExif({
          exif: { assetId: asset.id, model: 'stale' },
          cameraEvidence: { ...newer, recorded: { ...newer.recorded, model: 'stale' } },
          expectedUpdateId: previous.updateId,
          lockedPropertiesBehavior: 'skip',
        });
        expect((await sut.getMetadata(asset.id))[0].value).toEqual(lock ? evidence : newer);
      },
    );

    it('preserves media CTE writes when publishing camera evidence', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await sut.upsertExif({
        exif: { assetId: asset.id, model: 'recorded' },
        cameraEvidence: {
          version: 1,
          recorded: { make: null, model: 'recorded', source: 'original' },
          alternatives: [],
          suggestion: null,
        },
        audio: audioRow(asset.id, 1),
        video: videoRow(asset.id, 1),
        keyframes: keyframeRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
        expectedUpdateId: null,
      });
      expect(
        await ctx.database
          .selectFrom('asset_audio')
          .selectAll()
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(audioRow(asset.id, 1));
      expect(
        await ctx.database
          .selectFrom('asset_video')
          .selectAll()
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(videoRow(asset.id, 1));
      expect(
        await ctx.database
          .selectFrom('asset_keyframe')
          .selectAll()
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(keyframeRow(asset.id, 1));

      // These paths run against the fresh baseline plus ORDER-listed migrations. All three
      // metadata tables must retain their ownership foreign keys and cascade with the asset.
      await ctx.database.deleteFrom('asset').where('id', '=', asset.id).execute();
      for (const table of ['asset_audio', 'asset_video', 'asset_keyframe'] as const) {
        expect(await ctx.database.selectFrom(table).selectAll().where('assetId', '=', asset.id).execute()).toEqual([]);
      }
      await expect(ctx.database.insertInto('asset_audio').values(audioRow(asset.id, 1)).execute()).rejects.toThrow();
      await expect(ctx.database.insertInto('asset_video').values(videoRow(asset.id, 1)).execute()).rejects.toThrow();
      await expect(
        ctx.database.insertInto('asset_keyframe').values(keyframeRow(asset.id, 1)).execute(),
      ).rejects.toThrow();
    });

    it('rejects stale evidence when an EXIF row was inserted after the empty snapshot', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, model: 'owner edit' });
      await sut.upsertExif({
        exif: { assetId: asset.id, model: 'stale' },
        cameraEvidence: { version: 1, recorded: null, alternatives: [], suggestion: null },
        expectedUpdateId: null,
        lockedPropertiesBehavior: 'skip',
      });
      expect(await sut.getMetadata(asset.id)).toEqual([]);
      expect(
        await ctx.database
          .selectFrom('asset_exif')
          .select('model')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ model: 'owner edit' });
    });

    it('should replace stored audio metadata on a second extraction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        audio: audioRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        audio: audioRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_audio').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(audioRow(asset.id, 1));
    });

    it('should replace stored video metadata on a second extraction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        video: videoRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        video: videoRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_video').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(videoRow(asset.id, 1));
    });

    it('should replace stored keyframe metadata on a second extraction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        keyframes: keyframeRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        keyframes: keyframeRow(asset.id, 1),
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_keyframe').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(keyframeRow(asset.id, 1));
    });

    // A probe that could not read a stream sends no object at all, and that must
    // not be read as "delete what is already known".
    it('should leave stored media metadata alone when an extraction omits it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'first' },
        audio: audioRow(asset.id, 2),
        lockedPropertiesBehavior: 'skip',
      });
      await sut.upsertExif({
        exif: { assetId: asset.id, description: 'second' },
        lockedPropertiesBehavior: 'skip',
      });

      await expect(
        ctx.database.selectFrom('asset_audio').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual(audioRow(asset.id, 2));
    });
    it('should append to locked columns', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal'] });

      await sut.upsertExif({
        exif: { assetId: asset.id, lockedProperties: ['description'] },
        lockedPropertiesBehavior: 'append',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description', 'dateTimeOriginal'] });
    });

    it('should deduplicate locked columns', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.upsertExif({
        exif: { assetId: asset.id, lockedProperties: ['description'] },
        lockedPropertiesBehavior: 'append',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description', 'dateTimeOriginal'] });
    });
  });

  describe('unlockProperties', () => {
    it('should unlock one property', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.unlockProperties(asset.id, ['dateTimeOriginal']);

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description'] });
    });

    it('should unlock all properties', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.unlockProperties(asset.id, ['description', 'dateTimeOriginal']);

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });
    });
  });

  describe('createAll', () => {
    it('should return an empty array when given an empty input', async () => {
      const { sut } = setup();
      await expect(sut.createAll([])).resolves.toStrictEqual([]);
    });
  });

  describe('motion parts of Locked live photos (FL-34)', () => {
    it('should keep a Locked still’s motion part from partners and ordinary sessions', async () => {
      const { ctx } = setup();
      const access = ctx.get(AccessRepository);
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
      const { asset: motion } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Hidden });
      const { asset: plainMotion } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Hidden });
      await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked, livePhotoVideoId: motion.id });
      await ctx.newAsset({ ownerId: owner.id, livePhotoVideoId: plainMotion.id });
      const ids = new Set([motion.id, plainMotion.id]);

      // FL-326: a partner reaches none of the sharer's rows; they hold their own copies
      await expect(access.asset.checkOwnerAccess(partner.id, ids, false)).resolves.toEqual(new Set());
      await expect(access.asset.checkOwnerAccess(owner.id, ids, false)).resolves.toEqual(new Set([plainMotion.id]));
      await expect(access.asset.checkOwnerAccess(owner.id, ids, true)).resolves.toEqual(ids);
    });
  });

  describe('duplicate lookups by checksum', () => {
    it("should name the owner's Locked media only for their elevated session (FL-34)", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

      await expect(sut.getByChecksums(user.id, [locked.checksum])).resolves.toEqual([]);
      await expect(sut.getUploadAssetIdByChecksum(user.id, locked.checksum)).resolves.toBeUndefined();

      await expect(sut.getByChecksums(user.id, [locked.checksum], { lockedOwnerId: user.id })).resolves.toEqual([
        expect.objectContaining({ id: locked.id }),
      ]);
      await expect(sut.getUploadAssetIdByChecksum(user.id, locked.checksum, { lockedOwnerId: user.id })).resolves.toBe(
        locked.id,
      );
    });
  });

  describe('getCalendarHeatmap', () => {
    it("should count Locked media only for its owner's elevated session (FL-34)", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const now = new Date();
      await ctx.newAsset({ ownerId: user.id, createdAt: now });
      await ctx.newAsset({ ownerId: user.id, createdAt: now, visibility: AssetVisibility.Archive });
      await ctx.newAsset({ ownerId: user.id, createdAt: now, visibility: AssetVisibility.Locked });

      const range = {
        from: new Date(now.getTime() - 86_400_000),
        to: new Date(now.getTime() + 86_400_000),
        type: CalendarHeatmapType.Upload,
      };
      const total = async (lockedOwnerId?: string) => {
        const days = await sut.getCalendarHeatmap(user.id, { ...range, lockedOwnerId });
        return days.reduce((sum, day) => sum + Number(day.count), 0);
      };

      await expect(total()).resolves.toBe(2);
      await expect(total(factory.uuid())).resolves.toBe(2);
      await expect(total(user.id)).resolves.toBe(3);
    });
  });
});

describe('HDR Develop deletion', () => {
  it('queues the complete rendition set atomically and retains it if release fails', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const paths = [
      '/hdr-delete/master.jpg',
      '/hdr-delete/preview.jpg',
      '/hdr-delete/master-hdr.jpg',
      '/hdr-delete/preview-hdr.jpg',
    ];
    await sql`INSERT INTO public.asset_develop_revision ("assetId", "ownerId", revision, recipe,
      "masterPath", "previewPath", "hdrMasterPath", "hdrPreviewPath", "hdrRenditionChecksum")
      VALUES (${asset.id}::uuid, ${user.id}::uuid, 1, ${{ version: 3 }}::jsonb,
        ${paths[0]}, ${paths[1]}, ${paths[2]}, ${paths[3]}, ${Buffer.alloc(32, 1)})`.execute(defaultDatabase);
    const files = ({ originalPath, derivedPaths }: { originalPath: string; derivedPaths: string[] }) => [
      originalPath,
      ...derivedPaths,
    ];
    await expect(
      sut.remove({ id: asset.id }, { files, queue: () => Promise.reject(new Error('queue unavailable')) }),
    ).rejects.toThrow('queue unavailable');
    expect(
      (
        await sql`SELECT 1 FROM public.asset_develop_revision WHERE "assetId"=${asset.id}::uuid`.execute(
          defaultDatabase,
        )
      ).rows,
    ).toHaveLength(1);
    expect(await sut.getById(asset.id)).toBeDefined();
    const queue = vi.fn().mockResolvedValue(undefined);
    await sut.remove({ id: asset.id }, { files, queue });
    expect(queue).toHaveBeenCalledWith(expect.arrayContaining(paths));
    expect(
      (
        await sql`SELECT 1 FROM public.asset_develop_revision WHERE "assetId"=${asset.id}::uuid`.execute(
          defaultDatabase,
        )
      ).rows,
    ).toHaveLength(0);
  });
});
