import { Kysely } from 'kysely';
import { TimeBucketDto } from 'src/dtos/time-bucket.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { ViewRepository } from 'src/repositories/view-repository.js';
import { DB } from 'src/schema/index.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { TimelineDatesToCheck, dateProblem, hasDateToCheck, hasGoodDate } from 'src/utils/date-sanity.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-1410: dates that cannot be right never lead the library. The rule is `utils/date-sanity.ts`; these
 * hold its SQL form to its in-memory form, and show what the timeline, an album, a tag and a folder do
 * with such photos.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () =>
  newMediumService(TimelineService, {
    database: db,
    real: [AssetRepository, AccessRepository, PartnerRepository, AlbumRepository, SearchRepository, TagRepository],
    mock: [LoggingRepository],
  });

const HOUR = 60 * 60_000;
/** A photo taken at this instant, in a camera `offsetHours` ahead of UTC. */
const taken = (instant: Date | string, offsetHours = 0) => {
  const fileCreatedAt = new Date(instant);
  return { fileCreatedAt, localDateTime: new Date(fileCreatedAt.getTime() + offsetHours * HOUR) };
};
const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

describe('dates that cannot be right (FL-1410)', () => {
  it('answers the same in SQL as in memory: future, each reset day, and a date set by hand', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const now = Date.now();
    const cases: Array<{ name: string; dates: ReturnType<typeof taken>; locked?: string[]; expected: boolean }> = [
      { name: 'an ordinary photo', dates: taken('2024-06-01T10:00:00.000Z'), expected: false },
      { name: 'two days from now', dates: taken(new Date(now + 48 * HOUR)), expected: true },
      { name: 'a phone set to 2031', dates: taken('2031-06-02T09:00:00.000Z', -6), expected: true },
      {
        name: 'twelve hours from now: a clock a little fast',
        dates: taken(new Date(now + 12 * HOUR)),
        expected: false,
      },
      { name: '1 January 1970', dates: taken('1970-01-01T00:00:00.000Z'), expected: true },
      { name: '1 January 1980, later that day', dates: taken('1980-01-01T17:30:00.000Z'), expected: true },
      {
        name: '1 January 2000 on the camera, the day before in UTC',
        dates: taken('1999-12-31T19:00:00.000Z', 9),
        expected: true,
      },
      { name: '2 January 2000', dates: taken('2000-01-02T00:00:00.000Z'), expected: false },
      { name: '31 December 1969 on the camera', dates: taken('1970-01-01T03:00:00.000Z', -6), expected: false },
      {
        name: 'a scan somebody dated 1 January 1970 by hand',
        dates: taken('1970-01-01T12:00:00.000Z'),
        locked: ['dateTimeOriginal', 'timeZone'],
        expected: false,
      },
      {
        name: '1 January 1970 with only its place set by hand',
        dates: taken('1970-01-01T12:00:00.000Z'),
        locked: ['latitude', 'longitude'],
        expected: true,
      },
      {
        name: 'a future date somebody set by hand',
        dates: taken(new Date(now + 400 * 24 * HOUR)),
        locked: ['dateTimeOriginal'],
        expected: false,
      },
    ];
    const ids = new Map<string, (typeof cases)[number]>();
    for (const item of cases) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, ...item.dates });
      if (item.locked) {
        await ctx.newExif({ assetId: asset.id, lockedProperties: item.locked as never });
      }
      ids.set(asset.id, item);
    }

    const rows = await db
      .selectFrom('asset')
      .select(['asset.id', hasDateToCheck().as('toCheck'), hasGoodDate().as('good')])
      .where('asset.ownerId', '=', user.id)
      .execute();
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) {
      const { name, dates, locked, expected } = ids.get(row.id)!;
      const inMemory = dateProblem({
        takenAt: dates.fileCreatedAt,
        localDateTime: dates.localDateTime,
        dateSetByHand: locked?.includes('dateTimeOriginal'),
      });
      expect({ name, toCheck: row.toCheck }).toEqual({ name, toCheck: expected });
      expect({ name, good: row.good }).toEqual({ name, good: !expected });
      expect({ name, inMemory: !!inMemory }).toEqual({ name, inMemory: expected });
    }
  });

  it('stops flagging a photo once its date is changed by hand, as "Change date" does', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, ...taken('1970-01-01T00:00:00.000Z') });
    await ctx.newExif({ assetId: asset.id, dateTimeOriginal: new Date('1970-01-01T00:00:00.000Z') });
    const flagged = () =>
      db.selectFrom('asset').select(hasDateToCheck().as('toCheck')).where('asset.id', '=', asset.id).executeTakeFirst();
    await expect(flagged()).resolves.toEqual({ toCheck: true });

    // "Shift all by" zero minutes: the date is the same day in 1970, and now a person has said so
    await ctx.get(AssetRepository).updateDateTimeOriginal([asset.id], 0);
    await expect(flagged()).resolves.toEqual({ toCheck: false });
  });

  it('keeps them out of the dated order, the cards and a flat order, and returns them alone on request', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const add = async (instant: string, locked = false) => {
      const { asset } = await ctx.newAsset({ ownerId: user.id, ...taken(instant) });
      await ctx.newExif({
        assetId: asset.id,
        make: 'Canon',
        ...(locked && { lockedProperties: ['dateTimeOriginal'] }),
      });
      return asset.id;
    };
    const recent = await add('2026-08-14T10:00:00.000Z');
    const millennium = await add('2000-01-15T10:00:00.000Z');
    const scan = await add('1970-01-01T08:00:00.000Z', true);
    const future = await add('2031-06-02T09:00:00.000Z');
    const reset2000 = await add('2000-01-01T00:00:10.000Z');
    const reset1970 = await add('1970-01-01T00:00:00.000Z');

    const request = (datesToCheck?: TimelineDatesToCheck) =>
      // through the request schema: an undeclared parameter would be stripped and return every photo
      TimeBucketDto.schema.parse({ ...(datesToCheck && { datesToCheck }) });
    const exclude = request(TimelineDatesToCheck.Exclude);
    const only = request(TimelineDatesToCheck.Only);
    expect(exclude.datesToCheck).toBe('exclude');
    expect(TimeBucketDto.schema.safeParse({ datesToCheck: 'sometimes' }).success).toBe(false);

    // a request that does not say gets every photo, as before
    await expect(sut.getTimeBuckets(auth, request())).resolves.toEqual([
      { timeBucket: '2031-06-01', count: 1 },
      { timeBucket: '2026-08-01', count: 1 },
      { timeBucket: '2000-01-01', count: 2 },
      { timeBucket: '1970-01-01', count: 2 },
    ]);
    // the library opens on a real day; the hand-dated 1970 scan is an ordinary photo
    await expect(sut.getTimeBuckets(auth, exclude)).resolves.toEqual([
      { timeBucket: '2026-08-01', count: 1 },
      { timeBucket: '2000-01-01', count: 1 },
      { timeBucket: '1970-01-01', count: 1 },
    ]);
    await expect(sut.getTimeBuckets(auth, only)).resolves.toEqual([
      { timeBucket: '2031-06-01', count: 1 },
      { timeBucket: '2000-01-01', count: 1 },
      { timeBucket: '1970-01-01', count: 1 },
    ]);
    // what the notice says: how many, which years, and where the group reads them from
    await expect(sut.getDatesToCheck(auth, {})).resolves.toEqual({
      count: 3,
      years: [1970, 2000, 2031],
      timeBuckets: ['2031-06-01', '2000-01-01', '1970-01-01'],
    });
    // a photo with no EXIF row cannot be listed by a bucket, so the notice does not count it
    await ctx.newAsset({ ownerId: user.id, ...taken('2031-06-05T09:00:00.000Z') });
    await expect(sut.getDatesToCheck(auth, {})).resolves.toMatchObject({ count: 3 });
    await expect(sut.getDatesToCheck(auth, { isFavorite: true })).resolves.toEqual({
      count: 0,
      years: [],
      timeBuckets: [],
    });

    const idsOf = async (dto: TimeBucketDto, timeBucket: string) =>
      JSON.parse(await sut.getTimeBucket(auth, { ...dto, timeBucket })).id ?? [];
    await expect(idsOf(exclude, '2000-01-01')).resolves.toEqual([millennium]);
    await expect(idsOf(only, '2000-01-01')).resolves.toEqual([reset2000]);
    await expect(idsOf(exclude, '1970-01-01')).resolves.toEqual([scan]);
    await expect(idsOf(only, '1970-01-01')).resolves.toEqual([reset1970]);
    await expect(idsOf(exclude, '2031-06-01')).resolves.toEqual([]);
    await expect(idsOf(only, '2031-06-01')).resolves.toEqual([future]);

    // the pages the web timeline reads
    const pages = await sut.getTimeBuckets(auth, { ...exclude, pageSize: 100 });
    expect(pages.map(({ timeBucket, count, firstAssetId }) => ({ timeBucket, count, firstAssetId }))).toEqual([
      { timeBucket: '2026-08-01', count: 1, firstAssetId: recent },
      { timeBucket: '2000-01-01', count: 1, firstAssetId: millennium },
      { timeBucket: '1970-01-01', count: 1, firstAssetId: scan },
    ]);

    // Years cards: no "2031" card, and 2000 counts one photo
    const years = await sut.getTimelineHighlights(auth, { ...exclude, grouping: 'year' });
    expect(years.map(({ timeBucket, count }) => ({ timeBucket, count }))).toEqual([
      { timeBucket: '2026-01-01', count: 1 },
      { timeBucket: '2000-01-01', count: 1 },
      { timeBucket: '1970-01-01', count: 1 },
    ]);

    const ordered = JSON.parse(await sut.getTimelineOrdered(auth, { ...only, sort: 'filename', skip: 0, take: 10 }));
    expect(ordered.id).toHaveLength(3);
    expect(new Set(ordered.id)).toEqual(new Set([future, reset2000, reset1970]));
  });

  it("leaves them out of an album's range, and gives an album of nothing else no range", async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const add = async (instant: string) => (await ctx.newAsset({ ownerId: user.id, ...taken(instant) })).asset.id;
    const first = await add('2024-06-01T10:00:00.000Z');
    const last = await add('2025-07-04T10:00:00.000Z');
    const future = await add('2031-06-02T09:00:00.000Z');
    const reset = await add('1970-01-01T00:00:00.000Z');
    const { album: mixed } = await ctx.newAlbum({ ownerId: user.id }, [first, last, future, reset]);
    const { album: tidy } = await ctx.newAlbum({ ownerId: user.id }, [first, last]);
    const { album: wrong } = await ctx.newAlbum({ ownerId: user.id }, [future, reset]);

    const rows = await ctx.get(AlbumRepository).getMetadataForIds([mixed.id, tidy.id, wrong.id]);
    const byAlbum = new Map(rows.map((row) => [row.albumId, row]));
    expect(byAlbum.get(mixed.id)).toMatchObject({
      assetCount: 4,
      startDate: day('2024-06-01'),
      endDate: day('2025-07-04'),
    });
    expect(byAlbum.get(tidy.id)).toMatchObject({
      assetCount: 2,
      startDate: day('2024-06-01'),
      endDate: day('2025-07-04'),
    });
    expect(byAlbum.get(wrong.id)).toMatchObject({ assetCount: 2, startDate: null, endDate: null });
  });

  it("leaves them out of a folder's and a tag's range, and counts a folder's to be checked", async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const add = async (path: string, instant: string) =>
      (await ctx.newAsset({ ownerId: user.id, originalPath: path, ...taken(instant) })).asset.id;
    const first = await add('/library/camera/a.jpg', '2024-06-01T10:00:00.000Z');
    const last = await add('/library/camera/b.jpg', '2025-07-04T10:00:00.000Z');
    const future = await add('/library/camera/c.jpg', '2031-06-02T09:00:00.000Z');
    const reset = await add('/library/camera/d.jpg', '1980-01-01T00:00:00.000Z');
    const alone = await add('/library/old-phone/e.jpg', '2031-06-03T09:00:00.000Z');

    await expect(new ViewRepository(db).getFolderSummary(user.id)).resolves.toEqual([
      expect.objectContaining({
        path: '/library/camera',
        count: 4,
        startDate: day('2024-06-01'),
        endDate: day('2025-07-04'),
        datesToCheck: 2,
      }),
      // every date here is wrong: the range it had stays, since the response always carries both dates
      expect.objectContaining({
        path: '/library/old-phone',
        count: 1,
        startDate: day('2031-06-03'),
        endDate: day('2031-06-03'),
        datesToCheck: 1,
      }),
    ]);

    const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['camera'] });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [first, last, future, reset] });
    const [lonely] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['old phone'] });
    await ctx.newTagAsset({ tagIds: [lonely.id], assetIds: [alone] });
    const statistics = await ctx
      .get(SearchRepository)
      .searchTagStatistics(
        { visibility: AssetVisibility.Timeline, userIds: [user.id], viewingUserId: user.id },
        { viewerId: user.id, suppressedTagIds: [] },
      );
    expect(statistics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagId: tag.id, total: 4, startDate: day('2024-06-01'), endDate: day('2025-07-04') }),
        expect.objectContaining({
          tagId: lonely.id,
          total: 1,
          startDate: day('2031-06-03'),
          endDate: day('2031-06-03'),
        }),
      ]),
    );
  });
});
