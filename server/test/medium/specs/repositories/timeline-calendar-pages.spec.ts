import { Kysely, sql } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetOrder, AssetVisibility, TimeBucketDateType } from 'src/enum.js';
import { AssetRepository, TimeBucketItem } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
}, 600_000);
afterAll(async () => {
  await db?.destroy();
});

describe('bounded calendar pages', () => {
  it.each([AssetOrder.Asc, AssetOrder.Desc])(
    'seeks through equal timestamps and names without duplicates (%s)',
    async (order) => {
      const { ctx } = newMediumService(BaseService, {
        database: db,
        real: [AssetRepository],
        mock: [LoggingRepository],
      });
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const ids: string[] = [];
      for (let n = 0; n < 5; n++) {
        const { asset } = await ctx.newAsset({
          ownerId: user.id,
          originalFileName: 'same.jpg',
          fileCreatedAt: new Date('2024-01-15T12:00:00Z'),
          localDateTime: new Date('2024-01-15T12:00:00Z'),
          createdAt: new Date('2024-01-15T12:00:00Z'),
          visibility: AssetVisibility.Timeline,
        });
        await ctx.newExif({ assetId: asset.id, timeZone: 'UTC' });
        ids.push(asset.id);
      }
      const expected = ids.toSorted();
      if (order === AssetOrder.Desc) expected.reverse();
      const repository = ctx.get(AssetRepository);
      const options = { userIds: [user.id], visibility: AssetVisibility.Timeline, order };
      const summaries = await repository.getTimeBuckets(options, auth, { pageSize: 2 });
      expect(summaries).toEqual([
        {
          timeBucket: '2024-01-01',
          days: [{ day: 15, count: 5 }],
          count: 2,
          page: 0,
          after: null,
          firstAssetId: expected[0],
          lastAssetId: expected[1],
        },
        {
          timeBucket: '2024-01-01',
          days: [{ day: 15, count: 5 }],
          count: 2,
          page: 1,
          after: expected[1],
          firstAssetId: expected[2],
          lastAssetId: expected[3],
        },
        {
          timeBucket: '2024-01-01',
          days: [{ day: 15, count: 5 }],
          count: 1,
          page: 2,
          after: expected[3],
          firstAssetId: expected[4],
          lastAssetId: expected[4],
        },
      ]);
      expect(await repository.getTimeBuckets(options, auth, { pageSize: 2, locateAssetId: expected[3] })).toEqual([
        summaries[1],
      ]);
      expect(await repository.getTimeBuckets(options, auth, { pageSize: 2, locateAssetId: user.id })).toEqual([]);
      const read = async (page: { take: number; after?: string; before?: string }) =>
        JSON.parse((await repository.getTimeBucket('2024-01-01', options, auth, page)).assets);
      const first = await read({ take: 2 });
      expect(first.id).toEqual(expected.slice(0, 2));
      expect(first.startCursor).toBe(expected[0]);
      expect(first.endCursor).toBe(expected[1]);
      const second = await read({ take: 2, after: first.endCursor });
      expect(second.id).toEqual(expected.slice(2, 4));
      const last = await read({ take: 2, after: second.endCursor });
      expect(last.id).toEqual(expected.slice(4));
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [expected[0], expected[4]]);
      const withMembership = JSON.parse(
        (
          await repository.getTimeBucket('2024-01-01', options, auth, {
            take: 2,
            membershipAlbumId: album.id,
          })
        ).assets,
      );
      expect(withMembership.id).toEqual(first.id);
      expect(withMembership.inAlbum).toEqual([true, false]);
      expect((await read({ take: 2, after: last.endCursor })).id).toEqual([]);
      expect((await read({ take: 2, before: second.startCursor })).id).toEqual(first.id);
      expect((await repository.getTimeBucket('2024-01-01', options, auth)).assets).not.toContain('startCursor');

      const foreign = await ctx.newUser();
      await expect(
        repository.getTimeBucket('2024-01-01', { ...options, userIds: [foreign.user.id] }, auth, {
          take: 2,
          after: first.endCursor,
        }),
      ).rejects.toThrow('Calendar page changed');
      await expect(
        repository.getTimeBucket('2024-02-01', options, auth, { take: 2, after: first.endCursor }),
      ).rejects.toThrow('Calendar page changed');
      await db.deleteFrom('asset').where('id', '=', first.endCursor).execute();
      await expect(read({ take: 2, after: first.endCursor })).rejects.toThrow('Calendar page changed');
    },
    60_000,
  );

  it('summarises days per page across months and locates within each month', async () => {
    const { ctx } = newMediumService(BaseService, {
      database: db,
      real: [AssetRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user: { id: user.id } });
    const ids: Record<string, string> = {};
    for (const [name, at] of [
      ['feb11', '2024-02-11T12:00:00Z'],
      ['feb10a', '2024-02-10T13:00:00Z'],
      ['feb10b', '2024-02-10T12:00:00Z'],
      ['jan05', '2024-01-05T12:00:00Z'],
    ]) {
      const date = new Date(at);
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: date,
        localDateTime: date,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.newExif({ assetId: asset.id, timeZone: 'UTC' });
      ids[name] = asset.id;
    }
    const repository = ctx.get(AssetRepository);
    const options = { userIds: [user.id], visibility: AssetVisibility.Timeline, order: AssetOrder.Desc };
    const byDay = (summaries: TimeBucketItem[]) =>
      summaries.map((summary) => ({ ...summary, days: summary.days?.toSorted((a, b) => b.day - a.day) }));
    const summaries = byDay(await repository.getTimeBuckets(options, auth, { pageSize: 2 }));
    expect(summaries).toEqual([
      {
        timeBucket: '2024-02-01',
        days: [
          { day: 11, count: 1 },
          { day: 10, count: 2 },
        ],
        count: 2,
        page: 0,
        after: null,
        firstAssetId: ids.feb11,
        lastAssetId: ids.feb10a,
      },
      {
        timeBucket: '2024-02-01',
        days: [{ day: 10, count: 2 }],
        count: 1,
        page: 1,
        after: ids.feb10a,
        firstAssetId: ids.feb10b,
        lastAssetId: ids.feb10b,
      },
      {
        timeBucket: '2024-01-01',
        days: [{ day: 5, count: 1 }],
        count: 1,
        page: 0,
        after: null,
        firstAssetId: ids.jan05,
        lastAssetId: ids.jan05,
      },
    ]);
    for (const [name, page] of [
      ['feb11', 0],
      ['feb10a', 0],
      ['feb10b', 1],
      ['jan05', 2],
    ] as const) {
      const located = await repository.getTimeBuckets(options, auth, { pageSize: 2, locateAssetId: ids[name] });
      expect(byDay(located)).toEqual([summaries[page]]);
    }
  });

  it('re-ranks only what changed and always matches a fresh summary (FL-1592)', async () => {
    const { ctx } = newMediumService(BaseService, {
      database: db,
      real: [AssetRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user: { id: user.id } });
    const ids: string[] = [];
    for (const at of ['2024-03-02', '2024-03-01', '2024-03-01', '2024-02-10', '2024-02-09']) {
      const date = new Date(`${at}T12:00:00Z`);
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: date,
        localDateTime: date,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.newExif({ assetId: asset.id, timeZone: 'UTC' });
      ids.push(asset.id);
    }
    const cached = ctx.get(AssetRepository);
    const options = { userIds: [user.id], visibility: AssetVisibility.Timeline, order: AssetOrder.Desc };
    const expectFresh = async () => {
      const summary = await cached.getTimeBuckets(options, auth, { pageSize: 2 });
      // FL-1792: without the stored summary, a new repository ranks every month from nothing
      await sql`delete from timeline_summary where "userId" = ${user.id}::uuid`.execute(db);
      expect(summary).toEqual(await new AssetRepository(db).getTimeBuckets(options, auth, { pageSize: 2 }));
      return summary;
    };
    const before = await expectFresh();
    expect(await expectFresh()).toEqual(before);
    // Changes that touch the photo row: a new date moves it to another month, and Trash hides it.
    await sql`update asset set "localDateTime" = '2024-02-11T12:00:00Z' where id = ${ids[0]}::uuid`.execute(db);
    await expectFresh();
    await sql`update asset set "deletedAt" = now() where id = ${ids[3]}::uuid`.execute(db);
    await expectFresh();
    // Changes that never touch the photo row still change which photos are listed.
    await sql`insert into asset_lock ("assetId", reason) values (${ids[1]}::uuid, 'marked')`.execute(db);
    await expectFresh();
    await sql`delete from asset_exif where "assetId" = ${ids[4]}::uuid`.execute(db);
    expect((await expectFresh()).map(({ timeBucket, count }) => [timeBucket, count])).toEqual([
      ['2024-03-01', 1],
      ['2024-02-01', 1],
    ]);
  });

  it('keeps the ranked months across a server start and ranks only what changed meanwhile (FL-1792)', async () => {
    const { ctx } = newMediumService(BaseService, {
      database: db,
      real: [AssetRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user: { id: user.id } });
    const ids: string[] = [];
    for (const at of ['2024-03-02', '2024-03-01', '2024-02-10', '2024-01-05']) {
      const date = new Date(`${at}T12:00:00Z`);
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: date,
        localDateTime: date,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.newExif({ assetId: asset.id, timeZone: 'UTC' });
      ids.push(asset.id);
    }
    const options = { userIds: [user.id], visibility: AssetVisibility.Timeline, order: AssetOrder.Desc };
    // Every `new AssetRepository` is a server start: nothing ranked is in memory.
    const afterStart = () => new AssetRepository(db).getTimeBuckets(options, auth, { pageSize: 2 });
    const rankedFromNothing = async () => {
      await sql`delete from timeline_summary where "userId" = ${user.id}::uuid`.execute(db);
      return afterStart();
    };
    const stored = () =>
      sql<{ timeBucket: string }>`
        select "timeBucket" from timeline_summary where "userId" = ${user.id}::uuid order by "timeBucket"
      `
        .execute(db)
        .then(({ rows }) => rows.map(({ timeBucket }) => timeBucket));

    const first = await rankedFromNothing();
    expect(await stored()).toEqual(['2024-01-01', '2024-02-01', '2024-03-01']);
    expect(await afterStart()).toEqual(first);

    // A marker in every stored month shows which months the next start reads rather than ranks.
    await sql`
      update timeline_summary set pages = jsonb_build_array(pages -> 0 || '{"count": 99}'::jsonb)
      where "userId" = ${user.id}::uuid
    `.execute(db);
    expect((await afterStart()).map(({ timeBucket, count }) => [timeBucket, count])).toEqual([
      ['2024-03-01', 99],
      ['2024-02-01', 99],
      ['2024-01-01', 99],
    ]);

    // While the server is down: February's photo is trashed (its month goes), a March photo is locked.
    await sql`update asset set "deletedAt" = now() where id = ${ids[2]}::uuid`.execute(db);
    await sql`insert into asset_lock ("assetId", reason) values (${ids[1]}::uuid, 'marked')`.execute(db);
    expect((await afterStart()).map(({ timeBucket, count }) => [timeBucket, count])).toEqual([
      ['2024-03-01', 1],
      ['2024-01-01', 99],
    ]);
    expect(await stored()).toEqual(['2024-01-01', '2024-03-01']);

    // Apart from the marker, a start that reads the stored months answers as one that ranks them all.
    const fromStore = await afterStart();
    const fromNothing = await rankedFromNothing();
    expect(fromStore.filter(({ timeBucket }) => timeBucket !== '2024-01-01')).toEqual(
      fromNothing.filter(({ timeBucket }) => timeBucket !== '2024-01-01'),
    );

    // Another person, or the same person with other options, never reads these months.
    await sql`update timeline_summary set pages = '[]'::jsonb where "userId" = ${user.id}::uuid`.execute(db);
    const ascending = await new AssetRepository(db).getTimeBuckets({ ...options, order: AssetOrder.Asc }, auth, {
      pageSize: 2,
    });
    expect(ascending.map(({ timeBucket }) => timeBucket)).toEqual(['2024-01-01', '2024-03-01']);
  });

  it('stores only the summaries a person ranked most recently (FL-1792)', async () => {
    const { ctx } = newMediumService(BaseService, {
      database: db,
      real: [AssetRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user: { id: user.id } });
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    await ctx.newExif({ assetId: asset.id, timeZone: 'UTC' });
    const repository = ctx.get(AssetRepository);
    for (let pageSize = 1; pageSize <= 10; pageSize++) {
      await repository.getTimeBuckets({ userIds: [user.id], visibility: AssetVisibility.Timeline }, auth, { pageSize });
    }
    const { rows } = await sql<{ keys: number }>`
      select count(distinct key)::integer as keys from timeline_summary where "userId" = ${user.id}::uuid
    `.execute(db);
    expect(rows[0].keys).toBe(8);
  });

  it('never lets one viewer read months stored for another, and never stores a shared link (FL-1792)', async () => {
    const { ctx } = newMediumService(BaseService, {
      database: db,
      real: [AssetRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user: { id: user.id } });
    for (const at of ['2024-05-02', '2024-04-01']) {
      const date = new Date(`${at}T12:00:00Z`);
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: date,
        localDateTime: date,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.newExif({ assetId: asset.id, timeZone: 'UTC' });
    }
    const locked = { userIds: [user.id], visibility: AssetVisibility.Timeline, order: AssetOrder.Desc };
    const unlocked = { ...locked, revealLockedOwnerId: user.id };
    const counts = (summary: TimeBucketItem[]) => summary.map(({ count }) => count);

    // The unlocked session's months are stored, then marked; a locked session after a start never reads them.
    await new AssetRepository(db).getTimeBuckets(unlocked, auth, { pageSize: 2 });
    await sql`update timeline_summary set pages = jsonb_build_array(pages -> 0 || '{"count": 99}'::jsonb)
      where "userId" = ${user.id}::uuid`.execute(db);
    expect(counts(await new AssetRepository(db).getTimeBuckets(unlocked, auth, { pageSize: 2 }))).toEqual([99, 99]);
    expect(counts(await new AssetRepository(db).getTimeBuckets(locked, auth, { pageSize: 2 }))).toEqual([1, 1]);

    // Another person asking with the same options has their own key.
    const { user: other } = await ctx.newUser();
    const otherAuth = factory.auth({ user: { id: other.id } });
    const theirs = await new AssetRepository(db).getTimeBuckets({ ...unlocked, userIds: [user.id] }, otherAuth, {
      pageSize: 2,
    });
    expect(counts(theirs)).toEqual([1, 1]);

    // A shared link's view is answered, never stored.
    const before = await sql<{ n: number }>`select count(*)::integer as n from timeline_summary`.execute(db);
    const linkAuth = { ...auth, sharedLink: { id: newUuid() } } as unknown as AuthDto;
    await new AssetRepository(db).getTimeBuckets({ ...locked, order: AssetOrder.Asc }, linkAuth, { pageSize: 3 });
    const after = await sql<{ n: number }>`select count(*)::integer as n from timeline_summary`.execute(db);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('keeps the summaries a person reads, not only the ones last ranked (FL-1792)', async () => {
    const { ctx } = newMediumService(BaseService, {
      database: db,
      real: [AssetRepository],
      mock: [LoggingRepository],
    });
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user: { id: user.id } });
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    await ctx.newExif({ assetId: asset.id, timeZone: 'UTC' });
    const photos = { userIds: [user.id], visibility: AssetVisibility.Timeline };
    await new AssetRepository(db).getTimeBuckets(photos, auth, { pageSize: 50 });
    const photosKey = await sql<{ key: string }>`select key from timeline_summary where "userId" = ${user.id}::uuid`
      .execute(db)
      .then(({ rows }) => rows[0].key);
    await sql`update timeline_summary set "usedAt" = now() - interval '1 day' where key = ${photosKey}`.execute(db);

    // Seven other summaries are ranked, then Photos is read back after a start, unchanged: that counts as a
    // use, so the next summary pushes out the oldest of the others, not Photos.
    const repository = new AssetRepository(db);
    for (let pageSize = 1; pageSize <= 7; pageSize++) {
      await repository.getTimeBuckets(photos, auth, { pageSize });
    }
    await new AssetRepository(db).getTimeBuckets(photos, auth, { pageSize: 50 });
    await repository.getTimeBuckets(photos, auth, { pageSize: 8 });
    const { rows } = await sql<{ key: string }>`
      select distinct key from timeline_summary where "userId" = ${user.id}::uuid
    `.execute(db);
    expect(rows).toHaveLength(8);
    expect(rows.map(({ key }) => key)).toContain(photosKey);
  });

  it.each([TimeBucketDateType.Taken, TimeBucketDateType.Added])(
    'retains microsecond precision for %s date cursors',
    async (dateType) => {
      const { ctx } = newMediumService(BaseService, {
        database: db,
        real: [AssetRepository],
        mock: [LoggingRepository],
      });
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const ids: string[] = [];
      for (const fraction of ['000001', '000002', '000003']) {
        const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
        await ctx.newExif({ assetId: asset.id, timeZone: 'UTC' });
        await sql`update asset set "fileCreatedAt" = ${`2024-01-15T12:00:00.${fraction}Z`}::timestamptz,
        "localDateTime" = ${`2024-01-15T12:00:00.${fraction}Z`}::timestamptz,
        "createdAt" = ${`2024-01-15T12:00:00.${fraction}Z`}::timestamptz where id = ${asset.id}::uuid`.execute(db);
        ids.push(asset.id);
      }
      const repository = ctx.get(AssetRepository);
      const options = { userIds: [user.id], visibility: AssetVisibility.Timeline, order: AssetOrder.Asc, dateType };
      const first = JSON.parse((await repository.getTimeBucket('2024-01-01', options, auth, { take: 1 })).assets);
      const second = JSON.parse(
        (await repository.getTimeBucket('2024-01-01', options, auth, { take: 1, after: first.endCursor })).assets,
      );
      expect(first.id).toEqual([ids[0]]);
      expect(second.id).toEqual([ids[1]]);
    },
    60_000,
  );
});

describe('ordered asset locator', () => {
  it.each(['filename', 'rating', 'quality'] as const)('matches %s pages and excludes other owners', async (sort) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [AssetRepository], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const auth = factory.auth({ user: { id: user.id } });
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        originalFileName: `${4 - n}.jpg`,
        visibility: AssetVisibility.Timeline,
      });
      await ctx.newExif({ assetId: asset.id, rating: n, timeZone: 'UTC' });
      ids.push(asset.id);
    }
    await db
      .insertInto('asset_best_photo_score')
      .values([
        { assetId: ids[0], ownerId: user.id, score: 0.9, scoreVersion: 1, computedAt: new Date() },
        { assetId: ids[2], ownerId: user.id, score: 0.95, scoreVersion: 1, computedAt: new Date() },
      ])
      .execute();
    const repository = ctx.get(AssetRepository);
    const options = { userIds: [user.id], visibility: AssetVisibility.Timeline };
    const full = JSON.parse((await repository.getTimelineOrdered(options, auth, { sort, skip: 0, take: 5 })).assets);
    for (const [position, id] of (full.id as string[]).entries()) {
      expect(await repository.getTimeBuckets(options, auth, { sort, pageSize: 2, locateAssetId: id })).toEqual([
        { timeBucket: '1970-01-01', page: Math.floor(position / 2), count: position < 4 ? 2 : 1 },
      ]);
    }
    expect(
      await repository.getTimeBuckets({ ...options, userIds: [other.id] }, auth, {
        sort,
        pageSize: 2,
        locateAssetId: ids[0],
      }),
    ).toEqual([]);
    // Search filters already join EXIF; the locator must not duplicate that join.
    expect(
      await repository.getTimeBuckets({ ...options, filter: { rating: { gte: 0 } } }, auth, {
        sort,
        pageSize: 2,
        locateAssetId: full.id[0],
      }),
    ).toEqual([{ timeBucket: '1970-01-01', page: 0, count: 2 }]);
  });
});
