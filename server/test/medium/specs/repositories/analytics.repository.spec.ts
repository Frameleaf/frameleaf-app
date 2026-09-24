import { Kysely } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AlbumUserRole,
  AnalyticsSampleGrain,
  AnalyticsScopeKind,
  AnalyticsSeriesId,
  AssetLockReason,
  AssetType,
  AssetVisibility,
  MlDestinationKind,
  MlWorkload,
  PhysicalFileType,
} from 'src/enum.js';
import { AnalyticsRepository } from 'src/repositories/analytics.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { AnalyticsSampleInsert } from 'src/utils/analytics.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Scoped analytics aggregation (FL-79) against a real schema: shared physical references, external
 * library bytes, trashed, deleted, Locked and Live Photo items, days, albums, processing and the
 * collector's retention. Each test gets its own database so whole-server totals are exact.
 */

const setup = async () => {
  const db = await getKyselyDB();
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { db, ctx, sut: new AnalyticsRepository(db) };
};

const newSizedAsset = async (
  ctx: MediumTestContext,
  ownerId: string,
  size: number | null,
  dto: Record<string, unknown> = {},
) => {
  const { asset } = await ctx.newAsset({ ownerId, originalPath: `/data/upload/${randomUUID()}.jpg`, ...dto });
  await ctx.newExif({ assetId: asset.id, fileSizeInByte: size });
  return asset;
};

const sharePhysicalFile = async (db: Kysely<DB>, assetIds: string[], sizeInBytes: number) => {
  const file = await db
    .insertInto('physical_file')
    .values({
      type: PhysicalFileType.Original,
      checksum: randomBytes(32),
      sizeInBytes,
      path: `/data/physical/${randomUUID()}`,
      canonicalAssetId: assetIds[0],
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db.updateTable('asset').set({ physicalOriginalFileId: file.id }).where('id', 'in', assetIds).execute();
  return file.id;
};

const newLibrary = async (db: Kysely<DB>, ownerId: string) =>
  db
    .insertInto('library')
    .values({ name: 'Archive', ownerId, importPaths: ['/mnt/archive'], exclusionPatterns: [] })
    .returning('id')
    .executeTakeFirstOrThrow();

const host = { kind: AnalyticsScopeKind.Host } as const;
const account = (userId: string) => ({ kind: AnalyticsScopeKind.Account, userId }) as const;
const library = (libraryId: string) => ({ kind: AnalyticsScopeKind.Library, libraryId }) as const;

describe(AnalyticsRepository.name, () => {
  it('counts a shared original once per selection and never divides it between accounts', async () => {
    const { db, ctx, sut } = await setup();
    const { user: taylor } = await ctx.newUser();
    const { user: jamie } = await ctx.newUser();
    const first = await newSizedAsset(ctx, taylor.id, 1000);
    const second = await newSizedAsset(ctx, taylor.id, 1000);
    await newSizedAsset(ctx, taylor.id, 500);
    const jamieCopy = await newSizedAsset(ctx, jamie.id, 1000);
    await sharePhysicalFile(db, [first.id, second.id, jamieCopy.id], 1000);

    await expect(sut.getInventory(account(taylor.id))).resolves.toMatchObject({ photos: 3, logicalBytes: 2500 });
    await expect(sut.getPhysical(account(taylor.id))).resolves.toEqual({
      physicalBytes: 1500,
      uploadedPhysicalBytes: 1500,
      externalPhysicalBytes: 0,
      sharedReferences: 2,
    });
    await expect(sut.getPhysical(account(jamie.id))).resolves.toMatchObject({
      physicalBytes: 1000,
      sharedReferences: 0,
    });
    await expect(sut.getInventory(host)).resolves.toMatchObject({ photos: 4, logicalBytes: 3500 });
    await expect(sut.getPhysical(host)).resolves.toMatchObject({ physicalBytes: 1500, sharedReferences: 3 });

    const snapshot = await sut.getCollectorSnapshot();
    expect(snapshot.find((row) => row.kind === AnalyticsScopeKind.Host)).toMatchObject({
      items: 4,
      logicalBytes: 3500,
      physicalBytes: 1500,
    });
    expect(snapshot.find((row) => row.id === taylor.id)).toMatchObject({
      kind: AnalyticsScopeKind.Account,
      items: 3,
      logicalBytes: 2500,
      physicalBytes: 1500,
    });
    expect(snapshot.find((row) => row.id === jamie.id)).toMatchObject({ logicalBytes: 1000, physicalBytes: 1000 });
  });

  it('keeps external library bytes in the account and library, separate from uploaded bytes', async () => {
    const { db, ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    const { id: libraryId } = await newLibrary(db, user.id);
    await newSizedAsset(ctx, user.id, 700);
    await newSizedAsset(ctx, user.id, 3000, {
      libraryId,
      isExternal: true,
      originalPath: `/mnt/archive/${randomUUID()}.jpg`,
    });

    await expect(sut.getInventory(account(user.id))).resolves.toMatchObject({
      photos: 2,
      logicalBytes: 3700,
      uploadedLogicalBytes: 700,
      externalLogicalBytes: 3000,
    });
    await expect(sut.getPhysical(account(user.id))).resolves.toMatchObject({
      physicalBytes: 3700,
      uploadedPhysicalBytes: 700,
      externalPhysicalBytes: 3000,
    });
    await expect(sut.getInventory(library(libraryId))).resolves.toMatchObject({
      photos: 1,
      logicalBytes: 3000,
      uploadedLogicalBytes: 0,
    });

    const snapshot = await sut.getCollectorSnapshot();
    expect(snapshot.find((row) => row.kind === AnalyticsScopeKind.Library && row.id === libraryId)).toMatchObject({
      items: 1,
      logicalBytes: 3000,
      physicalBytes: 3000,
    });
    // the uploads (no library) are not reported as a library of their own
    expect(snapshot.filter((row) => row.kind === AnalyticsScopeKind.Library)).toHaveLength(1);
  });

  it('counts trashed items, drops deleted ones, hides Locked media and counts Live Photo parts only as files', async () => {
    const { db, ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    await newSizedAsset(ctx, user.id, 100);
    await newSizedAsset(ctx, user.id, 200, { deletedAt: new Date() });
    await newSizedAsset(ctx, user.id, 300, { visibility: AssetVisibility.Archive, isFavorite: true });
    await newSizedAsset(ctx, user.id, 400, { visibility: AssetVisibility.Locked });
    await newSizedAsset(ctx, user.id, 50, { type: AssetType.Video, visibility: AssetVisibility.Hidden });
    const gone = await newSizedAsset(ctx, user.id, 999);
    await db.deleteFrom('asset').where('id', '=', gone.id).execute();
    await newSizedAsset(ctx, user.id, null);

    const inventory = await sut.getInventory(account(user.id));
    expect(inventory).toMatchObject({
      photos: 4,
      videos: 0,
      timelinePhotos: 2,
      archivePhotos: 1,
      trashPhotos: 1,
      favoritePhotos: 1,
      files: 5,
      unmeasuredFiles: 1,
      logicalBytes: 650,
    });
    expect(inventory.timelinePhotos + inventory.archivePhotos + inventory.trashPhotos).toBe(inventory.photos);
    await expect(sut.getPhysical(account(user.id))).resolves.toMatchObject({ physicalBytes: 650 });
  });

  it('groups arrivals by the UTC day added and captures by the local date taken', async () => {
    const { ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    await newSizedAsset(ctx, user.id, 1, {
      createdAt: new Date('2026-09-18T23:30:00.000Z'),
      localDateTime: new Date('2026-07-04T10:00:00.000Z'),
    });
    await newSizedAsset(ctx, user.id, 1, {
      type: AssetType.Video,
      createdAt: new Date('2026-09-18T01:00:00.000Z'),
      localDateTime: new Date('2026-07-04T22:00:00.000Z'),
    });
    await newSizedAsset(ctx, user.id, 1, {
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      localDateTime: new Date('2026-09-20T00:00:00.000Z'),
    });

    await expect(sut.getArrivalsByDay(account(user.id), '2026-06-22', '2026-09-19')).resolves.toEqual([
      { day: '2026-09-18', photos: 1, videos: 1 },
    ]);
    await expect(sut.getCapturesByDay(account(user.id), '2026-06-22', '2026-09-19')).resolves.toEqual([
      { day: '2026-07-04', items: 2 },
    ]);
  });

  it('reads albums in scope and whether the viewer may see each one', async () => {
    const { ctx, sut } = await setup();
    const { user: taylor } = await ctx.newUser();
    const { user: jamie } = await ctx.newUser();
    const asset = await newSizedAsset(ctx, taylor.id, 1);
    const { album: owned } = await ctx.newAlbum({ ownerId: taylor.id, albumName: 'Rockies' }, [asset.id]);
    const { album: theirs } = await ctx.newAlbum({ ownerId: jamie.id, albumName: 'Trails' });
    await ctx.newAlbumUser({ albumId: theirs.id, userId: taylor.id, role: AlbumUserRole.Viewer });
    await ctx.newAlbum({ ownerId: jamie.id, albumName: 'Private' });

    const rows = await sut.getAlbums(account(taylor.id), taylor.id);
    expect(rows.map((row) => row.name).toSorted()).toEqual(['Rockies', 'Trails']);
    expect(rows.find((row) => row.id === theirs.id)).toMatchObject({
      ownerId: jamie.id,
      members: 1,
      viewerHasAccess: true,
    });
    expect(rows.find((row) => row.id === owned.id)).toMatchObject({ members: 0 });

    const all = await sut.getAlbums(host, taylor.id);
    expect(all).toHaveLength(3);
    expect(all.find((row) => row.name === 'Private')?.viewerHasAccess).toBe(false);
  });

  it('derives library album membership only from unlocked assets', async () => {
    const { db, ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    const { id: libraryId } = await newLibrary(db, user.id);
    const locked = await newSizedAsset(ctx, user.id, 100, { libraryId });
    await db
      .insertInto('asset_lock')
      .values({
        assetId: locked.id,
        reason: AssetLockReason.Marked,
        lockedBy: user.id,
      })
      .execute();
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Private collection' }, [locked.id]);
    await expect(sut.getInventory(library(libraryId))).resolves.toMatchObject({ photos: 0 });
    await expect(sut.getAlbums(library(libraryId), user.id)).resolves.toEqual([]);
    const visible = await newSizedAsset(ctx, user.id, 200, { libraryId });
    await db.insertInto('album_asset').values({ albumId: album.id, assetId: visible.id }).execute();
    await expect(sut.getAlbums(library(libraryId), user.id)).resolves.toEqual([
      expect.objectContaining({ id: album.id, name: 'Private collection' }),
    ]);
  });

  it('reads processing outcomes and costs per day, costed attempts only', async () => {
    const { db, sut } = await setup();
    const row = (outcome: 'success' | 'failure', startedAt: string, costUsd: number | null) => ({
      destinationId: null,
      destinationKind: MlDestinationKind.Local,
      workload: MlWorkload.Clip,
      jobId: null,
      jobName: null,
      durationMs: 100,
      outcome,
      costUsd,
      startedAt: new Date(startedAt),
      finishedAt: new Date(startedAt),
    });
    await db
      .insertInto('ml_workload_accounting')
      .values([
        row('success', '2026-09-18T10:00:00.000Z', 0.01),
        row('success', '2026-09-18T11:00:00.000Z', null),
        row('failure', '2026-09-18T12:00:00.000Z', 0.02),
        row('success', '2026-06-01T12:00:00.000Z', 1),
      ])
      .execute();

    const days = await sut.getProcessingByDay('2026-06-22', '2026-09-19');
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ day: '2026-09-18', completed: 2, failed: 1, durationMs: 300, costed: 2 });
    expect(days[0].costUsd).toBeCloseTo(0.03);
  });

  describe('collector storage', () => {
    const at = (iso: string) => new Date(iso);
    const daySample = (value: number, bucket: string, overrides: Partial<AnalyticsSampleInsert> = {}) => ({
      series: AnalyticsSeriesId.LibraryItems,
      scopeKey: 'host',
      userId: null,
      libraryId: null,
      grain: AnalyticsSampleGrain.Day,
      bucketStart: at(`${bucket}T00:00:00.000Z`),
      value,
      observedAt: at(`${bucket}T00:05:00.000Z`),
      ...overrides,
    });

    it('rewrites a day on a second run instead of adding a row', async () => {
      const { db, sut } = await setup();
      await sut.upsertSamples([daySample(10, '2026-09-18')]);
      await sut.upsertSamples([daySample(12, '2026-09-18', { observedAt: at('2026-09-18T06:00:00.000Z') })]);
      const rows = await db.selectFrom('operational_metric_sample').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].value)).toBe(12);
      await expect(sut.getLatestObservation('host')).resolves.toEqual(at('2026-09-18T06:00:00.000Z'));
    });

    it('refuses samples that are not approved before writing anything', async () => {
      const { db, sut } = await setup();
      await expect(
        sut.upsertSamples([daySample(1, '2026-09-18'), daySample(1, '2026-09-18', { scopeKey: 'account:Taylor' })]),
      ).rejects.toThrow();
      await expect(db.selectFrom('operational_metric_sample').selectAll().execute()).resolves.toHaveLength(0);
    });

    it('downsamples old days to the newest reading of each week, then expires old weeks, idempotently', async () => {
      const { db, sut } = await setup();
      await sut.upsertSamples([
        // Monday 2026-01-05 week: two readings, the later one wins
        daySample(100, '2026-01-05'),
        daySample(90, '2026-01-07'),
        // the following week
        daySample(110, '2026-01-12'),
        // recent: stays a day row
        daySample(200, '2026-09-18'),
        // a week row so old it expires
        daySample(5, '2023-01-02', { grain: AnalyticsSampleGrain.Week }),
      ]);

      const dayCutoff = at('2026-05-22T00:00:00.000Z');
      const weekCutoff = at('2024-07-11T00:00:00.000Z');
      await sut.applyRetention(dayCutoff, weekCutoff);
      const read = () =>
        db
          .selectFrom('operational_metric_sample')
          .select(['grain', 'bucketStart', 'value'])
          .orderBy('bucketStart')
          .execute()
          .then((rows) =>
            rows.map((row) => ({
              grain: row.grain,
              bucketStart: new Date(row.bucketStart).toISOString().slice(0, 10),
              value: Number(row.value),
            })),
          );
      const first = await read();
      expect(first).toEqual([
        { grain: AnalyticsSampleGrain.Week, bucketStart: '2026-01-05', value: 90 },
        { grain: AnalyticsSampleGrain.Week, bucketStart: '2026-01-12', value: 110 },
        { grain: AnalyticsSampleGrain.Day, bucketStart: '2026-09-18', value: 200 },
      ]);

      await sut.applyRetention(dayCutoff, weekCutoff);
      await expect(read()).resolves.toEqual(first);
    });

    it('removes an account’s history with the account', async () => {
      const { db, ctx, sut } = await setup();
      const { user } = await ctx.newUser();
      await sut.upsertSamples([daySample(3, '2026-09-18', { scopeKey: `account:${user.id}`, userId: user.id })]);
      await db.deleteFrom('user').where('id', '=', user.id).execute();
      await expect(db.selectFrom('operational_metric_sample').selectAll().execute()).resolves.toHaveLength(0);
    });
  });
});

describe('AnalyticsRepository.getInsights (FL-79)', () => {
  const noNames = { ownerId: null, suppressedPersonIds: [], suppressedPetIds: [] };
  const total = (rows: Array<{ count: number }>) => rows.reduce((sum, { count }) => sum + count, 0);

  const newItem = async (
    ctx: MediumTestContext,
    ownerId: string,
    asset: Record<string, unknown>,
    exif: Record<string, unknown> = {},
  ) => {
    const { asset: created } = await ctx.newAsset({ ownerId, ...asset });
    await ctx.newExif({ assetId: created.id, make: 'Canon', ...exif });
    return created;
  };

  const library = async (ctx: MediumTestContext, db: Kysely<DB>, ownerId: string) => {
    const at = (value: string) => new Date(value);
    const heic = await newItem(
      ctx,
      ownerId,
      { originalFileName: 'IMG_1.HEIC', localDateTime: at('2009-06-14T08:30:00Z'), width: 4032, height: 3024 },
      { lensModel: 'iPhone 13mm', focalLength: 1.5, city: 'Banff', country: 'Canada', latitude: 51, longitude: -115 },
    );
    await newItem(
      ctx,
      ownerId,
      { originalFileName: 'IMG_2.jpg', localDateTime: at('2024-03-02T17:10:00Z'), width: 3000, height: 4000 },
      { lensModel: 'RF 70-200mm', focalLength: 135, city: 'Banff', country: 'Canada', fileSizeInByte: 9_000_000 },
    );
    await newItem(
      ctx,
      ownerId,
      { originalFileName: 'DSC_3.CR3', localDateTime: at('2024-03-02T17:40:00Z'), width: 8000, height: 2000 },
      { focalLength: 400, city: 'Lisbon', country: 'Portugal' },
    );
    const motion = await newItem(ctx, ownerId, {
      type: AssetType.Video,
      visibility: AssetVisibility.Hidden,
      originalFileName: 'IMG_1.MOV',
      localDateTime: at('2009-06-14T08:30:00Z'),
    });
    await db.updateTable('asset').set({ livePhotoVideoId: motion.id }).where('id', '=', heic.id).execute();
    const video = await newItem(
      ctx,
      ownerId,
      {
        type: AssetType.Video,
        originalFileName: 'clip.mov',
        localDateTime: at('2025-12-31T23:00:00Z'),
        width: 3840,
        height: 2160,
        duration: 5_400_000,
      },
      { fileSizeInByte: 1000 },
    );
    await db
      .insertInto('asset_video')
      .values({
        assetId: video.id,
        bitrate: 1,
        frameCount: 1,
        timeBase: 1,
        index: 0,
        colorPrimaries: 9,
        colorTransfer: 16,
        colorMatrix: 9,
        dvProfile: 8,
        codecName: 'hevc',
        formatName: 'mov',
        formatLongName: 'QuickTime',
        pixelFormat: 'yuv420p10le',
      })
      .execute();
    // a trashed video still counts as an item, with unknown resolution
    await newItem(ctx, ownerId, {
      type: AssetType.Video,
      originalFileName: 'old.mp4',
      localDateTime: at('2024-07-01T12:00:00Z'),
      deletedAt: at('2026-01-01T00:00:00Z'),
    });
    // Locked media never counts anywhere
    await newItem(
      ctx,
      ownerId,
      { visibility: AssetVisibility.Locked, originalFileName: 'secret.jpg', localDateTime: at('1990-01-01T00:00:00Z') },
      { lensModel: 'Secret lens', city: 'Hidden City', fileSizeInByte: 99_000_000 },
    );
    return { heic };
  };

  it('partitions the same items as the summary and reads no names for another reader', async () => {
    const { db, ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    await library(ctx, db, user.id);

    const scope = account(user.id);
    const [inventory, insights] = await Promise.all([sut.getInventory(scope), sut.getInsights(scope, noNames)]);
    const items = inventory.photos + inventory.videos;
    expect(items).toBe(5);

    expect(insights.years).toEqual([
      { year: 2009, count: 1 },
      { year: 2024, count: 3 },
      { year: 2025, count: 1 },
    ]);
    expect(total(insights.punchcard)).toBe(items);
    // 2024-03-02 was a Saturday; both photos were taken at 17:xx local time
    expect(insights.punchcard).toContainEqual({ weekday: 6, hour: 17, count: 2 });
    expect(total(insights.lenses)).toBe(items);
    expect(insights.lenses).not.toContainEqual(expect.objectContaining({ name: 'Secret lens' }));
    expect(total(insights.focalLengths)).toBe(items);
    expect(insights.focalLengths).toEqual(
      expect.arrayContaining([
        { bucket: '0-16', count: 1 },
        { bucket: '71-135', count: 1 },
        { bucket: '301+', count: 1 },
        { bucket: 'unknown', count: 2 },
      ]),
    );
    expect(total(insights.photoFormats)).toBe(inventory.photos);
    expect(insights.photoFormats.find(({ format }) => format === 'RAW')?.count).toBe(inventory.raw);
    expect(insights.photoFormats).toEqual(
      expect.arrayContaining([
        { format: 'HEIC', count: 1 },
        { format: 'JPEG', count: 1 },
        { format: 'RAW', count: 1 },
      ]),
    );
    expect(total(insights.videoResolutions)).toBe(inventory.videos);
    expect(insights.videoResolutions).toEqual(
      expect.arrayContaining([
        { resolution: '4K', count: 1 },
        { resolution: 'unknown', count: 1 },
      ]),
    );
    expect(total(insights.orientation)).toBe(items);
    expect(insights.orientation).toEqual(
      expect.arrayContaining([
        { orientation: 'landscape', count: 2 },
        { orientation: 'portrait', count: 1 },
        { orientation: 'panorama', count: 1 },
        { orientation: 'unknown', count: 1 },
      ]),
    );
    expect(insights.livePhotos).toBe(1);
    expect(insights.hdr).toEqual({ probedVideos: 1, hdrVideos: 1, dolbyVisionVideos: 1 });
    expect(insights.records).toEqual({
      oldest: { localDateTime: new Date('2009-06-14T08:30:00.000Z'), name: '' },
      largest: { bytes: 9_000_000, name: '' },
      longest: { durationMs: 5_400_000, name: '' },
      videoDurationMs: 5_400_000,
    });
    expect(insights.people).toBeNull();
    expect(JSON.stringify(insights)).not.toMatch(/IMG_|clip\.mov|secret/);
  });

  it("reads the owner's people and places, never a Locked or hidden one", async () => {
    const { db, ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { heic } = await library(ctx, db, user.id);

    const { person: emma } = await ctx.newPerson({ ownerId: user.id, name: 'Emma' });
    const { person: kept } = await ctx.newPerson({ ownerId: user.id, name: 'Kept Private' });
    const { person: hidden } = await ctx.newPerson({ ownerId: user.id, name: 'Hidden', isHidden: true });
    const { person: stranger } = await ctx.newPerson({ ownerId: other.id, name: 'Other Account' });
    for (const person of [emma, kept, hidden, stranger]) {
      await ctx.newAssetFace({ assetId: heic.id, personGroupId: person.personGroupId });
    }

    const scope = account(user.id);
    const insights = await sut.getInsights(scope, {
      ownerId: user.id,
      suppressedPersonIds: [kept.personGroupId],
      suppressedPetIds: [],
    });
    const people = insights.people!;
    expect(people).toMatchObject({ faces: 4, itemsWithFaces: 1, namedPeople: 1, pets: 0, geotagged: 1 });
    expect(people.topPeople).toEqual([{ id: emma.personGroupId, name: 'Emma', count: 1 }]);
    expect(people.countries).toBe(2);
    expect(people.cities).toBe(2);
    expect(total(people.places)).toBe(5);
    expect(people.places).toEqual(
      expect.arrayContaining([
        { name: 'Banff', count: 2 },
        { name: 'Lisbon', count: 1 },
        { name: null, count: 2 },
      ]),
    );
    expect(insights.records.oldest?.name).toBe('IMG_1.HEIC');
    expect(JSON.stringify(insights)).not.toMatch(/Kept Private|Other Account|Hidden City|"Hidden"/);

    // the other account's own scope never sees this account's people
    const otherInsights = await sut.getInsights(account(other.id), {
      ownerId: other.id,
      suppressedPersonIds: [],
      suppressedPetIds: [],
    });
    expect(otherInsights.people?.topPeople).toEqual([]);
  });

  it('reads the whole server without names', async () => {
    const { db, ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    await library(ctx, db, user.id);
    await newItem(ctx, other.id, { originalFileName: 'x.png', localDateTime: new Date('2020-01-01T00:00:00Z') });

    const [inventory, insights] = await Promise.all([sut.getInventory(host), sut.getInsights(host, noNames)]);
    expect(inventory.photos + inventory.videos).toBe(6);
    expect(total(insights.years)).toBe(6);
    expect(insights.photoFormats).toContainEqual({ format: 'PNG', count: 1 });
    expect(insights.people).toBeNull();
  });

  it('never shows a locked session an item its hidden-content rules keep hidden', async () => {
    const { db, ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    await library(ctx, db, user.id);
    const secret = await newItem(
      ctx,
      user.id,
      { originalFileName: 'kept-private.jpg', localDateTime: new Date('2001-01-01T00:00:00Z') },
      { city: 'Private Town', country: 'Nowhere', fileSizeInByte: 50_000_000, lensModel: 'Private lens' },
    );
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Kept Private' });
    await ctx.newAssetFace({ assetId: secret.id, personGroupId: person.personGroupId });

    const scope = account(user.id);
    const hiddenContent = {
      userId: user.id,
      includeNsfw: false,
      personIds: [person.personGroupId],
      tagIds: [],
      petIds: [],
      scope: 'owned' as const,
    };
    const [inventory, unlocked, locked] = await Promise.all([
      sut.getInventory(scope),
      sut.getInsights(scope, { ownerId: user.id, suppressedPersonIds: [], suppressedPetIds: [] }),
      sut.getInsights(scope, {
        ownerId: user.id,
        suppressedPersonIds: [person.personGroupId],
        suppressedPetIds: [],
        privacy: { hiddenContent },
      }),
    ]);

    // unlocked, the item leads the records and the places
    expect(inventory.photos + inventory.videos).toBe(6);
    expect(unlocked.items).toBe(6);
    expect(unlocked.records.oldest?.name).toBe('kept-private.jpg');
    expect(unlocked.records.largest?.bytes).toBe(50_000_000);

    // locked, nothing about it is left, and every breakdown adds up to the items it may see
    expect(locked.items).toBe(5);
    expect(locked.records.oldest).toEqual({ localDateTime: new Date('2009-06-14T08:30:00.000Z'), name: 'IMG_1.HEIC' });
    expect(locked.records.largest).toEqual({ bytes: 9_000_000, name: 'IMG_2.jpg' });
    expect(locked.years).not.toContainEqual(expect.objectContaining({ year: 2001 }));
    expect(locked.people?.places).not.toContainEqual(expect.objectContaining({ name: 'Private Town' }));
    expect(locked.people?.countries).toBe(2);
    expect(locked.people?.faces).toBe(0);
    expect(JSON.stringify(locked)).not.toMatch(/kept-private|Private Town|Private lens|Nowhere|Kept Private/);
    for (const rows of [locked.years, locked.punchcard, locked.lenses, locked.focalLengths, locked.orientation]) {
      expect(total(rows)).toBe(locked.items);
    }
    expect(total(locked.people!.places)).toBe(locked.items);
  });

  it('reads coverage and cameras over the same visible items, never counting a hidden one', async () => {
    const { db, ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    const vector = `[${Array.from({ length: 512 }, (_, index) => (index === 0 ? 1 : 0)).join(',')}]`;
    const checked = await newItem(ctx, user.id, { originalFileName: 'a.jpg' }, { model: 'EOS R5' });
    const indexed = await newItem(ctx, user.id, { originalFileName: 'b.jpg' }, { model: 'EOS R5' });
    await newItem(ctx, user.id, { originalFileName: 'c.jpg' }, { make: null, model: null });
    const secret = await newItem(ctx, user.id, { originalFileName: 'secret.jpg' }, { model: 'Secret camera' });
    for (const asset of [checked, secret]) {
      await db.insertInto('asset_job_status').values({ assetId: asset.id, facesRecognizedAt: new Date() }).execute();
    }
    // a job status row that never ran face detection is not coverage
    await db.insertInto('asset_job_status').values({ assetId: indexed.id, facesRecognizedAt: null }).execute();
    for (const asset of [indexed, secret]) {
      await db.insertInto('smart_search').values({ assetId: asset.id, embedding: vector }).execute();
    }
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Kept Private' });
    await ctx.newAssetFace({ assetId: secret.id, personGroupId: person.personGroupId });
    const privacy = {
      hiddenContent: {
        userId: user.id,
        includeNsfw: false,
        personIds: [person.personGroupId],
        tagIds: [],
        petIds: [],
        scope: 'owned' as const,
      },
    };

    const scope = account(user.id);
    const [unlocked, locked, allCameras, visibleCameras] = await Promise.all([
      sut.getInsights(scope, noNames),
      sut.getInsights(scope, { ...noNames, privacy }),
      sut.getCameras(scope),
      sut.getCameras(scope, privacy),
    ]);
    expect(unlocked.coverage).toEqual({ facesChecked: 2, searchIndexed: 2 });
    expect(locked.items).toBe(3);
    expect(locked.coverage).toEqual({ facesChecked: 1, searchIndexed: 1 });

    const cameraTotal = (rows: Array<{ items: number }>) => rows.reduce((sum, row) => sum + row.items, 0);
    expect(cameraTotal(allCameras)).toBe(unlocked.items);
    // cameras add up to the same items as every other breakdown, and name nothing hidden
    expect(cameraTotal(visibleCameras)).toBe(locked.items);
    expect(visibleCameras).not.toContainEqual(expect.objectContaining({ model: 'Secret camera' }));
  });
});

describe('AnalyticsRepository volume parts (FL-79)', () => {
  it('reads the database size and the newest generated-folder readings', async () => {
    const { sut } = await setup();
    await expect(sut.getDatabaseBytes()).resolves.toBeGreaterThan(0);
    const reading = (series: AnalyticsSeriesId, value: number, day: string): AnalyticsSampleInsert => ({
      series,
      scopeKey: 'host',
      userId: null,
      libraryId: null,
      grain: AnalyticsSampleGrain.Day,
      bucketStart: new Date(`${day}T00:00:00Z`),
      value,
      observedAt: new Date(`${day}T00:05:00Z`),
    });
    await sut.upsertSamples([
      reading(AnalyticsSeriesId.HostThumbnailBytes, 100, '2026-09-18'),
      reading(AnalyticsSeriesId.HostThumbnailBytes, 150, '2026-09-19'),
      reading(AnalyticsSeriesId.HostEncodedVideoBytes, 70, '2026-09-19'),
      reading(AnalyticsSeriesId.HostVolumeUsedBytes, 1000, '2026-09-19'),
    ]);
    const generated = await sut.getLatestHostSamples([
      AnalyticsSeriesId.HostThumbnailBytes,
      AnalyticsSeriesId.HostEncodedVideoBytes,
    ]);
    expect(generated.map(({ series, value }) => ({ series, value })).toSorted((a, b) => a.value - b.value)).toEqual([
      { series: AnalyticsSeriesId.HostEncodedVideoBytes, value: 70 },
      { series: AnalyticsSeriesId.HostThumbnailBytes, value: 150 },
    ]);
    // the volume readings stay what the default asks for
    expect((await sut.getLatestHostSamples()).map(({ series }) => series)).toEqual([
      AnalyticsSeriesId.HostVolumeUsedBytes,
    ]);
  });

  it('refuses generated-folder readings for anything but the whole server', async () => {
    const { ctx, sut } = await setup();
    const { user } = await ctx.newUser();
    await expect(
      sut.upsertSamples([
        {
          series: AnalyticsSeriesId.HostThumbnailBytes,
          scopeKey: `account:${user.id}`,
          userId: user.id,
          libraryId: null,
          grain: AnalyticsSampleGrain.Day,
          bucketStart: new Date('2026-09-19T00:00:00Z'),
          value: 1,
          observedAt: new Date('2026-09-19T00:05:00Z'),
        },
      ]),
    ).rejects.toThrow(/not defined for the account scope/);
  });
});
