import { Kysely, sql } from 'kysely';
import { vi } from 'vitest';
import type { JobRepository } from 'src/repositories/job.repository.js';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DateDoctorRepository } from 'src/repositories/date-doctor.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { DB } from 'src/schema/index.js';
import { DateDoctorService } from 'src/services/date-doctor.service.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { type DateFinding, DateFindingCause } from 'src/utils/date-doctor.js';
import { TimelineDatesToCheck } from 'src/utils/date-sanity.js';
import { type FixturePhoto, buildDateDoctorFixture, scoreFindings } from 'test/fixtures/date-doctor.fixture.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-912: the Date & Time Doctor's scan, on a real database. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { sut: timeline, ctx } = newMediumService(TimelineService, {
    database: db,
    real: [AssetRepository, AccessRepository, PartnerRepository],
    mock: [LoggingRepository],
  });
  const logger = { setContext: vi.fn(), log: vi.fn() } as unknown as LoggingRepository;
  const jobs = { queue: vi.fn(), queueAll: vi.fn() } as unknown as JobRepository;
  const doctor = new DateDoctorService(logger, jobs, new DateDoctorRepository(db));
  return { ctx, timeline, doctor };
};
type Context = ReturnType<typeof setup>['ctx'];

/** Inserts fixture photos for `ownerId`; returns them with their database ids. */
const insert = async (ctx: Context, ownerId: string, photos: FixturePhoto[]) => {
  const stored: FixturePhoto[] = [];
  for (const photo of photos) {
    const { asset } = await ctx.newAsset({
      ownerId,
      originalFileName: photo.originalFileName,
      fileCreatedAt: photo.takenAt,
      localDateTime: photo.localDateTime,
    });
    await ctx.newExif({
      assetId: asset.id,
      dateTimeOriginal: photo.takenAt,
      timeZone: photo.timeZone,
      latitude: photo.latitude,
      longitude: photo.longitude,
      make: photo.make,
      model: photo.model,
      offsetTimeOriginal: photo.offsetTimeOriginal,
      offsetTime: photo.offsetTime,
      lockedProperties: [
        ...(photo.dateLocked ? ['dateTimeOriginal' as const] : []),
        ...(photo.zoneLocked ? ['timeZone' as const] : []),
      ],
    });
    stored.push({ ...photo, id: asset.id });
  }
  return stored;
};

const findingsOf = async (doctor: DateDoctorService, auth: ReturnType<typeof factory.auth>) => {
  const { groups } = await doctor.getFindings(auth);
  return groups.flatMap((group) =>
    group.findings.map((finding): DateFinding => ({
      ...finding,
      currentDate: new Date(finding.currentDate),
      proposedDate: finding.proposedDate ? new Date(finding.proposedDate) : null,
      groupKey: group.groupKey,
    })),
  );
};

describe('Date & Time Doctor scan (FL-912)', () => {
  it('finds the fixture’s wrong dates and zones, and nothing in its clean photos, from the database', async () => {
    const { ctx, doctor } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const photos = await insert(ctx, user.id, buildDateDoctorFixture());

    const started = Date.now();
    await doctor.handleScan({ userId: user.id });
    const elapsed = Date.now() - started;

    const score = scoreFindings(photos, await findingsOf(doctor, auth));
    console.log(
      `FL-912 fixture in the database: found ${score.found}/${score.wrong}, false positives ` +
        `${score.falsePositives}/${score.clean}, scan of ${photos.length} photos in ${elapsed} ms`,
    );
    expect(score.found / score.wrong).toBeGreaterThanOrEqual(0.95);
    expect(score.falsePositives / score.clean).toBeLessThanOrEqual(0.02);
    // dates and zones set by hand are never proposed
    const locked = new Set(photos.filter((photo) => photo.dateLocked || photo.zoneLocked).map(({ id }) => id));
    expect(score.falselyFlagged.filter(({ id }) => locked.has(id))).toEqual([]);
  }, 60_000);

  it('has a future or reset finding for exactly the photos the timeline keeps in "Dates to check"', async () => {
    const { ctx, timeline, doctor } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    // the future and reset scenarios, a hand-dated scan and some ordinary photos
    const fixture = buildDateDoctorFixture();
    await insert(ctx, user.id, [
      ...fixture.slice(0, 80),
      ...fixture.filter((photo) => photo.dateLocked),
      ...fixture.filter((photo) => !photo.expect && !photo.dateLocked).slice(0, 40),
    ]);
    await doctor.handleScan({ userId: user.id });

    const { timeBuckets } = await timeline.getDatesToCheck(auth, {});
    const toCheck = new Set<string>();
    for (const timeBucket of timeBuckets) {
      const bucket = JSON.parse(
        await timeline.getTimeBucket(auth, { timeBucket, datesToCheck: TimelineDatesToCheck.Only }),
      ) as { id: string[] };
      for (const id of bucket.id) {
        toCheck.add(id);
      }
    }
    const flagged = new Set(
      (await findingsOf(doctor, auth))
        .filter(({ cause }) => cause === DateFindingCause.FutureDate || cause === DateFindingCause.EpochDate)
        .map(({ assetId }) => assetId),
    );
    expect(toCheck.size).toBe(80);
    expect([...flagged].toSorted()).toEqual([...toCheck].toSorted());
  });

  it('scans only the owner’s own photos, once: not another owner’s, not a partner’s copy, not Trash or Locked', async () => {
    const { ctx, doctor } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    const future = buildDateDoctorFixture().slice(0, 4);
    const [mine, trashed, locked] = await insert(ctx, owner.id, future.slice(0, 3));
    const [theirs] = await insert(ctx, partner.id, future.slice(3, 4));
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', trashed.id).execute();
    await db.updateTable('asset').set({ visibility: AssetVisibility.Locked }).where('id', '=', locked.id).execute();
    // the partner's copy of the owner's photo, still following its date
    const [copy] = await insert(ctx, partner.id, future.slice(0, 1));
    await sql`insert into asset_origin ("assetId", "sourceAssetId", "ownerId", "rootOwnerId", "partnerSharedById")
      values (${copy.id}, ${mine.id}, ${partner.id}, ${owner.id}, ${owner.id})`.execute(db);

    await doctor.handleScan({ userId: owner.id });
    await doctor.handleScan({ userId: partner.id });

    expect((await findingsOf(doctor, factory.auth({ user: owner }))).map(({ assetId }) => assetId)).toEqual([mine.id]);
    expect((await findingsOf(doctor, factory.auth({ user: partner }))).map(({ assetId }) => assetId)).toEqual([
      theirs.id,
    ]);
  });

  it('leaves out a photo locked before the scan, and hides one locked after it', async () => {
    const { ctx, doctor } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const [lockedBefore, lockedAfter, open] = await insert(ctx, user.id, buildDateDoctorFixture().slice(0, 3));
    const lock = (assetId: string) =>
      db.insertInto('asset_lock').values({ assetId, reason: AssetLockReason.Marked, lockedBy: user.id }).execute();

    await lock(lockedBefore.id);
    await doctor.handleScan({ userId: user.id });
    expect((await findingsOf(doctor, auth)).map(({ assetId }) => assetId).toSorted()).toEqual(
      [lockedAfter.id, open.id].toSorted(),
    );

    await lock(lockedAfter.id);
    expect((await findingsOf(doctor, auth)).map(({ assetId }) => assetId)).toEqual([open.id]);
  });

  it('stores both offsets when metadata is read again, and keeps them through writes that do not read them', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, make: 'Fujifilm' });
    const assets = ctx.get(AssetRepository);
    const offsets = () =>
      db
        .selectFrom('asset_exif')
        .select(['offsetTimeOriginal', 'offsetTime'])
        .where('assetId', '=', asset.id)
        .executeTakeFirstOrThrow();

    await assets.upsertExif({
      exif: { assetId: asset.id, offsetTimeOriginal: '+01:00', offsetTime: '+02:00' },
      lockedPropertiesBehavior: 'skip',
    });
    await expect(offsets()).resolves.toEqual({ offsetTimeOriginal: '+01:00', offsetTime: '+02:00' });

    await assets.upsertExif({ exif: { assetId: asset.id, description: 'beach' }, lockedPropertiesBehavior: 'skip' });
    await expect(offsets()).resolves.toEqual({ offsetTimeOriginal: '+01:00', offsetTime: '+02:00' });
  });

  it('replaces open findings on a new scan, and does not raise a dismissed one again', async () => {
    const { ctx, doctor } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const [fixed, dismissed, open] = await insert(ctx, user.id, buildDateDoctorFixture().slice(0, 3));
    await doctor.handleScan({ userId: user.id });
    expect((await findingsOf(doctor, auth)).map(({ assetId }) => assetId).toSorted()).toEqual(
      [fixed.id, dismissed.id, open.id].toSorted(),
    );

    await db
      .updateTable('asset_date_finding')
      .set({ dismissedAt: new Date() })
      .where('assetId', '=', dismissed.id)
      .execute();
    // somebody set the right date by hand
    await db
      .updateTable('asset_exif')
      .set({ lockedProperties: ['dateTimeOriginal'] })
      .where('assetId', '=', fixed.id)
      .execute();
    await doctor.handleScan({ userId: user.id });

    expect((await findingsOf(doctor, auth)).map(({ assetId }) => assetId)).toEqual([open.id]);
    const kept = await db
      .selectFrom('asset_date_finding')
      .select('assetId')
      .where('assetId', '=', dismissed.id)
      .execute();
    expect(kept).toHaveLength(1);
  });
});
