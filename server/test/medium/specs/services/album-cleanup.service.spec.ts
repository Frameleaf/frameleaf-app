import { BadRequestException, ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { AlbumCleanupOperation } from 'src/dtos/album-cleanup.dto.js';
import { AlbumSourceKind, AlbumSourceOutcome } from 'src/dtos/album-source.dto.js';
import { AlbumKind, AlbumUserRole, AssetLockReason, JobName, JobStatus, QueueName, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumChangeRunRepository } from 'src/repositories/album-change-run.repository.js';
import { AlbumCleanupRepository } from 'src/repositories/album-cleanup.repository.js';
import { AlbumSourceRepository } from 'src/repositories/album-source.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';
import { AlbumChangeRunService } from 'src/services/album-change-run.service.js';
import { AlbumCleanupService } from 'src/services/album-cleanup.service.js';
import { AlbumMergeService } from 'src/services/album-merge.service.js';
import { AlbumSourceService } from 'src/services/album-source.service.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const services = newMediumService(AlbumCleanupService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumChangeRunRepository,
      AlbumCleanupRepository,
      AlbumRepository,
      AlbumSourceRepository,
      AlbumUserRepository,
      AssetRepository,
      ClassificationRepository,
      PartnerOriginRepository,
      PartnerRepository,
      SmartAlbumRepository,
      UserRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  const jobs = services.ctx.getMock(JobRepository);
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  jobs.queue.mockResolvedValue();
  jobs.queueAll.mockResolvedValue();
  jobs.queueInTransaction.mockResolvedValue();
  jobs.hasDedupJob.mockResolvedValue(false);
  return {
    ...services,
    runs: BaseService.create(AlbumChangeRunService, services.sut),
    merges: BaseService.create(AlbumMergeService, services.sut),
    sources: BaseService.create(AlbumSourceService, services.sut),
    repository: services.ctx.get(AlbumCleanupRepository),
    changeRuns: services.ctx.get(AlbumChangeRunRepository),
  };
};

type Context = ReturnType<typeof setup>['ctx'];

const elevated = (user: { id: string }) =>
  factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
const plain = (user: { id: string }) => factory.auth({ user: { id: user.id } });

const albumOf = async (
  ctx: Context,
  ownerId: string,
  albumName: string,
  count: number,
  dto: { createdAt?: Date } = {},
) => {
  const assets = await Promise.all(Array.from({ length: count }, () => ctx.newAsset({ ownerId })));
  const assetIds = assets.map(({ asset }) => asset.id);
  const { album } = await ctx.newAlbum({ ownerId, albumName, ...dto }, assetIds);
  return { album, assetIds };
};

const lock = (ctx: Context, assetIds: string[], lockedBy: string) =>
  ctx.database
    .insertInto('asset_lock')
    .values(assetIds.map((assetId) => ({ assetId, reason: AssetLockReason.Marked, lockedBy })))
    .execute();

const albumRow = (db: Kysely<DB>, id: string) =>
  db.selectFrom('album').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

const members = async (db: Kysely<DB>, albumId: string) =>
  (await db.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute())
    .map(({ assetId }) => assetId)
    .toSorted();

/** Applies and runs the job the apply queued, as the worker would. */
const applyNow = async (
  sut: AlbumCleanupService,
  auth: ReturnType<typeof plain>,
  operations: AlbumCleanupOperation[],
) => {
  const { runId } = await sut.apply(auth, { operations });
  await expect(sut.handleApply({ id: runId })).resolves.toBe(JobStatus.Success);
  return runId;
};

const newLink = async (ctx: Context, userId: string, albumId: string, sourceId = 'phone-album') => {
  const links = ctx.get(AlbumSourceRepository);
  return links.write((tx) =>
    links.create(tx, { userId, albumId, kind: AlbumSourceKind.IosPhotos, sourceId, deviceKey: null, name: sourceId }),
  );
};

const collectionsOf = (db: Kysely<DB>, userId: string) =>
  db
    .selectFrom('album')
    .innerJoin('album_user', 'album_user.albumId', 'album.id')
    .select('album.id')
    .where('album_user.userId', '=', userId)
    .where('album.kind', '=', AlbumKind.Collection)
    .where('album.deletedAt', 'is', null)
    .execute();

const runRow = (db: Kysely<DB>, id: string) =>
  db.selectFrom('album_change_run').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumCleanupService.name, () => {
  describe('scan', () => {
    it('gives a session without the PIN nothing computed from Locked photos', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const open = await albumOf(ctx, user.id, 'Holiday', 2);
      const mostlyLocked = await albumOf(ctx, user.id, 'Holiday', 5);
      await lock(ctx, mostlyLocked.assetIds.slice(1), user.id);
      await ctx.newExif({ assetId: mostlyLocked.assetIds[1], latitude: 20.8, longitude: -156.3, city: 'Lahaina' });
      await ctx.newExif({ assetId: open.assetIds[0], latitude: 49.3, longitude: -122.8, city: 'Coquitlam' });

      await sut.handleScan({ userId: user.id });

      const { facts: ordinary } = await sut.getSnapshot(plain(user));
      const { facts: full } = await sut.getSnapshot(elevated(user));

      const ordinaryLocked = ordinary!.albums.find(({ id }) => id === mostlyLocked.album.id)!;
      expect(ordinaryLocked).toMatchObject({ count: 1, gps: null });
      expect(full!.albums.find(({ id }) => id === mostlyLocked.album.id)).toMatchObject({
        count: 5,
        gps: { city: 'Lahaina' },
      });
      expect(ordinary!.homeAreas.map(({ city }) => city)).toEqual(['Coquitlam']);
      expect(new Set(full!.homeAreas.map(({ city }) => city))).toEqual(new Set(['Coquitlam', 'Lahaina']));

      // The winner comes from true counts in both, and is all a session without the PIN learns of them.
      expect(ordinary!.sameName).toEqual([expect.objectContaining({ winnerId: mostlyLocked.album.id, union: 3 })]);
      expect(full!.sameName).toEqual([expect.objectContaining({ winnerId: mostlyLocked.album.id, union: 7 })]);
      expect(JSON.stringify(ordinary)).not.toContain('Lahaina');
    });

    it('leaves Locked photos out of the overlap a session without the PIN sees', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const first = await albumOf(ctx, user.id, 'First', 3);
      const { album: second } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Second' }, first.assetIds);
      await lock(ctx, first.assetIds, user.id);

      await sut.handleScan({ userId: user.id });

      await expect(sut.getSnapshot(plain(user))).resolves.toMatchObject({ facts: { samePhotos: [] } });
      await expect(sut.getSnapshot(elevated(user))).resolves.toMatchObject({
        facts: { samePhotos: [expect.objectContaining({ union: 3, share: 1 })] },
      });
      expect(second.id).toBeDefined();
    });

    it('still gives a list for a person with no located photos and an empty album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Nothing here' }, []);

      await sut.handleScan({ userId: user.id });

      await expect(sut.getSnapshot(plain(user))).resolves.toMatchObject({
        ready: true,
        facts: {
          albums: [{ id: album.id, count: 0, gps: null, span: null, coverAssetId: null }],
          homeAreas: [],
        },
      });
    });

    it('lists the whole Albums page, and only owned plain albums can change', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { album: collection } = await ctx.newAlbum({
        ownerId: user.id,
        albumName: 'Trips',
        kind: AlbumKind.Collection,
      });
      const { album: inside } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Inside', parentId: collection.id });
      await ctx.newAlbum({ ownerId: other.id, albumName: 'Theirs' });
      const { album: withMe } = await ctx.newAlbum({
        ownerId: other.id,
        albumName: 'With me',
        parentId: collection.id,
      });
      await ctx.newAlbumUser({ albumId: withMe.id, userId: user.id, role: AlbumUserRole.Viewer });
      const top = await albumOf(ctx, user.id, 'Mine', 1);

      await sut.handleScan({ userId: user.id });

      const { facts } = await sut.getSnapshot(plain(user));
      const row = (albumName: string) => facts!.albums.find(({ name }) => name === albumName);
      expect(facts!.albums.map(({ name }) => name).toSorted()).toEqual(['Inside', 'Mine', 'Trips', 'With me']);
      expect(row('Mine')).toMatchObject({ id: top.album.id, parentId: null, readOnly: false });
      expect(row('Inside')).toMatchObject({ id: inside.id, parentId: collection.id, readOnly: false });
      expect(row('Trips')).toMatchObject({ id: collection.id, readOnly: true });
      // Someone else's album doesn't say where it is filed.
      expect(row('With me')).toMatchObject({ parentId: null, readOnly: true });
      expect(facts!.collections.map(({ id }) => id)).toEqual([collection.id]);
    });

    it('asks for a new scan when none has run, without blocking the answer', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      await expect(sut.getStatus(plain(user))).resolves.toMatchObject({ ready: false, checking: true, apply: null });
      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: 'AlbumCleanupScan',
        data: { userId: user.id },
      });
    });

    // FL-1404: the only scan ran before any album existed, and the page said there was nothing to tidy.
    it('scans again after albums are created, renamed or deleted, and not otherwise', async () => {
      const { sut, ctx } = setup();
      const jobs = ctx.getMock(JobRepository);
      const { user } = await ctx.newUser();
      const scan = { name: 'AlbumCleanupScan', data: { userId: user.id } };

      await sut.handleScan({ userId: user.id });
      await expect(sut.getStatus(plain(user))).resolves.toMatchObject({
        ready: true,
        checking: false,
        suggestionCount: 0,
      });
      expect(jobs.queue).not.toHaveBeenCalled();

      const { album: first } = await albumOf(ctx, user.id, 'To print', 1);
      await albumOf(ctx, user.id, 'to print', 1);
      await expect(sut.getStatus(plain(user))).resolves.toMatchObject({ checking: true, suggestionCount: 0 });
      expect(jobs.queue).toHaveBeenCalledExactlyOnceWith(scan);

      await sut.handleScan({ userId: user.id });
      await expect(sut.getStatus(plain(user))).resolves.toMatchObject({ checking: false, suggestionCount: 2 });
      const found = await sut.getSnapshot(plain(user));
      expect(found.checking).toBe(false);
      expect(found.facts!.sameName).toHaveLength(1);
      expect(jobs.queue).toHaveBeenCalledOnce();

      await ctx.get(AlbumRepository).update(first.id, { albumName: 'Printed' }, user.id);
      await expect(sut.getSnapshot(plain(user))).resolves.toMatchObject({ checking: true });
      expect(jobs.queue).toHaveBeenCalledTimes(2);
      await sut.handleScan({ userId: user.id });
      await expect(sut.getStatus(plain(user))).resolves.toMatchObject({ checking: false, suggestionCount: 0 });

      await ctx.get(AlbumRepository).delete(first.id);
      await expect(sut.getStatus(plain(user))).resolves.toMatchObject({ checking: true });
      expect(jobs.queue).toHaveBeenCalledTimes(3);
      expect(jobs.queue).toHaveBeenLastCalledWith(scan);
    });

    it('says a scan is waiting rather than asking for another', async () => {
      const { sut, ctx } = setup();
      const jobs = ctx.getMock(JobRepository);
      const { user } = await ctx.newUser();
      await sut.handleScan({ userId: user.id });
      await albumOf(ctx, user.id, 'Trip', 1);
      jobs.hasDedupJob.mockResolvedValue(true);

      await expect(sut.getStatus(plain(user))).resolves.toMatchObject({ ready: true, checking: true });
      await expect(sut.getSnapshot(plain(user))).resolves.toMatchObject({ ready: true, checking: true });
      expect(jobs.hasDedupJob).toHaveBeenCalledWith(QueueName.BackgroundTask, `AlbumCleanupScan:${user.id}`);
      expect(jobs.queue).not.toHaveBeenCalled();
    });

    it('scans now when asked to check again', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      await sut.handleScan({ userId: user.id });
      await sut.check(plain(user));
      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledExactlyOnceWith({
        name: 'AlbumCleanupScan',
        data: { userId: user.id },
      });
    });

    it('scans overnight for everyone with albums', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: albumless } = await ctx.newUser();
      await albumOf(ctx, user.id, 'Trip', 1);

      await sut.onNightlyDatabaseCleanup();

      const [queued] = ctx.getMock(JobRepository).queueAll.mock.calls[0];
      expect(queued).toContainEqual({ name: 'AlbumCleanupScan', data: { userId: user.id } });
      expect(queued).not.toContainEqual({ name: 'AlbumCleanupScan', data: { userId: albumless.id } });
    });
  });

  describe('validation', () => {
    it('refuses an album that is not the person’s', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const theirs = await albumOf(ctx, other.id, 'Theirs', 1);
      await expect(
        sut.apply(plain(user), {
          operations: [{ type: 'rename', albumId: theirs.album.id, name: 'Mine now' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('merges a shared album only with the explicit flag', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: friend } = await ctx.newUser();
      const a = await albumOf(ctx, user.id, 'Patrick', 2);
      const b = await albumOf(ctx, user.id, 'Patrick', 1);
      await ctx.newAlbumUser({ albumId: b.album.id, userId: friend.id, role: AlbumUserRole.Viewer });
      const albumIds = [a.album.id, b.album.id];

      await expect(sut.apply(plain(user), { operations: [{ type: 'merge', albumIds }] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(applyNow(sut, plain(user), [{ type: 'merge', albumIds, allowShared: true }])).resolves.toBeDefined();
    });

    it('refuses to remove a named or a shared album, and to combine a shared one', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const named = await albumOf(ctx, user.id, 'Holiday', 1);
      const dated = await albumOf(ctx, user.id, 'May 24, 2020', 1);
      const other = await albumOf(ctx, user.id, 'May 25, 2020', 1);
      await ctx.database
        .insertInto('shared_link')
        .values({
          userId: user.id,
          albumId: dated.album.id,
          key: Buffer.from('cleanup-link'),
          type: SharedLinkType.Album,
          allowUpload: false,
        })
        .execute();

      for (const operation of [
        { type: 'remove', albumId: named.album.id },
        { type: 'remove', albumId: dated.album.id },
        { type: 'combine', albumIds: [dated.album.id, other.album.id], name: 'Days' },
      ] as AlbumCleanupOperation[]) {
        await expect(sut.apply(plain(user), { operations: [operation] })).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('refuses a second cleanup while one is running', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const album = await albumOf(ctx, user.id, 'Holiday', 1);
      const operations: AlbumCleanupOperation[] = [{ type: 'rename', albumId: album.album.id, name: 'One' }];
      await sut.apply(plain(user), { operations });
      await expect(sut.apply(plain(user), { operations })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('apply', () => {
    it('nests, renames, merges and combines, recording everything', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const big = await albumOf(ctx, user.id, 'Friends - Patrick', 3);
      const small = await albumOf(ctx, user.id, 'Friends - Patrick', 1);
      const dayOne = await albumOf(ctx, user.id, 'Coquitlam, May 24, 2020', 1);
      const dayTwo = await albumOf(ctx, user.id, 'Coquitlam, May 25, 2020', 2);

      const runId = await applyNow(sut, plain(user), [
        { type: 'createCollection', tempId: 'friends', name: 'Friends', parentId: null },
        { type: 'merge', albumIds: [small.album.id, big.album.id] },
        { type: 'rename', albumId: big.album.id, name: 'Patrick' },
        { type: 'move', albumId: big.album.id, parentTempId: 'friends' },
        { type: 'combine', albumIds: [dayOne.album.id, dayTwo.album.id], name: 'Coquitlam, May 24–25, 2020' },
      ]);

      const parent = await albumRow(ctx.database, (await albumRow(ctx.database, big.album.id)).parentId!);
      expect(parent).toMatchObject({ albumName: 'Friends', kind: AlbumKind.Collection });
      await expect(albumRow(ctx.database, big.album.id)).resolves.toMatchObject({ albumName: 'Patrick' });
      await expect(members(ctx.database, big.album.id)).resolves.toEqual(
        [...big.assetIds, ...small.assetIds].toSorted(),
      );
      expect((await albumRow(ctx.database, small.album.id)).deletedAt).toBeInstanceOf(Date);
      await expect(albumRow(ctx.database, dayTwo.album.id)).resolves.toMatchObject({
        albumName: 'Coquitlam, May 24–25, 2020',
      });
      expect((await albumRow(ctx.database, dayOne.album.id)).deletedAt).toBeInstanceOf(Date);
      await expect(runRow(ctx.database, runId)).resolves.toMatchObject({
        status: AlbumChangeRunStatus.Done,
        summary: { collections: 1, merged: 1, combined: 1, moved: 1, renamed: 2 },
      });
    });

    it('merges by name and then combines the result with the next day', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const first = await albumOf(ctx, user.id, 'Coquitlam, May 24, 2020', 3);
      const copy = await albumOf(ctx, user.id, 'Coquitlam, May 24, 2020', 1);
      const next = await albumOf(ctx, user.id, 'Coquitlam, May 25, 2020', 1);

      await applyNow(sut, plain(user), [
        { type: 'merge', albumIds: [first.album.id, copy.album.id] },
        { type: 'combine', albumIds: [first.album.id, next.album.id], name: 'Coquitlam, May 24–25, 2020' },
      ]);

      await expect(albumRow(ctx.database, first.album.id)).resolves.toMatchObject({
        albumName: 'Coquitlam, May 24–25, 2020',
      });
      await expect(members(ctx.database, first.album.id)).resolves.toHaveLength(5);
    });

    it('reuses an existing collection of that name instead of making another', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { album: existing } = await ctx.newAlbum({
        ownerId: user.id,
        albumName: 'Trips',
        kind: AlbumKind.Collection,
      });
      const album = await albumOf(ctx, user.id, 'Disney', 1);

      await applyNow(sut, plain(user), [
        { type: 'createCollection', tempId: 'trips', name: 'trips', parentId: null },
        { type: 'move', albumId: album.album.id, parentTempId: 'trips' },
      ]);

      await expect(albumRow(ctx.database, album.album.id)).resolves.toMatchObject({ parentId: existing.id });
      await expect(collectionsOf(ctx.database, user.id)).resolves.toHaveLength(1);
    });

    it('heals approved dates first, in its own record, and Undo puts them back', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const dates = await Promise.all(
        [0, 1, 2, 3, 4, 5].map(async (index) => {
          const date = new Date(`2019-07-${String(3 + index).padStart(2, '0')}T12:00:00Z`);
          const { asset } = await ctx.newAsset({
            ownerId: user.id,
            originalFileName: `IMG_${1000 + index * 2}.JPG`,
            fileCreatedAt: date,
            localDateTime: date,
          });
          await ctx.newExif({ assetId: asset.id, make: 'Apple', model: 'iPhone', dateTimeOriginal: date });
          return asset.id;
        }),
      );
      const lostOn = new Date('2023-02-14T10:00:00Z');
      const { asset: lostPhoto } = await ctx.newAsset({
        ownerId: user.id,
        originalFileName: 'Takeout_9.jpg',
        fileCreatedAt: lostOn,
        localDateTime: lostOn,
      });
      await ctx.newExif({ assetId: lostPhoto.id, dateTimeOriginal: lostOn });
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Trip' }, [...dates, lostPhoto.id]);
      const auth = plain(user);
      await sut.handleScan({ userId: user.id });
      const { facts } = await sut.getSnapshot(auth);
      expect(facts!.lostDates).toEqual([expect.objectContaining({ albumId: album.id })]);

      const runId = await applyNow(sut, auth, [
        { type: 'rename', albumId: album.id, name: 'Summer trip' },
        { type: 'heal', albumId: album.id, assetIds: [lostPhoto.id] },
      ]);

      const taken = () =>
        ctx.database
          .selectFrom('asset')
          .select('fileCreatedAt')
          .where('id', '=', lostPhoto.id)
          .executeTakeFirstOrThrow();
      expect((await taken()).fileCreatedAt.getUTCFullYear()).toBe(2019);
      const { summary } = await runRow(ctx.database, runId);
      expect(summary).toMatchObject({ healed: 1, renamed: 1 });
      expect(summary).not.toHaveProperty('lockedHealed');

      await runs.undoLatest(auth);
      expect((await taken()).fileCreatedAt.getUTCFullYear()).toBe(2023);
      await expect(albumRow(ctx.database, album.id)).resolves.toMatchObject({ albumName: 'Trip' });
    });

    it('keeps the photos when an album is removed', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const dated = await albumOf(ctx, user.id, 'May 24, 2020', 2);
      const runId = await applyNow(sut, plain(user), [{ type: 'remove', albumId: dated.album.id }]);

      expect((await albumRow(ctx.database, dated.album.id)).deletedAt).toBeInstanceOf(Date);
      for (const id of dated.assetIds) {
        await expect(
          ctx.database.selectFrom('asset').select('id').where('id', '=', id).where('deletedAt', 'is', null).execute(),
        ).resolves.toHaveLength(1);
      }
      await expect(runRow(ctx.database, runId)).resolves.toMatchObject({ summary: { removed: 1 } });
    });
  });

  describe('a run that stops partway (Review Focus 3)', () => {
    it('does not end a run whose job is still waiting to run', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { album } = await albumOf(ctx, user.id, 'First', 1);
      const auth = plain(user);
      const { runId } = await sut.apply(auth, {
        operations: [{ type: 'rename', albumId: album.id, name: 'Renamed' }],
      });
      await ctx.database
        .updateTable('album_cleanup_apply')
        .set({ progressAt: new Date(0) })
        .where('runId', '=', runId)
        .execute();
      const { findOpenJob } = ctx.getMock(JobRepository);

      findOpenJob.mockResolvedValueOnce({ id: 'job', active: false });
      await expect(sut.getStatus(auth)).resolves.toMatchObject({ apply: { status: AlbumChangeRunStatus.Running } });
      expect(findOpenJob).toHaveBeenCalledWith(QueueName.BackgroundTask, JobName.AlbumCleanupApply, runId);

      findOpenJob.mockResolvedValueOnce(undefined);
      await expect(sut.getStatus(auth)).resolves.toMatchObject({ apply: { status: AlbumChangeRunStatus.Failed } });
    });

    it('takes back the operation in progress and keeps the outcome when the run has ended', async () => {
      const { sut, ctx, repository } = setup();
      const { user } = await ctx.newUser();
      const { album } = await albumOf(ctx, user.id, 'First', 1);
      const { runId } = await sut.apply(plain(user), {
        operations: [{ type: 'rename', albumId: album.id, name: 'Renamed' }],
      });
      const getCollections = repository.getCollections.bind(repository);
      vi.spyOn(repository, 'getCollections').mockImplementationOnce(async (...args) => {
        await ctx.database
          .updateTable('album_change_run')
          .set({ status: AlbumChangeRunStatus.Undone })
          .where('id', '=', runId)
          .execute();
        return getCollections(...args);
      });

      await expect(sut.handleApply({ id: runId })).resolves.toBe(JobStatus.Skipped);

      await expect(albumRow(ctx.database, album.id)).resolves.toMatchObject({ albumName: 'First' });
      await expect(runRow(ctx.database, runId)).resolves.toMatchObject({ status: AlbumChangeRunStatus.Undone });
    });

    it('keeps the reviewed name when a different album has become the largest', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const reviewed = await albumOf(ctx, user.id, 'Reviewed', 1);
      const larger = await albumOf(ctx, user.id, 'Larger', 3);

      await applyNow(sut, plain(user), [{ type: 'merge', albumIds: [reviewed.album.id, larger.album.id] }]);

      await expect(albumRow(ctx.database, larger.album.id)).resolves.toMatchObject({
        albumName: 'Reviewed',
        deletedAt: null,
      });
    });

    it('can still reach an album whose merge was skipped', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const base = await albumOf(ctx, user.id, 'Base', 3);
      const one = await albumOf(ctx, user.id, 'One', 2);
      const two = await albumOf(ctx, user.id, 'Two', 1);
      const original = AlbumMergeService.prototype.mergeInto;
      const mergeInto = vi
        .spyOn(AlbumMergeService.prototype, 'mergeInto')
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new BadRequestException('changed'));

      const runId = await applyNow(sut, plain(user), [
        { type: 'merge', albumIds: [base.album.id, one.album.id, two.album.id] },
        { type: 'rename', albumId: one.album.id, name: 'One renamed' },
      ]);
      mergeInto.mockRestore();

      await expect(albumRow(ctx.database, one.album.id)).resolves.toMatchObject({
        albumName: 'One renamed',
        deletedAt: null,
      });
      await expect(runRow(ctx.database, runId)).resolves.toMatchObject({ summary: { renamed: 1, skipped: 1 } });
    });

    it('keeps what it did, then resumes without repeating it', async () => {
      const { sut, ctx, repository, changeRuns, runs } = setup();
      const { user } = await ctx.newUser();
      const first = await albumOf(ctx, user.id, 'First', 1);
      const second = await albumOf(ctx, user.id, 'Second', 1);
      const third = await albumOf(ctx, user.id, 'Third', 1);
      const auth = plain(user);
      const { runId } = await sut.apply(auth, {
        operations: [
          { type: 'rename', albumId: first.album.id, name: 'First renamed' },
          { type: 'rename', albumId: second.album.id, name: 'Second renamed' },
          { type: 'rename', albumId: third.album.id, name: 'Third renamed' },
        ],
      });

      // The process dies after the first change commits: nothing gets to mark the run failed.
      const original = repository.advanceApply.bind(repository);
      const advance = vi
        .spyOn(repository, 'advanceApply')
        .mockImplementationOnce(original)
        .mockImplementationOnce(() => Promise.reject(new Error('process died')));
      const finish = vi.spyOn(changeRuns, 'finishRun').mockResolvedValue();
      await expect(sut.handleApply({ id: runId })).rejects.toThrow('process died');
      advance.mockRestore();
      finish.mockRestore();

      await expect(albumRow(ctx.database, first.album.id)).resolves.toMatchObject({ albumName: 'First renamed' });
      await expect(albumRow(ctx.database, second.album.id)).resolves.toMatchObject({ albumName: 'Second' });
      await expect(runRow(ctx.database, runId)).resolves.toMatchObject({ status: AlbumChangeRunStatus.Running });
      await expect(runs.getLatest(auth)).resolves.toMatchObject({ run: { canUndo: false } });

      await expect(sut.handleApply({ id: runId })).resolves.toBe(JobStatus.Success);

      await expect(albumRow(ctx.database, second.album.id)).resolves.toMatchObject({ albumName: 'Second renamed' });
      await expect(albumRow(ctx.database, third.album.id)).resolves.toMatchObject({ albumName: 'Third renamed' });
      await expect(runRow(ctx.database, runId)).resolves.toMatchObject({
        status: AlbumChangeRunStatus.Done,
        summary: { renamed: 3 },
      });
      await expect(
        ctx.database.selectFrom('album_change').select('seq').where('runId', '=', runId).execute(),
      ).resolves.toHaveLength(3);

      await runs.undoLatest(auth);
      await expect(albumRow(ctx.database, first.album.id)).resolves.toMatchObject({ albumName: 'First' });
      await expect(albumRow(ctx.database, third.album.id)).resolves.toMatchObject({ albumName: 'Third' });
    });

    it('stays undoable when the run fails', async () => {
      const { sut, ctx, repository, runs } = setup();
      const { user } = await ctx.newUser();
      const first = await albumOf(ctx, user.id, 'First', 1);
      const second = await albumOf(ctx, user.id, 'Second', 1);
      const auth = plain(user);
      const { runId } = await sut.apply(auth, {
        operations: [
          { type: 'rename', albumId: first.album.id, name: 'First renamed' },
          { type: 'rename', albumId: second.album.id, name: 'Second renamed' },
        ],
      });

      const original = repository.advanceApply.bind(repository);
      const advance = vi
        .spyOn(repository, 'advanceApply')
        .mockImplementationOnce(original)
        .mockImplementationOnce(() => Promise.reject(new Error('boom')));
      await expect(sut.handleApply({ id: runId })).rejects.toThrow('boom');
      advance.mockRestore();

      await expect(runRow(ctx.database, runId)).resolves.toMatchObject({ status: AlbumChangeRunStatus.Failed });
      await expect(runs.getLatest(auth)).resolves.toMatchObject({ run: { canUndo: true } });
      await runs.undoLatest(auth);
      await expect(albumRow(ctx.database, first.album.id)).resolves.toMatchObject({ albumName: 'First' });
    });
  });

  describe('Undo after a later edit (Review Focus 4)', () => {
    it('leaves the later rename alone, takes back the rest, and reports what it skipped', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const album = await albumOf(ctx, user.id, 'Friends - Patrick', 2);
      const other = await albumOf(ctx, user.id, 'Friends - Sarah', 1);
      const auth = plain(user);
      await applyNow(sut, auth, [
        { type: 'createCollection', tempId: 'friends', name: 'Friends', parentId: null },
        { type: 'rename', albumId: album.album.id, name: 'Patrick' },
        { type: 'move', albumId: album.album.id, parentTempId: 'friends' },
        { type: 'rename', albumId: other.album.id, name: 'Sarah' },
        { type: 'move', albumId: other.album.id, parentTempId: 'friends' },
      ]);
      await ctx.database
        .updateTable('album')
        .set({ albumName: 'Pat, my friend' })
        .where('id', '=', album.album.id)
        .execute();

      const outcome = await runs.undoLatest(auth);

      expect(outcome.skipped).toEqual(['Pat, my friend']);
      await expect(albumRow(ctx.database, album.album.id)).resolves.toMatchObject({
        albumName: 'Pat, my friend',
        parentId: null,
      });
      await expect(albumRow(ctx.database, other.album.id)).resolves.toMatchObject({
        albumName: 'Friends - Sarah',
        parentId: null,
      });
      await expect(collectionsOf(ctx.database, user.id)).resolves.toHaveLength(0);
    });

    it('keeps a collection the person has since put something else in', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const album = await albumOf(ctx, user.id, 'Disney', 1);
      const later = await albumOf(ctx, user.id, 'Added by hand', 1);
      const auth = plain(user);
      await applyNow(sut, auth, [
        { type: 'createCollection', tempId: 'trips', name: 'Trips', parentId: null },
        { type: 'move', albumId: album.album.id, parentTempId: 'trips' },
      ]);
      const { parentId } = await albumRow(ctx.database, album.album.id);
      await ctx.get(AlbumRepository).reparent(later.album.id, parentId);

      const outcome = await runs.undoLatest(auth);

      expect(outcome.skipped).toEqual(['Trips']);
      await expect(albumRow(ctx.database, parentId!)).resolves.toMatchObject({ deletedAt: null });
    });
  });

  describe('a phone sync after a cleanup (Review Focus 5)', () => {
    it('does not bring back a removed album, and answers the phone without an error', async () => {
      const { sut, ctx, sources, runs } = setup();
      const { user } = await ctx.newUser();
      const dated = await albumOf(ctx, user.id, 'May 24, 2020', 1);
      const linkId = await newLink(ctx, user.id, dated.album.id, 'May 24, 2020');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const auth = plain(user);
      const source = { kind: AlbumSourceKind.IosPhotos, sourceId: 'May 24, 2020', name: 'May 24, 2020' };

      await applyNow(sut, auth, [{ type: 'remove', albumId: dated.album.id }]);

      const { links } = await sources.resolve(auth, { sources: [source] });
      expect(links).toEqual([expect.objectContaining({ id: linkId, outcome: AlbumSourceOutcome.Existing })]);
      await expect(
        ctx.database
          .selectFrom('album')
          .select('id')
          .where('id', '!=', dated.album.id)
          .where('albumName', '=', 'May 24, 2020')
          .where('deletedAt', 'is', null)
          .where(({ exists, selectFrom }) =>
            exists(
              selectFrom('album_user')
                .select('album_user.albumId')
                .whereRef('album_user.albumId', '=', 'album.id')
                .where('album_user.userId', '=', user.id),
            ),
          )
          .execute(),
      ).resolves.toHaveLength(0);
      await expect(sources.addAssets(auth, linkId, { ids: [asset.id] })).resolves.toEqual([
        expect.objectContaining({ id: asset.id, success: false, error: 'duplicate' }),
      ]);
      await expect(members(ctx.database, dated.album.id)).resolves.toEqual(dated.assetIds);

      await runs.undoLatest(auth);

      await expect(albumRow(ctx.database, dated.album.id)).resolves.toMatchObject({ deletedAt: null });
      await expect(sources.resolve(auth, { sources: [source] })).resolves.toMatchObject({
        links: [{ id: linkId, albumId: dated.album.id, outcome: AlbumSourceOutcome.Existing }],
      });
      await expect(sources.addAssets(auth, linkId, { ids: [asset.id] })).resolves.toEqual([
        expect.objectContaining({ id: asset.id, success: true }),
      ]);
    });

    it('keeps the marker once the Undo window has passed, so the album still stays gone', async () => {
      const { sut, ctx, sources, runs } = setup();
      const { user } = await ctx.newUser();
      const dated = await albumOf(ctx, user.id, 'Jun 2, 2020', 1);
      const plainDated = await albumOf(ctx, user.id, 'Jun 3, 2020', 1);
      const linkId = await newLink(ctx, user.id, dated.album.id, 'Jun 2');
      const auth = plain(user);
      const runId = await applyNow(sut, auth, [
        { type: 'remove', albumId: dated.album.id },
        { type: 'remove', albumId: plainDated.album.id },
      ]);
      await ctx.database
        .updateTable('album_change_run')
        .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
        .where('id', '=', runId)
        .execute();

      await runs.purgeExpiredRuns();

      await expect(
        ctx.database.selectFrom('album').select('id').where('id', '=', plainDated.album.id).execute(),
      ).resolves.toHaveLength(0);
      await expect(
        sources.resolve(auth, {
          sources: [{ kind: AlbumSourceKind.IosPhotos, sourceId: 'Jun 2', name: 'Jun 2, 2020' }],
        }),
      ).resolves.toMatchObject({ links: [{ id: linkId, outcome: AlbumSourceOutcome.Existing }] });
    });

    it('follows a merged-away album to the album that stayed', async () => {
      const { sut, ctx, sources } = setup();
      const { user } = await ctx.newUser();
      const big = await albumOf(ctx, user.id, 'Summer', 2);
      const small = await albumOf(ctx, user.id, 'Summer', 1);
      const linkId = await newLink(ctx, user.id, small.album.id, 'phone-summer');
      const auth = plain(user);

      await applyNow(sut, auth, [{ type: 'merge', albumIds: [big.album.id, small.album.id] }]);

      await expect(
        sources.resolve(auth, {
          sources: [{ kind: AlbumSourceKind.IosPhotos, sourceId: 'phone-summer', name: 'Summer' }],
        }),
      ).resolves.toMatchObject({
        links: [{ id: linkId, albumId: big.album.id, outcome: AlbumSourceOutcome.Existing }],
      });
    });
  });
});
