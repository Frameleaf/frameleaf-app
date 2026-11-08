import { Kysely } from 'kysely';
import { mapExif } from 'src/dtos/exif.dto.js';
import { AlbumUserRole, AssetLockReason, JobName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumChangeRunRepository } from 'src/repositories/album-change-run.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';
import { AlbumChangeRunService } from 'src/services/album-change-run.service.js';
import { AlbumDateHealService } from 'src/services/album-date-heal.service.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const services = newMediumService(AlbumDateHealService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumChangeRunRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      PartnerOriginRepository,
      UserRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  services.ctx.getMock(JobRepository).queue.mockResolvedValue();
  services.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  services.ctx.getMock(JobRepository).queueInTransaction.mockResolvedValue();
  return { ...services, runs: BaseService.create(AlbumChangeRunService, services.sut) };
};

type Context = ReturnType<typeof setup>['ctx'];

const START = '2019-07-03';
const LOST_ON = '2023-02-14T10:00:00Z';
const dayAt = (index: number) => new Date(`2019-07-${String(3 + index).padStart(2, '0')}T12:00:00Z`);

/** A photo with camera details, in the album's stretch. */
const dated = async (
  ctx: Context,
  ownerId: string,
  index: number,
  originalFileName = `IMG_${1000 + index * 2}.JPG`,
) => {
  const date = dayAt(index);
  const { asset } = await ctx.newAsset({ ownerId, originalFileName, fileCreatedAt: date, localDateTime: date });
  await ctx.newExif({ assetId: asset.id, make: 'Apple', model: 'iPhone', dateTimeOriginal: date });
  return asset.id;
};

/** A photo the server dated from the file, years after the album. */
const lost = async (ctx: Context, ownerId: string, originalFileName: string, overrides: object = {}) => {
  const date = new Date(LOST_ON);
  const { asset } = await ctx.newAsset({ ownerId, originalFileName, fileCreatedAt: date, localDateTime: date });
  await ctx.newExif({ assetId: asset.id, dateTimeOriginal: date, ...overrides });
  return asset.id;
};

const album = async (ctx: Context, ownerId: string, ids: string[]) => (await ctx.newAlbum({ ownerId }, ids)).album.id;

const lock = (ctx: Context, assetId: string, lockedBy: string) =>
  ctx.database.insertInto('asset_lock').values({ assetId, reason: AssetLockReason.Marked, lockedBy }).execute();

const elevated = (id: string) => factory.auth({ user: { id }, session: { hasElevatedPermission: true } });
const plain = (id: string) => factory.auth({ user: { id } });

const exifOf = (ctx: Context, assetId: string) =>
  ctx.database.selectFrom('asset_exif').selectAll().where('assetId', '=', assetId).executeTakeFirstOrThrow();
const assetOf = (ctx: Context, assetId: string) =>
  ctx.database
    .selectFrom('asset')
    .select(['fileCreatedAt', 'localDateTime'])
    .where('id', '=', assetId)
    .executeTakeFirstOrThrow();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** FL-1299: a lost date, healed from the album around it, always with approval and always undoable. */
describe(AlbumDateHealService.name, () => {
  const sixDated = (ctx: Context, ownerId: string) =>
    Promise.all([0, 1, 2, 3, 4, 5].map((i) => dated(ctx, ownerId, i)));

  describe('getLostDates', () => {
    it('offers a lost photo the date the album suggests', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const ids = await sixDated(ctx, user.id);
      const between = await lost(ctx, user.id, 'IMG_1003.JPG');
      const other = await lost(ctx, user.id, 'Takeout_9.jpg');
      const id = await album(ctx, user.id, [...ids, between, other]);

      const result = await sut.getLostDates(plain(user.id), id);

      expect(result).toMatchObject({ eligible: true, reason: null, from: START, to: '2019-07-08' });
      expect(result.suggestions).toHaveLength(2);
      expect(result.suggestions.find(({ assetId }) => assetId === between)).toMatchObject({
        precision: 'exact',
        day: '2019-07-04',
        shownDay: '2023-02-14',
        between: { before: 'IMG_1002.JPG', after: 'IMG_1004.JPG' },
      });
      expect(result.suggestions.find(({ assetId }) => assetId === other)).toMatchObject({
        precision: 'around',
        between: null,
      });
    });

    it('explains an album too thin or too wide to say', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const thin = await album(ctx, user.id, [await dated(ctx, user.id, 0), await lost(ctx, user.id, 'x.jpg')]);
      await expect(sut.getLostDates(plain(user.id), thin)).resolves.toMatchObject({
        eligible: false,
        reason: 'few',
        from: null,
        suggestions: [],
      });
    });

    it('leaves Locked photos out of a session without the PIN, as evidence and as suggestions', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const ids = await sixDated(ctx, user.id);
      const lockedLost = await lost(ctx, user.id, 'locked-lost.jpg');
      const shownLost = await lost(ctx, user.id, 'shown-lost.jpg');
      // Locked, these two leave only four photos with camera details.
      await lock(ctx, ids[0], user.id);
      await lock(ctx, ids[1], user.id);
      await lock(ctx, lockedLost, user.id);
      const id = await album(ctx, user.id, [...ids, lockedLost, shownLost]);

      const withoutPin = await sut.getLostDates(plain(user.id), id);
      expect(withoutPin).toMatchObject({ eligible: false, reason: 'few', suggestions: [] });
      expect(JSON.stringify(withoutPin)).not.toContain('locked-lost');

      const withPin = await sut.getLostDates(elevated(user.id), id);
      expect(withPin.suggestions.map(({ fileName }) => fileName).sort()).toEqual(['locked-lost.jpg', 'shown-lost.jpg']);
    });

    it("never offers another member's photo, and still learns from it", async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const ids = await sixDated(ctx, owner.id);
      const theirs = await lost(ctx, owner.id, 'theirs.jpg');
      const mine = await lost(ctx, member.id, 'mine.jpg');
      const id = await album(ctx, owner.id, [...ids, theirs, mine]);
      await ctx.newAlbumUser({ albumId: id, userId: member.id, role: AlbumUserRole.Editor });

      const { suggestions } = await sut.getLostDates(plain(member.id), id);
      expect(suggestions.map(({ assetId }) => assetId)).toEqual([mine]);
    });

    it('does not offer a date someone set by hand', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const scan = await lost(ctx, user.id, 'scan.jpg', { lockedProperties: ['dateTimeOriginal'] });
      const id = await album(ctx, user.id, [...(await sixDated(ctx, user.id)), scan]);

      await expect(sut.getLostDates(plain(user.id), id)).resolves.toMatchObject({ eligible: true, suggestions: [] });
    });

    it('needs access to the album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();
      const id = await album(ctx, user.id, [await dated(ctx, user.id, 0)]);
      await expect(sut.getLostDates(plain(stranger.id), id)).rejects.toThrow();
    });
  });

  describe('heal', () => {
    it('writes the date as a manual edit does, marks it estimated and records it for Undo', async () => {
      const { sut, ctx } = setup();
      const job = ctx.getMock(JobRepository);
      const { user } = await ctx.newUser();
      const ids = await sixDated(ctx, user.id);
      const photo = await lost(ctx, user.id, 'IMG_1003.JPG');
      const id = await album(ctx, user.id, [...ids, photo]);

      const result = await sut.heal(plain(user.id), { albums: [{ albumId: id, assetIds: [photo] }] });

      expect(result).toMatchObject({ healed: 1, skipped: 0 });
      expect(result.runId).toEqual(expect.any(String));
      const healedAt = dayAt(1).getTime();
      expect((await assetOf(ctx, photo)).fileCreatedAt.getTime()).toBe(healedAt);
      expect((await assetOf(ctx, photo)).localDateTime.getTime()).toBe(healedAt);
      const exif = await exifOf(ctx, photo);
      expect(new Date(exif.dateTimeOriginal!).getTime()).toBe(healedAt);
      expect(exif.lockedProperties).toEqual(expect.arrayContaining(['dateTimeOriginal', 'timeZone']));
      expect(mapExif(exif as never).dateEstimated).toBe(true);
      // What an asset response is built from.
      const read = await ctx.get(AssetRepository).getById(photo, { exifInfo: true });
      expect(mapExif(read!.exifInfo as never).dateEstimated).toBe(true);
      expect(job.queueInTransaction).toHaveBeenCalledWith(expect.anything(), {
        name: JobName.SidecarWrite,
        data: { id: photo },
      });

      const change = await ctx.database
        .selectFrom('album_change')
        .selectAll()
        .where('runId', '=', result.runId!)
        .executeTakeFirstOrThrow();
      expect(change).toMatchObject({ kind: 'asset.date_healed', albumId: id, assetId: photo });
      expect((change.before as { fileCreatedAt: string }).fileCreatedAt).toBe(new Date(LOST_ON).toISOString());
    });

    it('takes which photos from the request and never the date, and ignores what it would not offer', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const ids = await sixDated(ctx, user.id);
      const id = await album(ctx, user.id, ids);

      await expect(
        sut.heal(plain(user.id), { albums: [{ albumId: id, assetIds: [ids[0], newUuid()] }] }),
      ).resolves.toEqual({ runId: null, healed: 0, skipped: 2 });
      expect((await assetOf(ctx, ids[0])).fileCreatedAt.getTime()).toBe(dayAt(0).getTime());
    });

    it('keeps a Locked photo out of reach of a session without the PIN', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const photo = await lost(ctx, user.id, 'locked.jpg');
      await lock(ctx, photo, user.id);
      const id = await album(ctx, user.id, [...(await sixDated(ctx, user.id)), photo]);

      await expect(sut.heal(plain(user.id), { albums: [{ albumId: id, assetIds: [photo] }] })).resolves.toEqual({
        runId: null,
        healed: 0,
        skipped: 1,
      });
      expect((await assetOf(ctx, photo)).fileCreatedAt.getTime()).toBe(new Date(LOST_ON).getTime());
    });

    it('heals a Locked photo with the PIN, and keeps it out of what a session without one can read', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const locked = await lost(ctx, user.id, 'locked.jpg');
      const shown = await lost(ctx, user.id, 'shown.jpg');
      await lock(ctx, locked, user.id);
      const id = await album(ctx, user.id, [...(await sixDated(ctx, user.id)), locked, shown]);

      await expect(
        sut.heal(elevated(user.id), { albums: [{ albumId: id, assetIds: [locked, shown] }] }),
      ).resolves.toMatchObject({ healed: 2, skipped: 0 });

      const { run } = await runs.getLatest(plain(user.id));
      expect(run).toMatchObject({ kind: 'heal', summary: { healed: 1 } });
    });

    it('does not leave a run with nothing in it to undo', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const photo = await lost(ctx, user.id, 'x.jpg');
      const id = await album(ctx, user.id, [...(await sixDated(ctx, user.id)), photo]);
      // Between the read and the write, someone sets the date.
      const original = sut.plan.bind(sut);
      vi.spyOn(sut, 'plan').mockImplementation(async (auth, dto) => {
        const items = await original(auth, dto);
        await ctx.get(AssetRepository).setDateTimeOriginal(photo, new Date('2001-01-01T00:00:00Z'));
        return items;
      });

      await expect(sut.heal(plain(user.id), { albums: [{ albumId: id, assetIds: [photo] }] })).resolves.toEqual({
        runId: null,
        healed: 0,
        skipped: 1,
      });
      await expect(runs.getLatest(plain(user.id))).resolves.toEqual({ run: null });
    });

    it('heals a photo in two approved albums only once', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const photo = await lost(ctx, user.id, 'x.jpg');
      const ids = await sixDated(ctx, user.id);
      const [first, second] = [await album(ctx, user.id, [...ids, photo]), await album(ctx, user.id, [...ids, photo])];

      const result = await sut.heal(plain(user.id), {
        albums: [
          { albumId: first, assetIds: [photo] },
          { albumId: second, assetIds: [photo] },
        ],
      });
      expect(result).toMatchObject({ healed: 1 });
      const changes = await ctx.database
        .selectFrom('album_change')
        .selectAll()
        .where('runId', '=', result.runId!)
        .execute();
      expect(changes).toHaveLength(1);
    });
  });

  describe('estimated dates are no evidence', () => {
    it('keeps a healed photo out of what the album says about itself, until its date is really set', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const repository = ctx.get(AlbumRepository).suggestions;
      const photo = await lost(ctx, user.id, 'x.jpg');
      const ids = await sixDated(ctx, user.id);
      const id = await album(ctx, user.id, [...ids, photo]);

      await sut.heal(plain(user.id), { albums: [{ albumId: id, assetIds: [photo] }] });
      expect((await repository.getTripPhotos(id, user.id)).map((row) => row.id).sort()).toEqual([...ids].sort());
      await expect(repository.getTimeSpan(id, user.id)).resolves.toEqual({
        from: dayAt(0),
        to: dayAt(5),
      });

      // Healed, it carries a time zone, which must not read as camera details.
      const healed = (await exifOf(ctx, photo)).timeZone;
      expect(healed).not.toBeNull();
      const row = (await repository.getHealPhotos(id, user.id, undefined)).find(({ id }) => id === photo)!;
      expect(row).toMatchObject({ dateEstimated: true, dateSet: true });

      const edited = new Date('2019-07-04T09:00:00Z');
      await ctx.get(AssetRepository).setDateTimeOriginal(photo, edited);
      expect((await repository.getHealPhotos(id, user.id, undefined)).find(({ id }) => id === photo)).toMatchObject({
        dateEstimated: false,
      });
      expect(mapExif((await exifOf(ctx, photo)) as never).dateEstimated).toBeUndefined();
      expect((await repository.getTripPhotos(id, user.id)).map((row) => row.id)).toContain(photo);
    });

    it('does not suggest a photo into a trip on the strength of its estimated date', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const repository = ctx.get(AlbumRepository).suggestions;
      const photo = await lost(ctx, user.id, 'x.jpg');
      const ids = await sixDated(ctx, user.id);
      const source = await album(ctx, user.id, [...ids, photo]);
      await sut.heal(plain(user.id), { albums: [{ albumId: source, assetIds: [photo] }] });
      const other = await album(ctx, user.id, ids.slice(0, 3));

      const windows = [{ from: dayAt(0), to: dayAt(5) }];
      expect((await repository.getTripCandidates(user.id, other, windows)).map(({ id }) => id)).not.toContain(photo);
      const [candidate] = await repository.getCandidates(user.id, other, [photo]);
      expect(candidate.hasCameraDetails).toBe(false);
    });
  });

  describe('Undo', () => {
    it('puts the date back, ends the estimate and queues the sidecar rewrite', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const ids = await sixDated(ctx, user.id);
      const photo = await lost(ctx, user.id, 'x.jpg');
      const id = await album(ctx, user.id, [...ids, photo]);
      const beforeTimeZone = (await exifOf(ctx, photo)).timeZone;
      const { runId } = await sut.heal(plain(user.id), { albums: [{ albumId: id, assetIds: [photo] }] });

      await expect(runs.undoLatest(plain(user.id))).resolves.toEqual({ reversed: 1, skipped: [] });

      const original = new Date(LOST_ON).getTime();
      expect((await assetOf(ctx, photo)).fileCreatedAt.getTime()).toBe(original);
      expect((await assetOf(ctx, photo)).localDateTime.getTime()).toBe(original);
      const exif = await exifOf(ctx, photo);
      expect(new Date(exif.dateTimeOriginal!).getTime()).toBe(original);
      expect(exif.timeZone).toBe(beforeTimeZone);
      expect(exif.estimatedDateTimeOriginal).toBeNull();
      // Held until the sidecar has the restored date; the job then lets go.
      expect(exif.lockedProperties).toContain('dateTimeOriginal');

      const jobs = await ctx.database
        .selectFrom('job')
        .select('data')
        .where('name', '=', JobName.SidecarWrite)
        .where('data', '@>', { id: photo } as never)
        .execute();
      expect(jobs).toEqual([{ data: expect.objectContaining({ id: photo, releaseDateLock: true }) }]);

      const run = await ctx.database
        .selectFrom('album_change_run')
        .select('status')
        .where('id', '=', runId!)
        .executeTakeFirstOrThrow();
      expect(run.status).toBe(AlbumChangeRunStatus.Undone);
    });

    it('leaves a date the person changed since, and says which', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const ids = await sixDated(ctx, user.id);
      const edited = await lost(ctx, user.id, 'edited.jpg');
      const untouched = await lost(ctx, user.id, 'untouched.jpg');
      const id = await album(ctx, user.id, [...ids, edited, untouched]);
      await sut.heal(plain(user.id), { albums: [{ albumId: id, assetIds: [edited, untouched] }] });

      const later = new Date('2020-02-02T02:02:02Z');
      await ctx.get(AssetRepository).setDateTimeOriginal(edited, later);

      await expect(runs.undoLatest(plain(user.id))).resolves.toEqual({ reversed: 1, skipped: ['edited.jpg'] });
      expect(new Date((await exifOf(ctx, edited)).dateTimeOriginal!).getTime()).toBe(later.getTime());
      expect((await assetOf(ctx, untouched)).fileCreatedAt.getTime()).toBe(new Date(LOST_ON).getTime());
    });

    it('restores a Locked photo for a session without the PIN but tells it nothing of the photo', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const locked = await lost(ctx, user.id, 'secret-restored.jpg');
      const lockedEdited = await lost(ctx, user.id, 'secret-edited.jpg');
      await lock(ctx, locked, user.id);
      await lock(ctx, lockedEdited, user.id);
      const id = await album(ctx, user.id, [...(await sixDated(ctx, user.id)), locked, lockedEdited]);
      await sut.heal(elevated(user.id), { albums: [{ albumId: id, assetIds: [locked, lockedEdited] }] });
      await ctx.get(AssetRepository).setDateTimeOriginal(lockedEdited, new Date('2020-02-02T02:02:02Z'));

      await expect(runs.undoLatest(plain(user.id))).resolves.toEqual({ reversed: 0, skipped: [] });
      expect((await assetOf(ctx, locked)).fileCreatedAt.getTime()).toBe(new Date(LOST_ON).getTime());
    });

    it('tells the session with the PIN about a Locked photo it skipped', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const locked = await lost(ctx, user.id, 'locked-edited.jpg');
      await lock(ctx, locked, user.id);
      const id = await album(ctx, user.id, [...(await sixDated(ctx, user.id)), locked]);
      await sut.heal(elevated(user.id), { albums: [{ albumId: id, assetIds: [locked] }] });
      await ctx.get(AssetRepository).setDateTimeOriginal(locked, new Date('2020-02-02T02:02:02Z'));

      await expect(runs.undoLatest(elevated(user.id))).resolves.toEqual({
        reversed: 0,
        skipped: ['locked-edited.jpg'],
      });
    });
  });
});
