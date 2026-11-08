import { BadRequestException, ConflictException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AlbumSourceKind, AlbumSourceOutcome } from 'src/dtos/album-source.dto.js';
import { AlbumKind, AlbumUserRole, AssetLockReason, SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumChangeRunRepository } from 'src/repositories/album-change-run.repository.js';
import { AlbumMergeRepository } from 'src/repositories/album-merge.repository.js';
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
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumChangeRunKind, AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';
import { AlbumChangeRunService } from 'src/services/album-change-run.service.js';
import { AlbumMergeService } from 'src/services/album-merge.service.js';
import { AlbumSourceService } from 'src/services/album-source.service.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const services = newMediumService(AlbumMergeService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumChangeRunRepository,
      AlbumRepository,
      AlbumSourceRepository,
      AlbumUserRepository,
      AssetRepository,
      ClassificationRepository,
      PartnerOriginRepository,
      PartnerRepository,
      SharedLinkRepository,
      SmartAlbumRepository,
      UserRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  services.ctx.getMock(JobRepository).queue.mockResolvedValue();
  services.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return {
    ...services,
    runs: BaseService.create(AlbumChangeRunService, services.sut),
    sources: BaseService.create(AlbumSourceService, services.sut),
  };
};

type Context = ReturnType<typeof setup>['ctx'];

/** An owner, with `count` photos of their own in an album. */
const albumWith = async (
  ctx: Context,
  ownerId: string,
  count: number,
  dto: { albumName?: string; createdAt?: Date } = {},
) => {
  const assets = await Promise.all(Array.from({ length: count }, () => ctx.newAsset({ ownerId })));
  const assetIds = assets.map(({ asset }) => asset.id);
  const { album } = await ctx.newAlbum({ ownerId, ...dto }, assetIds);
  return { album, assetIds };
};

const lock = (ctx: Context, assetId: string, lockedBy: string) =>
  ctx.database.insertInto('asset_lock').values({ assetId, reason: AssetLockReason.Marked, lockedBy }).execute();

const members = async (db: Kysely<DB>, albumId: string) =>
  (await db.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute())
    .map(({ assetId }) => assetId)
    .toSorted();

const albumRow = (db: Kysely<DB>, id: string) =>
  db.selectFrom('album').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

const newLink = async (ctx: Context, userId: string, albumId: string, sourceId = 'phone-album') => {
  const links = ctx.get(AlbumSourceRepository);
  return links.write((tx) =>
    links.create(tx, { userId, albumId, kind: AlbumSourceKind.IosPhotos, sourceId, deviceKey: null, name: sourceId }),
  );
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumMergeService.name, () => {
  describe('winner', () => {
    it('keeps the album with the most photos, with its name, and removes the other', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const big = await albumWith(ctx, user.id, 3, { albumName: 'Big' });
      const small = await albumWith(ctx, user.id, 1, { albumName: 'Small' });

      // whichever album the person started from
      await expect(sut.merge(auth, small.album.id, { otherId: big.album.id })).resolves.toEqual({
        runId: expect.any(String),
        winnerId: big.album.id,
      });

      const winner = await albumRow(ctx.database, big.album.id);
      expect(winner).toMatchObject({ albumName: 'Big', deletedAt: null });
      await expect(members(ctx.database, big.album.id)).resolves.toEqual(
        [...big.assetIds, ...small.assetIds].toSorted(),
      );
      expect((await albumRow(ctx.database, small.album.id)).deletedAt).toBeInstanceOf(Date);
      // the merged-away album keeps its rows until the Undo window closes
      await expect(members(ctx.database, small.album.id)).resolves.toEqual(small.assetIds.toSorted());
    });

    it('goes to the older album on a tie', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const older = await albumWith(ctx, user.id, 2, { createdAt: new Date('2020-01-01T00:00:00Z') });
      const newer = await albumWith(ctx, user.id, 2, { createdAt: new Date('2024-01-01T00:00:00Z') });

      await expect(sut.getPreview(auth, newer.album.id, older.album.id)).resolves.toMatchObject({
        winnerId: older.album.id,
      });
      await expect(sut.merge(auth, newer.album.id, { otherId: older.album.id })).resolves.toMatchObject({
        winnerId: older.album.id,
      });
    });

    it('counts Locked items for the winner without a PIN, but the preview total leaves them out', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const noPin = factory.auth({ user: { id: user.id } });
      const withPin = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
      const a = await albumWith(ctx, user.id, 2, { albumName: 'A' });
      const b = await albumWith(ctx, user.id, 3, { albumName: 'B' });
      // a holds more items once its Locked ones are counted
      const extra = await Promise.all([ctx.newAsset({ ownerId: user.id }), ctx.newAsset({ ownerId: user.id })]);
      for (const { asset } of extra) {
        await ctx.newAlbumAsset({ albumId: a.album.id, assetId: asset.id });
        await lock(ctx, asset.id, user.id);
      }

      await expect(sut.getPreview(noPin, a.album.id, b.album.id)).resolves.toEqual({
        winnerId: a.album.id,
        total: 5,
        inBoth: 0,
        winnerShared: false,
        loserShared: false,
      });
      await expect(sut.getPreview(withPin, a.album.id, b.album.id)).resolves.toMatchObject({
        winnerId: a.album.id,
        total: 7,
      });
    });

    it('counts a photo in both albums once', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const a = await albumWith(ctx, user.id, 3, { albumName: 'A' });
      const b = await albumWith(ctx, user.id, 1, { albumName: 'B' });
      await ctx.newAlbumAsset({ albumId: b.album.id, assetId: a.assetIds[0] });

      await expect(sut.getPreview(auth, a.album.id, b.album.id)).resolves.toMatchObject({ total: 4, inBoth: 1 });
    });

    it('re-decides the winner when the albums changed after the preview', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const a = await albumWith(ctx, user.id, 2);
      const b = await albumWith(ctx, user.id, 1);
      await expect(sut.getPreview(auth, a.album.id, b.album.id)).resolves.toMatchObject({ winnerId: a.album.id });

      const more = await Promise.all([ctx.newAsset({ ownerId: user.id }), ctx.newAsset({ ownerId: user.id })]);
      for (const { asset } of more) {
        await ctx.newAlbumAsset({ albumId: b.album.id, assetId: asset.id });
      }

      await expect(sut.merge(auth, a.album.id, { otherId: b.album.id })).resolves.toMatchObject({
        winnerId: b.album.id,
      });
    });
  });

  describe('locked rule', () => {
    it('unlocks the merged album unless every album in the merge was locked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const lockedWinner = await albumWith(ctx, user.id, 2);
      const plainLoser = await albumWith(ctx, user.id, 1);
      await ctx.database.updateTable('album').set({ isLocked: true }).where('id', '=', lockedWinner.album.id).execute();

      await sut.merge(auth, lockedWinner.album.id, { otherId: plainLoser.album.id });

      expect((await albumRow(ctx.database, lockedWinner.album.id)).isLocked).toBe(false);
      // the ordinary photo stays out of Locked: the sweep finds nothing to lock
      await expect(
        ctx.get(AlbumRepository).getUnlockedItemsInLockedAlbums({ albumId: lockedWinner.album.id }),
      ).resolves.toEqual([]);
      await expect(
        ctx.database.selectFrom('asset_lock').select('assetId').where('assetId', 'in', plainLoser.assetIds).execute(),
      ).resolves.toEqual([]);
    });

    it('keeps a locked winner locked when both were locked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const a = await albumWith(ctx, user.id, 2);
      const b = await albumWith(ctx, user.id, 1);
      await ctx.database
        .updateTable('album')
        .set({ isLocked: true })
        .where('id', 'in', [a.album.id, b.album.id])
        .execute();

      await sut.merge(auth, a.album.id, { otherId: b.album.id });

      expect((await albumRow(ctx.database, a.album.id)).isLocked).toBe(true);
    });

    it('leaves an unlocked winner unlocked when the other was locked', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const plain = await albumWith(ctx, user.id, 2);
      const locked = await albumWith(ctx, user.id, 1);
      await ctx.database.updateTable('album').set({ isLocked: true }).where('id', '=', locked.album.id).execute();
      await lock(ctx, locked.assetIds[0], user.id);

      await sut.merge(auth, plain.album.id, { otherId: locked.album.id });

      expect((await albumRow(ctx.database, plain.album.id)).isLocked).toBe(false);
      await expect(
        ctx.database.selectFrom('asset_lock').select('assetId').where('assetId', '=', locked.assetIds[0]).execute(),
      ).resolves.toEqual([{ assetId: locked.assetIds[0] }]);
    });
  });

  describe('source links', () => {
    it('repoints phone links to the winner, so the next sync finds it instead of recreating the album', async () => {
      const { sut, ctx, sources } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 3, { albumName: 'Trips' });
      const loser = await albumWith(ctx, user.id, 1, { albumName: 'Summer 2020' });
      const linkId = await newLink(ctx, user.id, loser.album.id, 'phone-summer');

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });

      await expect(
        sources.resolve(auth, {
          sources: [{ kind: AlbumSourceKind.IosPhotos, sourceId: 'phone-summer', name: 'Summer 2020' }],
        }),
      ).resolves.toMatchObject({
        links: [{ id: linkId, albumId: winner.album.id, outcome: AlbumSourceOutcome.Existing }],
      });
      await expect(
        ctx.database
          .selectFrom('album')
          .innerJoin('album_user', 'album_user.albumId', 'album.id')
          .where('album_user.userId', '=', user.id)
          .where('album.deletedAt', 'is', null)
          .select('album.id')
          .execute(),
      ).resolves.toEqual([{ id: winner.album.id }]);
    });

    it('lets the link still remove what its sync added, never what was already in the winner by hand', async () => {
      const { sut, ctx, sources } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 3);
      const { album: loser } = await ctx.newAlbum({ ownerId: user.id });
      const linkId = await newLink(ctx, user.id, loser.id);
      const { asset: synced } = await ctx.newAsset({ ownerId: user.id });
      const handAdded = winner.assetIds[0];
      await sources.addAssets(auth, linkId, { ids: [synced.id, handAdded] });

      await sut.merge(auth, winner.album.id, { otherId: loser.id });

      await sources.removeAssets(auth, linkId, { ids: [synced.id, handAdded] });
      await expect(members(ctx.database, winner.album.id)).resolves.toEqual(winner.assetIds.toSorted());
    });
  });

  describe('refusals', () => {
    const refused = (message: RegExp) => expect.objectContaining({ message: expect.stringMatching(message) });

    it('refuses the same album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const { album } = await albumWith(ctx, user.id, 1);

      await expect(sut.merge(auth, album.id, { otherId: album.id })).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.getPreview(auth, album.id, album.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses when the person does not own both', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const { album: mine } = await albumWith(ctx, user.id, 1);
      const { album: theirs } = await albumWith(ctx, other.id, 1);
      await ctx.newAlbumUser({ albumId: theirs.id, userId: user.id, role: AlbumUserRole.Editor });

      await expect(sut.merge(auth, mine.id, { otherId: theirs.id })).rejects.toBeInstanceOf(BadRequestException);
      await expect(albumRow(ctx.database, theirs.id)).resolves.toMatchObject({ deletedAt: null });
    });

    it('refuses collections and spaces', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const { album } = await albumWith(ctx, user.id, 1);
      const { album: collection } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });
      const { album: space } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Space });

      await expect(sut.merge(auth, album.id, { otherId: collection.id })).rejects.toEqual(refused(/album/i));
      await expect(sut.merge(auth, space.id, { otherId: album.id })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses smart albums, of a rule and built in', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const { album } = await albumWith(ctx, user.id, 1);
      const { album: smart } = await albumWith(ctx, user.id, 1);
      await sql`INSERT INTO public.smart_album ("albumId", "ownerId", "kind") VALUES (${smart.id}::uuid, ${user.id}::uuid, 'screenshots')`.execute(
        ctx.database,
      );

      await expect(sut.merge(auth, album.id, { otherId: smart.id })).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.getPreview(auth, smart.id, album.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a partner copy, which keeps following its source', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const { album } = await albumWith(ctx, user.id, 1);
      const { album: copy } = await albumWith(ctx, user.id, 1);
      await sql`INSERT INTO public.album_origin ("albumId", "ownerId", "rootOwnerId", "partnerSharedById")
        VALUES (${copy.id}::uuid, ${user.id}::uuid, ${partner.id}::uuid, ${partner.id}::uuid)`.execute(ctx.database);

      await expect(sut.merge(auth, album.id, { otherId: copy.id })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('what moves with the merge', () => {
    it('moves albums nested in the merged-away album under the winner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 2);
      const loser = await albumWith(ctx, user.id, 1);
      const { album: child } = await ctx.newAlbum({ ownerId: user.id, parentId: loser.album.id });

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });

      expect((await albumRow(ctx.database, child.id)).parentId).toBe(winner.album.id);
      await expect(ctx.get(AlbumRepository).getAncestorIds(child.id)).resolves.toContain(winner.album.id);
    });

    it('takes the winner out of the merged-away album when it was nested inside it', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const { album: top } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });
      const loser = await albumWith(ctx, user.id, 1);
      await ctx.get(AlbumRepository).reparent(loser.album.id, top.id);
      const { album: winner, assetIds } = await albumWith(ctx, user.id, 2);
      await ctx.get(AlbumRepository).reparent(winner.id, loser.album.id);

      await sut.merge(auth, winner.id, { otherId: loser.album.id });

      expect((await albumRow(ctx.database, winner.id)).parentId).toBe(top.id);
      await expect(members(ctx.database, winner.id)).resolves.toHaveLength(assetIds.length + 1);
    });

    it('moves comments and likes, keeping one like when the person liked a photo in both', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 2);
      const loser = await albumWith(ctx, user.id, 1);
      const shared = winner.assetIds[0];
      await ctx.newAlbumAsset({ albumId: loser.album.id, assetId: shared });
      const activity = (albumId: string, assetId: string | null, comment: string | null, isLiked: boolean) =>
        ctx.database
          .insertInto('activity')
          .values({ albumId, assetId, userId: user.id, comment, isLiked })
          .returning('id')
          .executeTakeFirstOrThrow();
      const comment = await activity(loser.album.id, loser.assetIds[0], 'hello', false);
      const albumComment = await activity(loser.album.id, null, 'on the album', false);
      await activity(winner.album.id, shared, null, true);
      const duplicateLike = await activity(loser.album.id, shared, null, true);

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });

      const moved = await ctx.database
        .selectFrom('activity')
        .select('id')
        .where('albumId', '=', winner.album.id)
        .orderBy('id')
        .execute();
      expect(moved.map(({ id }) => id)).toEqual(expect.arrayContaining([comment.id, albumComment.id]));
      await expect(
        ctx.database
          .selectFrom('activity')
          .select('albumId')
          .where('id', '=', duplicateLike.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ albumId: loser.album.id });
    });

    it('unions links', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 2);
      const loser = await albumWith(ctx, user.id, 1);
      const bookmark = await ctx.database
        .insertInto('bookmark')
        .values({ ownerId: user.id, url: 'https://example.org', title: 'Reference' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.database
        .insertInto('album_bookmark')
        .values({ albumId: loser.album.id, bookmarkId: bookmark.id })
        .execute();

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });

      await expect(
        ctx.database.selectFrom('album_bookmark').select('bookmarkId').where('albumId', '=', winner.album.id).execute(),
      ).resolves.toEqual([{ bookmarkId: bookmark.id }]);
    });

    it("cuts off the merged-away album's members and public links, and lets the winner's see both", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: winnerMember } = await ctx.newUser();
      const { user: loserMember } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 2);
      const loser = await albumWith(ctx, user.id, 1);
      await ctx.newAlbumUser({ albumId: winner.album.id, userId: winnerMember.id, role: AlbumUserRole.Viewer });
      await ctx.newAlbumUser({ albumId: loser.album.id, userId: loserMember.id, role: AlbumUserRole.Viewer });
      await ctx.database
        .insertInto('shared_link')
        .values({
          userId: user.id,
          albumId: loser.album.id,
          key: Buffer.from('merge-link'),
          type: SharedLinkType.Album,
          allowUpload: false,
        })
        .execute();

      await expect(sut.getPreview(auth, winner.album.id, loser.album.id)).resolves.toMatchObject({
        winnerShared: true,
        loserShared: true,
      });
      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });

      await expect(
        ctx
          .get(AccessRepository)
          .album.checkSharedAlbumAccess(loserMember.id, new Set([loser.album.id]), AlbumUserRole.Viewer),
      ).resolves.toEqual(new Set());
      await expect(
        ctx.database.selectFrom('album_user').select('userId').where('albumId', '=', winner.album.id).execute(),
      ).resolves.not.toContainEqual({ userId: loserMember.id });
      await expect(
        ctx
          .get(AccessRepository)
          .album.checkSharedAlbumAccess(winnerMember.id, new Set([winner.album.id]), AlbumUserRole.Viewer),
      ).resolves.toEqual(new Set([winner.album.id]));
      await expect(ctx.get(AlbumRepository).getMetadataForIds([winner.album.id])).resolves.toMatchObject([
        { assetCount: 3 },
      ]);
      await expect(ctx.get(SharedLinkRepository).getByKey(Buffer.from('merge-link'))).resolves.toBeUndefined();
    });

    it('keeps a merged-away album gone when its owner’s deleted account is restored, until Undo', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 2);
      const loser = await albumWith(ctx, user.id, 1);
      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });
      const deletedAt = (albumId: string) =>
        ctx.database.selectFrom('album').select('deletedAt').where('id', '=', albumId).executeTakeFirstOrThrow();

      await ctx.get(AlbumRepository).softDeleteAll(user.id);
      await ctx.get(AlbumRepository).restoreAll(user.id);

      await expect(deletedAt(winner.album.id)).resolves.toEqual({ deletedAt: null });
      await expect(deletedAt(loser.album.id)).resolves.not.toEqual({ deletedAt: null });

      await runs.undoLatest(auth);
      await expect(deletedAt(loser.album.id)).resolves.toEqual({ deletedAt: null });
    });

    it('follows a merged-away import folder and a backup choice', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 2);
      const loser = await albumWith(ctx, user.id, 1);
      await ctx.database
        .insertInto('takeout_album')
        .values({ ownerId: user.id, folder: 'Google Photos/Trip', albumId: loser.album.id })
        .execute();
      await ctx.database
        .insertInto('cloud_backup_selection')
        .values({ userId: user.id, destination: 'cloud', albumIds: [loser.album.id] })
        .execute();

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });

      await expect(
        ctx.database.selectFrom('takeout_album').select('albumId').where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([{ albumId: winner.album.id }]);
      await expect(
        ctx.database.selectFrom('cloud_backup_selection').select('albumIds').where('userId', '=', user.id).execute(),
      ).resolves.toEqual([{ albumIds: [winner.album.id] }]);
    });
  });

  describe('undo', () => {
    it('restores the album and takes back what the merge added', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 3);
      const loser = await albumWith(ctx, user.id, 1);
      const { album: child } = await ctx.newAlbum({ ownerId: user.id, parentId: loser.album.id });
      await ctx.database.updateTable('album').set({ isLocked: true }).where('id', '=', winner.album.id).execute();
      const linkId = await newLink(ctx, user.id, loser.album.id);

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });
      await expect(runs.undoLatest(auth)).resolves.toEqual({ reversed: expect.any(Number), skipped: [] });

      expect((await albumRow(ctx.database, loser.album.id)).deletedAt).toBeNull();
      await expect(members(ctx.database, winner.album.id)).resolves.toEqual(winner.assetIds.toSorted());
      expect((await albumRow(ctx.database, child.id)).parentId).toBe(loser.album.id);
      expect((await albumRow(ctx.database, winner.album.id)).isLocked).toBe(true);
      await expect(ctx.get(AlbumSourceRepository).get(null, user.id, linkId)).resolves.toMatchObject({
        albumId: loser.album.id,
      });
    });

    it('keeps a later rename and reports a later move it left alone', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 3, { albumName: 'Before rename' });
      const loser = await albumWith(ctx, user.id, 1, { albumName: 'Merged away' });
      const { album: child } = await ctx.newAlbum({
        ownerId: user.id,
        albumName: 'Moved later',
        parentId: loser.album.id,
      });
      const { album: elsewhere } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });
      await ctx.database
        .updateTable('album')
        .set({ albumName: 'After rename' })
        .where('id', '=', winner.album.id)
        .execute();
      await ctx.get(AlbumRepository).reparent(child.id, elsewhere.id);

      await expect(runs.undoLatest(auth)).resolves.toEqual({
        reversed: expect.any(Number),
        skipped: ['Moved later'],
      });
      expect((await albumRow(ctx.database, winner.album.id)).albumName).toBe('After rename');
      expect((await albumRow(ctx.database, child.id)).parentId).toBe(elsewhere.id);
      expect((await albumRow(ctx.database, loser.album.id)).deletedAt).toBeNull();
    });

    it('keeps a photo someone commented on after the merge, and says so', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 3, { albumName: 'Kept' });
      const loser = await albumWith(ctx, user.id, 2);

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });
      await ctx.database
        .insertInto('activity')
        .values({
          albumId: winner.album.id,
          assetId: loser.assetIds[0],
          userId: user.id,
          comment: 'later',
          isLiked: false,
        })
        .execute();

      await expect(runs.undoLatest(auth)).resolves.toEqual({ reversed: expect.any(Number), skipped: ['Kept'] });
      const after = await members(ctx.database, winner.album.id);
      expect(after).toContain(loser.assetIds[0]);
      expect(after).not.toContain(loser.assetIds[1]);
    });

    it('leaves a photo the person added back by hand', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 3);
      const loser = await albumWith(ctx, user.id, 1);

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });
      await ctx.database
        .deleteFrom('album_asset')
        .where('albumId', '=', winner.album.id)
        .where('assetId', '=', loser.assetIds[0])
        .execute();
      await ctx.newAlbumAsset({ albumId: winner.album.id, assetId: loser.assetIds[0] });

      const result = await runs.undoLatest(auth);
      expect(result.skipped).toHaveLength(1);
      await expect(members(ctx.database, winner.album.id)).resolves.toContain(loser.assetIds[0]);
    });

    it('undoes newest first, one at a time, then reports nothing left', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const a = await albumWith(ctx, user.id, 3);
      const b = await albumWith(ctx, user.id, 2);
      const c = await albumWith(ctx, user.id, 1);

      await sut.merge(auth, a.album.id, { otherId: b.album.id });
      await sut.merge(auth, a.album.id, { otherId: c.album.id });
      await expect(runs.getLatest(auth)).resolves.toMatchObject({
        run: { kind: AlbumChangeRunKind.Merge, status: AlbumChangeRunStatus.Done, canUndo: true },
      });

      await runs.undoLatest(auth);
      expect((await albumRow(ctx.database, c.album.id)).deletedAt).toBeNull();
      expect((await albumRow(ctx.database, b.album.id)).deletedAt).not.toBeNull();

      await runs.undoLatest(auth);
      expect((await albumRow(ctx.database, b.album.id)).deletedAt).toBeNull();

      await expect(runs.getLatest(auth)).resolves.toEqual({ run: null });
      await expect(runs.undoLatest(auth)).rejects.toThrow();
    });

    it('never undoes another account’s run or one past the 30 days', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const a = await albumWith(ctx, user.id, 2);
      const b = await albumWith(ctx, user.id, 1);
      await sut.merge(auth, a.album.id, { otherId: b.album.id });

      await expect(runs.undoLatest(factory.auth({ user: { id: other.id } }))).rejects.toThrow();

      await ctx.database
        .updateTable('album_change_run')
        .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
        .where('userId', '=', user.id)
        .execute();
      await expect(runs.undoLatest(auth)).rejects.toThrow();
    });

    it('will not undo a run still in progress', async () => {
      const { ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      await ctx.database
        .insertInto('album_change_run')
        .values({ userId: user.id, kind: AlbumChangeRunKind.Cleanup })
        .execute();

      await expect(runs.undoLatest(auth)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('interrupted', () => {
    it('leaves nothing done and nothing to undo when a merge fails part-way', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 2);
      const loser = await albumWith(ctx, user.id, 1);
      const linkId = await newLink(ctx, user.id, loser.album.id);
      const failure = vi
        .spyOn(AlbumMergeRepository.prototype, 'softDelete')
        .mockRejectedValueOnce(new Error('restart'));

      await expect(sut.merge(auth, winner.album.id, { otherId: loser.album.id })).rejects.toThrow('restart');
      failure.mockRestore();

      await expect(members(ctx.database, winner.album.id)).resolves.toEqual(winner.assetIds.toSorted());
      expect((await albumRow(ctx.database, loser.album.id)).deletedAt).toBeNull();
      await expect(ctx.get(AlbumSourceRepository).get(null, user.id, linkId)).resolves.toMatchObject({
        albumId: loser.album.id,
      });
      await expect(runs.getLatest(auth)).resolves.toEqual({ run: null });
    });
  });

  describe('iCloud', () => {
    it('moves a mirrored iCloud album to the winner, and puts it back on Undo', async () => {
      const { sut, ctx, runs } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 2);
      const loser = await albumWith(ctx, user.id, 1);
      await ctx.newAlbumAsset({ albumId: loser.album.id, assetId: winner.assetIds[0] });
      const connectionId = newUuid();
      const snapshotId = newUuid();
      await sql`INSERT INTO public.icloud_connection (id, "ownerId", label, state)
        VALUES (${connectionId}::uuid, ${user.id}::uuid, 'Photos', 'connected')`.execute(ctx.database);
      await sql`INSERT INTO public.icloud_album ("connectionId", "libraryKey", "sourceId", name, "albumId")
        VALUES (${connectionId}::uuid, 'lib', 'source', 'Trip', ${loser.album.id}::uuid)`.execute(ctx.database);
      const membership = (sourceAssetId: string, assetId: string) =>
        sql`INSERT INTO public.icloud_membership
          ("connectionId", "libraryKey", "sourceAlbumId", "sourceAssetId", "snapshotId", "albumId", "assetId", "addedBySync")
          VALUES (${connectionId}::uuid, 'lib', 'source', ${sourceAssetId}, ${snapshotId}::uuid, ${loser.album.id}::uuid, ${assetId}::uuid, true)`.execute(
          ctx.database,
        );
      await membership('copied', loser.assetIds[0]);
      await membership('already-there', winner.assetIds[0]);
      const state = async () => ({
        album: (
          await sql<{
            albumId: string;
          }>`SELECT "albumId" FROM public.icloud_album WHERE "connectionId" = ${connectionId}::uuid`.execute(
            ctx.database,
          )
        ).rows,
        memberships: (
          await sql<{ sourceAssetId: string; albumId: string; addedBySync: boolean }>`
            SELECT "sourceAssetId", "albumId", "addedBySync" FROM public.icloud_membership
            WHERE "connectionId" = ${connectionId}::uuid ORDER BY "sourceAssetId"`.execute(ctx.database)
        ).rows,
      });

      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });

      await expect(state()).resolves.toEqual({
        album: [{ albumId: winner.album.id }],
        memberships: [
          // the winner already held this photo by hand, so the sync no longer gets to remove it
          { sourceAssetId: 'already-there', albumId: winner.album.id, addedBySync: false },
          { sourceAssetId: 'copied', albumId: winner.album.id, addedBySync: true },
        ],
      });

      await runs.undoLatest(auth);

      await expect(state()).resolves.toEqual({
        album: [{ albumId: loser.album.id }],
        memberships: [
          { sourceAssetId: 'already-there', albumId: loser.album.id, addedBySync: true },
          { sourceAssetId: 'copied', albumId: loser.album.id, addedBySync: true },
        ],
      });
    });
  });

  describe('purge', () => {
    it('removes merged-away albums after 30 days, and no sooner', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const winner = await albumWith(ctx, user.id, 2);
      const loser = await albumWith(ctx, user.id, 1);
      await sut.merge(auth, winner.album.id, { otherId: loser.album.id });

      await sut.onNightlyDatabaseCleanup();
      expect((await albumRow(ctx.database, loser.album.id)).deletedAt).not.toBeNull();

      await ctx.database
        .updateTable('album_change_run')
        .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
        .where('userId', '=', user.id)
        .execute();
      await sut.onNightlyDatabaseCleanup();

      await expect(
        ctx.database.selectFrom('album').select('id').where('id', '=', loser.album.id).execute(),
      ).resolves.toEqual([]);
      await expect(members(ctx.database, winner.album.id)).resolves.toHaveLength(3);
      await expect(
        ctx.database.selectFrom('album_change_run').select('id').where('userId', '=', user.id).execute(),
      ).resolves.toEqual([]);
    });
  });
});
