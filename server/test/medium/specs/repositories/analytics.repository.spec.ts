import { Kysely } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AlbumUserRole,
  AnalyticsSampleGrain,
  AnalyticsScopeKind,
  AnalyticsSeriesId,
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
