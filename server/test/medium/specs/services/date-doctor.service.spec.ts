import { Kysely, sql } from 'kysely';
import { vi } from 'vitest';
import type { EventRepository } from 'src/repositories/event.repository.js';
import type { JobRepository } from 'src/repositories/job.repository.js';
import { AssetLockReason, AssetVisibility, JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AccountEventRepository } from 'src/repositories/account-event.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DateDoctorRepository } from 'src/repositories/date-doctor.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
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

/** FL-912: the Date & Time Doctor's scan, on a real database. FL-930: its fixes and their undo. */
type FixDeps = [AccessRepository, AccountEventRepository, EventRepository, PartnerOriginRepository];
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
  const doctor = new DateDoctorService(
    logger,
    jobs,
    new DateDoctorRepository(db),
    ...([{}, {}, {}, {}] as unknown as FixDeps),
  );
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

  it('leaves out a photo locked before the scan, and hides one locked or hidden after it', async () => {
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

    // the hidden half of a Live Photo, found after the scan, is not listed either
    await db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', open.id).execute();
    await expect(findingsOf(doctor, auth)).resolves.toEqual([]);
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

describe('Date & Time Doctor fixes (FL-930)', () => {
  const fixSetup = () => {
    const { ctx } = newMediumService(TimelineService, {
      database: db,
      real: [AssetRepository, AccessRepository, PartnerRepository, PartnerOriginRepository, AccountEventRepository],
      mock: [LoggingRepository],
    });
    const logger = { setContext: vi.fn(), log: vi.fn(), error: vi.fn() } as unknown as LoggingRepository;
    const jobs = { queue: vi.fn(), queueAll: vi.fn(), queueAllInTransaction: vi.fn() };
    const events = { emit: vi.fn() };
    const doctor = new DateDoctorService(
      logger,
      jobs as unknown as JobRepository,
      new DateDoctorRepository(db),
      ctx.get(AccessRepository),
      ctx.get(AccountEventRepository),
      events as unknown as EventRepository,
      ctx.get(PartnerOriginRepository),
    );
    return { ctx, doctor, jobs, events };
  };
  type FixContext = ReturnType<typeof fixSetup>['ctx'];

  const takenAt = new Date('2022-07-01T10:03:00Z');
  const photo = async (
    ctx: FixContext,
    ownerId: string,
    zone: string | null = null,
    locks: Array<'dateTimeOriginal' | 'timeZone'> = [],
  ) => {
    const { asset } = await ctx.newAsset({ ownerId, fileCreatedAt: takenAt, localDateTime: takenAt });
    await ctx.newExif({
      assetId: asset.id,
      dateTimeOriginal: takenAt,
      timeZone: zone,
      lockedProperties: locks.length > 0 ? locks : null,
    });
    return asset.id;
  };
  const dateOf = (id: string) =>
    db
      .selectFrom('asset')
      .innerJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select([
        'asset.fileCreatedAt',
        'asset.localDateTime',
        'asset_exif.dateTimeOriginal',
        'asset_exif.timeZone',
        'asset_exif.lockedProperties',
      ])
      .where('asset.id', '=', id)
      .executeTakeFirstOrThrow();

  it('writes the date and zone locked, and undo puts back exactly what was there, a missing zone included', async () => {
    const { ctx, doctor, jobs } = fixSetup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const id = await photo(ctx, user.id);
    const before = await dateOf(id);

    const { batch } = await doctor.apply(auth, { assetIds: [id], timeZone: 'Europe/Paris', keepWallTime: true });

    expect(batch).toEqual(expect.objectContaining({ count: 1, undoneAt: null }));
    // 10:03 on the camera's clock in Paris (summer time) is 08:03 UTC
    expect(await dateOf(id)).toEqual({
      fileCreatedAt: new Date('2022-07-01T08:03:00Z'),
      localDateTime: takenAt,
      dateTimeOriginal: new Date('2022-07-01T08:03:00Z'),
      timeZone: 'Europe/Paris',
      lockedProperties: expect.arrayContaining(['dateTimeOriginal', 'timeZone']),
    });
    expect(jobs.queueAllInTransaction).toHaveBeenCalledWith(expect.anything(), [
      { name: JobName.SidecarWrite, data: { id } },
    ]);
    const logged = await db.selectFrom('account_event').selectAll().where('userId', '=', user.id).execute();
    expect(logged).toEqual([expect.objectContaining({ action: 'dates-fixed', detail: '1' })]);

    await expect(doctor.undo(auth, batch.id)).resolves.toEqual(expect.objectContaining({ restored: 1 }));

    const after = await dateOf(id);
    expect({ ...after, lockedProperties: before.lockedProperties }).toEqual(before);
    // the lock goes once the sidecar holds the restored date
    expect(jobs.queueAllInTransaction).toHaveBeenLastCalledWith(expect.anything(), [
      { name: JobName.SidecarWrite, data: { id, releaseDateLock: true } },
    ]);
    await expect(doctor.undo(auth, batch.id)).rejects.toThrow('Already undone');
  });

  it('what was set by hand before stays set by hand after undo, property by property', async () => {
    const { ctx, doctor, jobs } = fixSetup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const both = await photo(ctx, user.id, 'UTC', ['dateTimeOriginal', 'timeZone']);
    const zoneOnly = await photo(ctx, user.id, 'UTC', ['timeZone']);

    const { batch } = await doctor.apply(auth, { assetIds: [both, zoneOnly], shiftMinutes: 30 });
    await doctor.undo(auth, batch.id);

    expect(jobs.queueAllInTransaction).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.arrayContaining([
        { name: JobName.SidecarWrite, data: { id: both } },
        { name: JobName.SidecarWrite, data: { id: zoneOnly, releaseDateLock: ['dateTimeOriginal'] } },
      ]),
    );
    expect((await dateOf(both)).fileCreatedAt).toEqual(takenAt);
  });

  it('does not apply over a zone changed after the plan was read', async () => {
    const { ctx } = fixSetup();
    const { user } = await ctx.newUser();
    const id = await photo(ctx, user.id, 'Europe/Paris');
    const repository = new DateDoctorRepository(db);
    const [row] = await repository.getCurrent(user.id, [id]);
    // a zone with the same offset set in between, which leaves both clock values as they were
    await db.updateTable('asset_exif').set({ timeZone: 'Europe/Berlin' }).where('assetId', '=', id).execute();

    const result = await repository.applyFixes(
      user.id,
      [
        {
          assetId: id,
          currentTakenAt: row.takenAt,
          currentLocalDateTime: row.localDateTime,
          currentZone: row.timeZone,
          previousDate: row.dateTimeOriginal,
          previousZone: row.timeZone,
          previousTakenAt: row.takenAt,
          previousLocalDateTime: row.localDateTime,
          previousLocks: [],
          newDate: new Date(row.takenAt.getTime() + 60_000),
          newZone: row.timeZone,
          newLocalDateTime: new Date(row.localDateTime.getTime() + 60_000),
        },
      ],
      { cause: null, shiftMinutes: 1, timeZone: null },
      () => Promise.resolve(),
    );

    expect(result).toBeUndefined();
    expect(await dateOf(id)).toEqual(expect.objectContaining({ fileCreatedAt: takenAt, timeZone: 'Europe/Berlin' }));
  });

  it('applying twice keeps the earliest previous value, so undo goes all the way back', async () => {
    const { ctx, doctor } = fixSetup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const id = await photo(ctx, user.id);
    const before = await dateOf(id);

    const { batch: first } = await doctor.apply(auth, { assetIds: [id], timeZone: 'Asia/Tokyo', keepWallTime: true });
    const { batch: second } = await doctor.apply(auth, { assetIds: [id], shiftMinutes: 60 });
    const items = await db.selectFrom('date_fix_item').selectAll().where('assetId', '=', id).execute();
    expect(items.map(({ previousTakenAt, previousZone }) => ({ previousTakenAt, previousZone }))).toEqual([
      { previousTakenAt: takenAt, previousZone: null },
      { previousTakenAt: takenAt, previousZone: null },
    ]);

    await expect(doctor.undo(auth, second.id)).resolves.toEqual(expect.objectContaining({ restored: 1 }));
    expect({ ...(await dateOf(id)), lockedProperties: before.lockedProperties }).toEqual(before);
    // the first batch's date is no longer the photo's: undoing it now changes nothing
    await expect(doctor.undo(auth, first.id)).resolves.toEqual(expect.objectContaining({ restored: 0 }));
    expect((await dateOf(id)).fileCreatedAt).toEqual(takenAt);
  });

  it('a photo dated again since the fix keeps that date on undo', async () => {
    const { ctx, doctor } = fixSetup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const [kept, restored] = [await photo(ctx, user.id), await photo(ctx, user.id)];

    const { batch } = await doctor.apply(auth, { assetIds: [kept, restored], shiftMinutes: 120 });
    const later = new Date('2023-01-01T00:00:00Z');
    await db.updateTable('asset').set({ fileCreatedAt: later }).where('id', '=', kept).execute();

    await expect(doctor.undo(auth, batch.id)).resolves.toEqual(expect.objectContaining({ count: 2, restored: 1 }));
    expect((await dateOf(kept)).fileCreatedAt).toEqual(later);
    expect((await dateOf(restored)).fileCreatedAt).toEqual(takenAt);
  });

  it('applies the Doctor’s proposals, hiding their findings until undone', async () => {
    const { ctx, doctor } = fixSetup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const id = await photo(ctx, user.id);
    await db
      .insertInto('asset_date_finding')
      .values({
        assetId: id,
        cause: DateFindingCause.MissingZone,
        currentDate: takenAt,
        currentZone: null,
        proposedDate: new Date('2022-07-01T08:03:00Z'),
        proposedZone: 'Europe/Paris',
        confidence: 0.8,
        groupKey: 'unknown|2022-07-01',
      })
      .execute();

    const { items } = await doctor.preview(auth, { assetIds: [id], useProposal: true });
    expect(items).toEqual([
      expect.objectContaining({
        after: { date: '2022-07-01T08:03:00.000Z', zone: 'Europe/Paris', local: '2022-07-01T10:03:00' },
      }),
    ]);
    expect((await dateOf(id)).fileCreatedAt).toEqual(takenAt);

    const { batch } = await doctor.apply(auth, { assetIds: [id], useProposal: true });
    expect(batch).toEqual(expect.objectContaining({ cause: DateFindingCause.MissingZone, timeZone: null }));
    expect(await dateOf(id)).toEqual(expect.objectContaining({ timeZone: 'Europe/Paris', localDateTime: takenAt }));
    // the fixed photo leaves the findings at once, and undo brings its finding back without a scan
    expect(await findingsOf(doctor, auth)).toEqual([]);
    await doctor.undo(auth, batch.id);
    expect((await findingsOf(doctor, auth)).map(({ assetId }) => assetId)).toEqual([id]);
    await expect(doctor.getBatches(auth)).resolves.toEqual([
      expect.objectContaining({ id: batch.id, undoneAt: expect.any(String) }),
    ]);
  });

  it('changes nothing when the sidecar or partner-copy work fails in the transaction', async () => {
    const { ctx, doctor, jobs } = fixSetup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const id = await photo(ctx, user.id);
    const before = await dateOf(id);
    jobs.queueAllInTransaction.mockRejectedValueOnce(new Error('queue down'));

    await expect(doctor.apply(auth, { assetIds: [id], shiftMinutes: 30 })).rejects.toThrow('queue down');

    expect(await dateOf(id)).toEqual(before);
    expect(await db.selectFrom('date_fix_batch').select('id').where('userId', '=', user.id).execute()).toEqual([]);
    // a retry shifts once, not twice
    const { batch } = await doctor.apply(auth, { assetIds: [id], shiftMinutes: 30 });
    expect(batch.count).toBe(1);
    expect((await dateOf(id)).fileCreatedAt).toEqual(new Date(takenAt.getTime() + 30 * 60_000));

    jobs.queueAllInTransaction.mockRejectedValueOnce(new Error('queue down'));
    await expect(doctor.undo(auth, batch.id)).rejects.toThrow('queue down');
    expect((await dateOf(id)).fileCreatedAt).toEqual(new Date(takenAt.getTime() + 30 * 60_000));
    await expect(doctor.undo(auth, batch.id)).resolves.toEqual(expect.objectContaining({ restored: 1 }));
  });

  it('a zone-only edit committed while the fix waits wins over the fix', async () => {
    const { ctx } = fixSetup();
    const { user } = await ctx.newUser();
    const id = await photo(ctx, user.id, 'Europe/Paris');
    const repository = new DateDoctorRepository(db);
    const [row] = await repository.getCurrent(user.id, [id]);

    // another connection edits only the zone and holds its lock until the fix has started
    let commitEdit!: () => void;
    const editHeld = new Promise<void>((resolve) => (commitEdit = resolve));
    let editLocked!: () => void;
    const locked = new Promise<void>((resolve) => (editLocked = resolve));
    const edit = db.transaction().execute(async (tx) => {
      await tx.updateTable('asset_exif').set({ timeZone: 'Europe/Berlin' }).where('assetId', '=', id).execute();
      editLocked();
      await editHeld;
    });
    await locked;

    const fix = repository.applyFixes(
      user.id,
      [
        {
          assetId: id,
          currentTakenAt: row.takenAt,
          currentLocalDateTime: row.localDateTime,
          currentZone: row.timeZone,
          previousDate: row.dateTimeOriginal,
          previousZone: row.timeZone,
          previousTakenAt: row.takenAt,
          previousLocalDateTime: row.localDateTime,
          previousLocks: [],
          newDate: row.takenAt,
          newZone: 'Asia/Tokyo',
          newLocalDateTime: new Date(row.takenAt.getTime() + 9 * 3_600_000),
        },
      ],
      { cause: null, shiftMinutes: null, timeZone: 'Asia/Tokyo' },
      () => Promise.resolve(),
    );
    // let the edit commit only once the fix is waiting for the EXIF row lock
    for (let waiting = 0; waiting === 0;) {
      const { rows } = await sql<{ count: number }>`select count(*)::int as count from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%from asset_exif where "assetId" = any(%for update%'`.execute(
        db,
      );
      waiting = rows[0].count;
    }
    commitEdit();
    await edit;

    // the fix waited for the EXIF row, then saw the new zone and left the photo alone
    await expect(fix).resolves.toBeUndefined();
    expect(await dateOf(id)).toEqual(expect.objectContaining({ timeZone: 'Europe/Berlin', localDateTime: takenAt }));
  });

  it('a fix the photo no longer carries does not hide its finding', async () => {
    const { ctx, doctor } = fixSetup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const id = await photo(ctx, user.id);
    await db
      .insertInto('asset_date_finding')
      .values({
        assetId: id,
        cause: DateFindingCause.MissingZone,
        currentDate: takenAt,
        currentZone: null,
        proposedDate: takenAt,
        proposedZone: 'Asia/Tokyo',
        confidence: 0.8,
        groupKey: 'unknown|2022-07-01',
      })
      .execute();

    // two zone changes that keep the moment, then the second undone: the photo is back as it was, though the first
    // batch, never undone, still names the same moment
    await doctor.apply(auth, { assetIds: [id], timeZone: 'Asia/Tokyo' });
    const { batch: second } = await doctor.apply(auth, { assetIds: [id], timeZone: 'Europe/Paris' });
    expect(await findingsOf(doctor, auth)).toEqual([]);
    await doctor.undo(auth, second.id);

    expect((await findingsOf(doctor, auth)).map(({ assetId }) => assetId)).toEqual([id]);
  });

  it('a person cannot fix or undo photos they do not own, a partner’s copy included', async () => {
    const { ctx, doctor } = fixSetup();
    const { user: owner } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    const ownerAuth = factory.auth({ user: owner });
    const partnerAuth = factory.auth({ user: partner });
    const original = await photo(ctx, owner.id);
    const copy = await photo(ctx, partner.id);
    await ctx.get(PartnerOriginRepository).createOrigin('asset', {
      id: copy,
      sourceId: original,
      ownerId: partner.id,
      rootOwnerId: owner.id,
      partnerSharedById: owner.id,
    });

    await expect(doctor.apply(ownerAuth, { assetIds: [copy], shiftMinutes: 5 })).rejects.toThrow(
      'Not found or no asset.update access',
    );
    await expect(doctor.apply(partnerAuth, { assetIds: [original], shiftMinutes: 5 })).rejects.toThrow(
      'Not found or no asset.update access',
    );
    const { batch } = await doctor.apply(ownerAuth, { assetIds: [original], shiftMinutes: 5 });
    await expect(doctor.undo(partnerAuth, batch.id)).rejects.toThrow('Batch not found');
    expect((await dateOf(copy)).fileCreatedAt).toEqual(takenAt);
  });

  it('applies to 1,000 photos in one request in under 5 s', async () => {
    const { ctx, doctor, jobs } = fixSetup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(await photo(ctx, user.id));
    }

    const started = Date.now();
    const { batch } = await doctor.apply(auth, { assetIds: ids, timeZone: 'America/Edmonton' });
    const elapsed = Date.now() - started;

    console.log(`FL-930: applied to ${batch.count} photos in ${elapsed} ms`);
    expect(batch.count).toBe(1000);
    expect(elapsed).toBeLessThan(5000);
    // UPDATE ... RETURNING gives no row order, so the sidecar jobs can come back in any order
    const [, queued] = jobs.queueAllInTransaction.mock.calls[0];
    expect(queued).toHaveLength(1000);
    expect(queued).toEqual(expect.arrayContaining(ids.map((id) => ({ name: JobName.SidecarWrite, data: { id } }))));
  }, 120_000);

  it('removes batches older than 30 days each night', async () => {
    const { ctx, doctor } = fixSetup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const id = await photo(ctx, user.id);
    const { batch: old } = await doctor.apply(auth, { assetIds: [id], shiftMinutes: 1 });
    const { batch: recent } = await doctor.apply(auth, { assetIds: [id], shiftMinutes: 1 });
    await db
      .updateTable('date_fix_batch')
      .set({ createdAt: new Date(Date.now() - 31 * 24 * 3_600_000) })
      .where('id', '=', old.id)
      .execute();

    await expect(doctor.undo(auth, old.id)).rejects.toThrow('Batch not found');
    await doctor.onNightlyDatabaseCleanup();

    const left = await db.selectFrom('date_fix_batch').select('id').where('userId', '=', user.id).execute();
    expect(left).toEqual([{ id: recent.id }]);
  });
});
