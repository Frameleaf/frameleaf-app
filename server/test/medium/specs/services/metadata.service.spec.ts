import { createPostgres } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { Stats } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { ExifResponseSchema, mapExif } from 'src/dtos/exif.dto.js';
import { AssetFileType, JobStatus } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB, newRandomImage } from 'test/utils.js';

type TimeZoneTest = {
  description: string;
  serverTimeZone?: string;
  exifData: Record<string, any>;
  expected: {
    localDateTime: string;
    dateTimeOriginal: string;
    timeZone: string | null;
  };
};

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(MetadataService, {
    database: db || defaultDatabase,
    real: [
      AssetRepository,
      AssetJobRepository,
      ConfigRepository,
      MetadataRepository,
      SystemMetadataRepository,
      TagRepository,
    ],
    mock: [EventRepository, StorageRepository, LoggingRepository, MapRepository],
  });

  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx
    .getMock(MapRepository)
    .reverseGeocode.mockResolvedValue({ country: 'File country', state: 'File state', city: 'File city' });
  ctx.getMock(StorageRepository).stat.mockResolvedValue({
    size: 123_456,
    mtime: new Date(654_321),
    mtimeMs: 654_321,
    birthtimeMs: 654_322,
  } as Stats);

  return { sut, ctx };
};

const createTestFile = async (exifData: Record<string, any>) => {
  const { ctx } = setup();
  const data = newRandomImage();
  const filePath = join(tmpdir(), 'test.png');
  await writeFile(filePath, data);
  await ctx.get(MetadataRepository).writeTags(filePath, exifData);
  return { filePath };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(MetadataService.name, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should be defined', () => {
    const { sut } = setup();
    expect(sut).toBeDefined();
  });

  describe('handleMetadataExtraction', () => {
    it('extracts a real metadata-free synthetic JPEG using local JPEGDigest', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: resolve('test/fixtures/camera-metadata/synthetic.jpg'),
      });
      await sut.handleMetadataExtraction({ id: asset.id });
      const evidence = (await ctx.get(AssetRepository).getMetadata(asset.id)).find(
        (item) => item.key === 'camera-identification',
      )?.value;
      expect(evidence).toMatchObject({
        version: 1,
        recorded: null,
        alternatives: [],
        suggestion: {
          method: 'jpeg-signature',
          signature: expect.stringMatching(/^[a-f0-9]{32}/),
          matches: expect.stringContaining('Independent JPEG Group'),
        },
      });
      expect(
        await ctx.database
          .selectFrom('asset_exif')
          .select(['make', 'model'])
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ make: null, model: null });
    });

    it.each([false, true])('roundtrips rejected XMP ratings and respects a catalog lock: %s', async (locked) => {
      const { sut, ctx } = setup();
      const { filePath } = await createTestFile({ Rating: -1 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: filePath });
      if (locked) {
        await ctx.newExif({ assetId: asset.id, rating: 4, lockedProperties: ['rating'] });
      }
      await sut.handleMetadataExtraction({ id: asset.id });
      const exif = await ctx.database
        .selectFrom('asset_exif')
        .selectAll()
        .where('assetId', '=', asset.id)
        .executeTakeFirstOrThrow();
      expect(exif.rating).toBe(locked ? 4 : -1);
      expect(ExifResponseSchema.parse(mapExif(exif))).toMatchObject({ rating: locked ? 4 : null, isRejected: !locked });
    });

    it.each([true, false, null])(
      'keeps newer sidecar values after an unlock (initially locked: %s)',
      async (initiallyLocked) => {
        const { sut, ctx } = setup();
        ctx.getMock(EventRepository).emit.mockResolvedValue();
        const { filePath } = await createTestFile({ Rating: 1 });
        const dir = await mkdtemp(join(tmpdir(), 'fl202-sidecar-'));
        const sidecarPath = join(dir, 'metadata.xmp');
        const metadata = ctx.get(MetadataRepository);
        await metadata.writeTags(sidecarPath, { Rating: 1, GPSLatitude: 1, GPSLongitude: 2 });
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
        const repository = ctx.get(AssetRepository);
        await repository.upsertFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: sidecarPath });
        const properties = ['rating', 'latitude', 'longitude'] as const;
        // null starts without an EXIF row, to cover an edit inserting it during the file read.
        if (initiallyLocked !== null) {
          await ctx.newExif({
            assetId: asset.id,
            rating: initiallyLocked ? 5 : 1,
            latitude: 50,
            longitude: -110,
            city: 'Stored city',
            state: 'Stored state',
            country: 'Stored country',
            lockedProperties: initiallyLocked ? [...properties] : null,
          });
        }
        const readTags = metadata.readTags.bind(metadata);
        const read = vi.spyOn(metadata, 'readTags').mockImplementation(async (path) => {
          const staleTags = await readTags(path);
          if (path === sidecarPath) {
            // Finish a sidecar write after extraction has read the old file but before it applies it.
            // Starting unlocked also proves a locked-property snapshot alone cannot close this race.
            if (!initiallyLocked) {
              await repository.upsertExif({
                exif: {
                  assetId: asset.id,
                  rating: 5,
                  latitude: 50,
                  longitude: -110,
                  city: 'Stored city',
                  state: 'Stored state',
                  country: 'Stored country',
                  lockedProperties: [...properties],
                },
                lockedPropertiesBehavior: 'append',
              });
            }
            await metadata.writeTags(sidecarPath, { Rating: 5, GPSLatitude: 50, GPSLongitude: -110 });
            await repository.unlockProperties(asset.id, [...properties]);
          }
          return staleTags;
        });
        try {
          await sut.handleMetadataExtraction({ id: asset.id });
        } finally {
          read.mockRestore();
        }
        await expect(
          ctx.database
            .selectFrom('asset_exif')
            .select(['rating', 'latitude', 'longitude', 'city', 'state', 'country', 'lockedProperties'])
            .where('assetId', '=', asset.id)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({
          rating: 5,
          latitude: 50,
          longitude: -110,
          city: 'Stored city',
          state: 'Stored state',
          country: 'Stored country',
          lockedProperties: null,
        });
      },
    );

    it.each([true, false, null])(
      'applies an unchanged EXIF revision while respecting locks (locked: %s)',
      async (locked) => {
        const { sut, ctx } = setup();
        ctx.getMock(EventRepository).emit.mockResolvedValue();
        const { filePath } = await createTestFile({ Rating: 1 });
        const { user } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
        if (locked !== null) {
          await ctx.newExif({ assetId: asset.id, rating: 5, lockedProperties: locked ? ['rating'] : null });
        }
        await sut.handleMetadataExtraction({ id: asset.id });
        await expect(
          ctx.database
            .selectFrom('asset_exif')
            .select('rating')
            .where('assetId', '=', asset.id)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({ rating: locked ? 5 : 1 });
      },
    );

    it('keeps newer values when a sidecar is created after the asset file list is fetched', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ Rating: 1 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, rating: 5, lockedProperties: ['rating'] });
      const repository = ctx.get(AssetRepository);
      const jobs = ctx.get(AssetJobRepository);
      const getAsset = jobs.getForMetadataExtraction.bind(jobs);
      const fetch = vi.spyOn(jobs, 'getForMetadataExtraction').mockImplementation(async (id) => {
        const staleAsset = await getAsset(id);
        const dir = await mkdtemp(join(tmpdir(), 'fl202-new-sidecar-'));
        const path = join(dir, 'metadata.xmp');
        await ctx.get(MetadataRepository).writeTags(path, { Rating: 5 });
        await repository.upsertFile({ assetId: id, type: AssetFileType.Sidecar, path });
        await repository.unlockProperties(id, ['rating']);
        return staleAsset;
      });
      try {
        await sut.handleMetadataExtraction({ id: asset.id });
      } finally {
        fetch.mockRestore();
      }
      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('rating')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ rating: 5 });
    });

    const timeZoneTests: TimeZoneTest[] = [
      {
        description: 'should handle no time zone information',
        exifData: {
          DateTimeOriginal: '2022:01:01 00:00:00',
        },
        expected: {
          localDateTime: '2022-01-01T00:00:00.000Z',
          dateTimeOriginal: '2022-01-01T00:00:00.000Z',
          timeZone: null,
        },
      },
      {
        description: 'should handle a +13:00 time zone',
        exifData: {
          DateTimeOriginal: '2022:01:01 00:00:00+13:00',
        },
        expected: {
          localDateTime: '2022-01-01T00:00:00.000Z',
          dateTimeOriginal: '2021-12-31T11:00:00.000Z',
          timeZone: 'UTC+13',
        },
      },
    ];

    it.each(timeZoneTests)('$description', async ({ exifData, serverTimeZone, expected }) => {
      vi.stubEnv('TZ', serverTimeZone);

      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile(exifData);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select(['dateTimeOriginal', 'timeZone', 'lockedProperties'])
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        dateTimeOriginal: new Date(expected.dateTimeOriginal),
        timeZone: expected.timeZone,
        lockedProperties: null,
      });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ localDateTime: new Date(expected.localDateTime) }),
      );
    });

    it('should handle dates far in the future', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ CreateDate: '42603:05:04 04:12:48' });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .where('assetId', '=', asset.id)
          .select('dateTimeOriginal')
          .executeTakeFirstOrThrow(),
        // note that this date is technically wrong. it does not throw though and should get the user's attention either way.
      ).resolves.toEqual({ dateTimeOriginal: new Date('4260-03-05T04:04:12.000Z') });
    });

    it('should ignore IFD1 thumbnail orientation when extracting metadata', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ 'IFD1:Orientation#': 6 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('orientation')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ orientation: null });
    });

    it('should ignore IFD1 thumbnail dimensions when extracting metadata', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ 'IFD1:ImageWidth#': 160, 'IFD1:ImageHeight#': 120 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ width: 1, height: 1 }),
      );
    });

    it('should keep IFD0 orientation when extracting metadata', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const { filePath } = await createTestFile({ 'IFD0:Orientation#': 6 });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });

      await sut.handleMetadataExtraction({ id: asset.id });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('orientation')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ orientation: '6' });
    });
  });

  it('should handle float lens models (#30492)', async () => {
    const { sut, ctx } = setup();
    ctx.getMock(EventRepository).emit.mockResolvedValue();
    const { filePath } = await createTestFile({ LensModel: 1.8 });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ originalPath: filePath, ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, description: '' });

    await sut.handleMetadataExtraction({ id: asset.id });

    await expect(
      ctx.database
        .selectFrom('asset_exif')
        .where('assetId', '=', asset.id)
        .select('lensModel')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ lensModel: '1.8' });
  });
});

describe('sidecar writes (FL-195)', () => {
  it('finish with the sidecar queue as wide as the connection pool', async () => {
    // Each holder of the per-asset sidecar lock runs its queries on the lock's own connection. Had it
    // needed a second one, two writes on a two-connection pool would wait for each other forever.
    const suffix = `fl195_${Math.random().toString(36).slice(2, 7)}`;
    const clone = await getKyselyDB(suffix);
    let database: string;
    try {
      database = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(clone)).rows[0].name;
    } finally {
      await clone.destroy();
    }
    const url = canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, database);
    const narrow = new Kysely<DB>({
      dialect: new PostgresJSDialect({
        postgres: createPostgres({ maxConnections: 2, connection: { connectionType: 'url', url } }),
      }),
    });
    try {
      // the storage core is a singleton; an earlier test's may hold another mock storage repository
      StorageCore.reset();
      const { sut, ctx } = newMediumService(MetadataService, {
        database: narrow,
        real: [AssetRepository, AssetJobRepository, DatabaseRepository, MetadataRepository, PhysicalFileRepository],
        mock: [EventRepository, StorageRepository, LoggingRepository],
      });
      ctx.getMock(StorageRepository).mkdirSync.mockReturnValue(void 0);
      const dir = await mkdtemp(join(tmpdir(), 'fl195-sidecar-'));
      const { user } = await ctx.newUser();
      const ids: string[] = [];
      for (let index = 0; index < 3; index++) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: join(dir, `${index}.png`) });
        await ctx.newExif({
          assetId: asset.id,
          latitude: 12,
          longitude: 12,
          lockedProperties: ['latitude', 'longitude'],
        });
        ids.push(asset.id);
      }

      // two writes of one asset and one each of two others, on two connections
      const jobs = Promise.all([ids[0], ids[0], ids[1], ids[2]].map((id) => sut.handleSidecarWrite({ id })));
      let timer: NodeJS.Timeout | undefined;
      const stuck = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('sidecar writes deadlocked')), 20_000);
      });
      const results = await Promise.race([jobs, stuck]).finally(() => clearTimeout(timer));
      // the second write of the same asset finds nothing left locked to write
      expect(results.toSorted()).toEqual([JobStatus.Skipped, JobStatus.Success, JobStatus.Success, JobStatus.Success]);
    } finally {
      await narrow.destroy();
    }
  }, 60_000);
});
