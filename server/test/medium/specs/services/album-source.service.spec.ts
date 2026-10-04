import { NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AlbumSourceKind } from 'src/dtos/album-source.dto.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
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
import {
  down as removeMembershipGeneration,
  up as addMembershipGeneration,
} from 'src/schema/migrations/1791101770000-AlbumSourceMembershipGeneration.js';
import { AlbumSourceService } from 'src/services/album-source.service.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const services = newMediumService(AlbumSourceService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
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
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  services.ctx.getMock(JobRepository).queue.mockResolvedValue();
  services.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return services;
};

const source = (sourceId: string, name: string, deviceKey?: string) => ({
  kind: AlbumSourceKind.IosPhotos,
  sourceId,
  name,
  ...(deviceKey && { deviceKey }),
});

const albumsOf = async (db: Kysely<DB>, userId: string) =>
  db
    .selectFrom('album')
    .innerJoin('album_user', 'album_user.albumId', 'album.id')
    .where('album_user.userId', '=', userId)
    .where('album.deletedAt', 'is', null)
    .select(['album.id', 'album.albumName'])
    .execute();

const membersOf = async (db: Kysely<DB>, albumId: string) =>
  (await db.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute())
    .map(({ assetId }) => assetId)
    .toSorted();

const barrier = () => {
  const { promise: reached, resolve: open } = Promise.withResolvers<void>();
  return { reached, open };
};

const claimsOf = async (db: Kysely<DB>, linkId: string) =>
  (
    await sql<{ assetId: string; membershipUpdateId: string | null }>`
      SELECT "assetId", "membershipUpdateId" FROM public.album_source_asset WHERE "linkId" = ${linkId}::uuid
    `.execute(db)
  ).rows;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumSourceService.name, () => {
  describe('empty album membership writes', () => {
    it('removes an unlinked asset from all albums without rejecting or changing the asset', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const before = await defaultDatabase
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', asset.id)
        .executeTakeFirstOrThrow();

      await expect(ctx.get(AlbumRepository).removeAssetsFromAll([asset.id])).resolves.toBeUndefined();

      expect(
        await defaultDatabase.selectFrom('album_asset').selectAll().where('assetId', '=', asset.id).execute(),
      ).toEqual([]);
      expect(
        await defaultDatabase.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).toEqual(before);
    });

    it('executes and commits a real membership-write callback once when no album locks are needed', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      let callbacks = 0;

      await expect(
        ctx.get(AlbumRepository).withMembershipWrite([], async (tx) => {
          callbacks++;
          await tx
            .updateTable('asset')
            .set({ originalFileName: 'empty-album-write.jpg' })
            .where('id', '=', asset.id)
            .execute();
          return 'committed';
        }),
      ).resolves.toBe('committed');

      expect(callbacks).toBe(1);
      expect(
        await defaultDatabase
          .selectFrom('asset')
          .select('originalFileName')
          .where('id', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ originalFileName: 'empty-album-write.jpg' });
    });

    it('rolls back an empty-album callback with its enclosing canonical transaction', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const rollback = new Error('rollback empty album write');
      let callbacks = 0;
      await expect(
        defaultDatabase.transaction().execute(async (tx) => {
          await new AlbumRepository(tx).withMembershipWrite([], async (guarded) => {
            callbacks++;
            await guarded
              .updateTable('asset')
              .set({ originalFileName: 'rolled-back.jpg' })
              .where('id', '=', asset.id)
              .execute();
          });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(callbacks).toBe(1);
      expect(
        await defaultDatabase
          .selectFrom('asset')
          .select('originalFileName')
          .where('id', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ originalFileName: asset.originalFileName });
    });
  });

  describe('resolve', () => {
    it('creates one album per new source and reuses the link afterwards', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const first = await sut.resolve(auth, { sources: [source('cloud-1', 'Holiday'), source('cloud-1', 'Holiday')] });
      expect(first.links).toHaveLength(2);
      expect(first.links[0]).toMatchObject({ outcome: 'created', albumName: 'Holiday', lastSourceName: 'Holiday' });
      expect(first.links[1]).toMatchObject({ outcome: 'existing', id: first.links[0].id });

      const again = await sut.resolve(auth, { sources: [source('cloud-1', 'Renamed on the phone')] });
      expect(again.links[0]).toMatchObject({ outcome: 'existing', albumId: first.links[0].albumId });
      expect(await albumsOf(defaultDatabase, user.id)).toHaveLength(1);
    });

    it('merges by trimmed, case-insensitive name into the oldest owned album, never another user’s', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      await ctx.newAlbum({ ownerId: other.id, albumName: 'Family' });
      const { album: older } = await ctx.newAlbum({ ownerId: user.id, albumName: 'family ' });
      await ctx.newAlbum({ ownerId: user.id, albumName: 'Family' });

      const { links } = await sut.resolve(factory.auth({ user }), { sources: [source('cloud-2', '  FAMILY')] });
      expect(links[0]).toMatchObject({ outcome: 'merged', albumId: older.id });
    });

    it('keeps device-local sources of two devices apart, but merges them by name', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const phone = await sut.resolve(auth, { sources: [source('local-1', 'Camera', 'phone')] });
      const tablet = await sut.resolve(auth, { sources: [source('local-1', 'Camera', 'tablet')] });
      expect(tablet.links[0]).toMatchObject({ outcome: 'merged', albumId: phone.links[0].albumId });
      expect(tablet.links[0].id).not.toBe(phone.links[0].id);
    });

    it('gives two devices resolving the same new source at once one album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const results = await Promise.all(
        Array.from({ length: 4 }, () => sut.resolve(auth, { sources: [source('cloud-race', 'Race')] })),
      );
      const albumIds = new Set(results.map(({ links }) => links[0].albumId));
      const linkIds = new Set(results.map(({ links }) => links[0].id));
      expect(albumIds.size).toBe(1);
      expect(linkIds.size).toBe(1);
      expect((await albumsOf(defaultDatabase, user.id)).filter(({ albumName }) => albumName === 'Race')).toHaveLength(
        1,
      );
    });

    it('gives two different sources with the same new name, resolved at once, one album', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const [a, b] = await Promise.all([
        sut.resolve(auth, { sources: [source('cloud-a', 'Shared Name')] }),
        sut.resolve(auth, {
          sources: [{ ...source('folder-b', 'Shared Name', 'android'), kind: AlbumSourceKind.AndroidFolder }],
        }),
      ]);
      expect(a.links[0].albumId).toBe(b.links[0].albumId);
      expect([a.links[0].outcome, b.links[0].outcome].toSorted()).toEqual(['created', 'merged']);
    });

    it('resolves again when the linked album was deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { links } = await sut.resolve(auth, { sources: [source('cloud-3', 'Gone')] });
      await defaultDatabase.deleteFrom('album').where('id', '=', links[0].albumId).execute();

      const again = await sut.resolve(auth, { sources: [source('cloud-3', 'Gone')] });
      expect(again.links[0]).toMatchObject({ outcome: 'created' });
      expect(again.links[0].albumId).not.toBe(links[0].albumId);
    });
  });

  describe('assets', () => {
    it('removes only memberships the sync added, and never the asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: byHand } = await ctx.newAsset({ ownerId: user.id });
      const { asset: synced } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Mixed' }, [byHand.id]);
      const { links } = await sut.resolve(auth, { sources: [source('cloud-4', 'Mixed')] });
      expect(links[0].albumId).toBe(album.id);

      const added = await sut.addAssets(auth, links[0].id, { ids: [byHand.id, synced.id] });
      expect(added).toEqual(
        expect.arrayContaining([
          { id: synced.id, success: true },
          expect.objectContaining({ id: byHand.id, success: false, error: 'duplicate' }),
        ]),
      );
      // idempotent
      await expect(sut.addAssets(auth, links[0].id, { ids: [synced.id] })).resolves.toEqual([
        { id: synced.id, success: true },
      ]);

      const removed = await sut.removeAssets(auth, links[0].id, { ids: [byHand.id, synced.id] });
      expect(removed).toEqual([
        { id: byHand.id, success: false, error: 'not_found' },
        { id: synced.id, success: true },
      ]);
      expect(await membersOf(defaultDatabase, album.id)).toEqual([byHand.id]);
      const assets = await defaultDatabase
        .selectFrom('asset')
        .select(['id', 'deletedAt', 'visibility'])
        .where('id', 'in', [byHand.id, synced.id])
        .execute();
      expect(assets.every(({ deletedAt }) => deletedAt === null)).toBe(true);
    });

    it('does not claim a concurrent copyAlbums insertion after the source read found no membership', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: original } = await ctx.newAsset({ ownerId: user.id });
      const { asset: copied } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Copy wins' }, [original.id]);
      const link = (await sut.resolve(auth, { sources: [source('copy-wins', 'Copy wins')] })).links[0];
      const read = barrier();
      const release = barrier();
      const getAssetIds = AlbumRepository.prototype.getAssetIds;
      const paused = vi.spyOn(AlbumRepository.prototype, 'getAssetIds').mockImplementationOnce(async function (
        this: AlbumRepository,
        albumId,
        ids,
      ) {
        const existing = await getAssetIds.call(this, albumId, ids);
        expect(existing.has(copied.id)).toBe(false);
        read.open();
        await release.reached;
        return existing;
      });
      ctx.getMock(EventRepository).emit.mockClear();
      ctx.getMock(JobRepository).queue.mockClear();
      ctx.getMock(JobRepository).queueAll.mockClear();
      const adding = sut.addAssets(auth, link.id, { ids: [copied.id] });
      try {
        await read.reached;
        // Actual AssetService.copy production seam; its INSERT bypasses the source album fence.
        await ctx.get(AlbumRepository).copyAlbums({ sourceAssetId: original.id, targetAssetId: copied.id });
        const winner = await defaultDatabase
          .selectFrom('album_asset')
          .select('updateId')
          .where('albumId', '=', album.id)
          .where('assetId', '=', copied.id)
          .executeTakeFirstOrThrow();
        release.open();
        await expect(adding).resolves.toEqual([{ id: copied.id, success: false, error: 'duplicate' }]);
        expect(await claimsOf(defaultDatabase, link.id)).toEqual([]);
        expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
        expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
        expect(ctx.getMock(JobRepository).queueAll).not.toHaveBeenCalled();
        await expect(sut.removeAssets(auth, link.id, { ids: [copied.id] })).resolves.toEqual([
          { id: copied.id, success: false, error: 'not_found' },
        ]);
        const surviving = await defaultDatabase
          .selectFrom('album_asset')
          .select('updateId')
          .where('albumId', '=', album.id)
          .where('assetId', '=', copied.id)
          .executeTakeFirstOrThrow();
        expect(surviving.updateId).toBe(winner.updateId);
        expect(await membersOf(defaultDatabase, album.id)).toEqual([original.id, copied.id].toSorted());
        const media = await defaultDatabase
          .selectFrom('asset')
          .select(['deletedAt', 'visibility'])
          .where('id', '=', copied.id)
          .executeTakeFirstOrThrow();
        expect(media).toMatchObject({ deletedAt: null, visibility: copied.visibility });
      } finally {
        release.open();
        await Promise.allSettled([adding]);
        paused.mockRestore();
      }
    });

    it('ordinary remove and manual re-add end the source claim', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const link = (await sut.resolve(auth, { sources: [source('ordinary-readd', 'Manual again')] })).links[0];
      const albums = BaseService.create(AlbumService, sut);
      await sut.addAssets(auth, link.id, { ids: [asset.id] });
      await expect(albums.removeAssets(auth, link.albumId, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: true },
      ]);
      expect(await claimsOf(defaultDatabase, link.id)).toEqual([]);
      await albums.addAssets(auth, link.albumId, { ids: [asset.id] });
      await expect(sut.addAssets(auth, link.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: 'duplicate' },
      ]);
      await expect(sut.removeAssets(auth, link.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: 'not_found' },
      ]);
      expect(await membersOf(defaultDatabase, link.albumId)).toEqual([asset.id]);
    });

    it('does not adopt a replacement made by a writer that bypasses ordinary album service', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const link = (await sut.resolve(auth, { sources: [source('direct-replace', 'Generation')] })).links[0];
      await sut.addAssets(auth, link.id, { ids: [asset.id] });
      const [claim] = await claimsOf(defaultDatabase, link.id);
      // Smart-album/classification writers use this direct public membership seam.
      await defaultDatabase.transaction().execute(async (tx) => {
        await tx
          .deleteFrom('album_asset')
          .where('albumId', '=', link.albumId)
          .where('assetId', '=', asset.id)
          .execute();
        await tx.insertInto('album_asset').values({ albumId: link.albumId, assetId: asset.id }).execute();
      });
      const current = await defaultDatabase
        .selectFrom('album_asset')
        .select('updateId')
        .where('albumId', '=', link.albumId)
        .where('assetId', '=', asset.id)
        .executeTakeFirstOrThrow();
      expect(current.updateId).not.toBe(claim.membershipUpdateId);
      await expect(sut.addAssets(auth, link.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: 'duplicate' },
      ]);
      await sut.removeAssets(auth, link.id, { ids: [asset.id] });
      expect(await membersOf(defaultDatabase, link.albumId)).toEqual([asset.id]);
      expect((await claimsOf(defaultDatabase, link.id))[0].membershipUpdateId).toBe(claim.membershipUpdateId);
    });

    it('rolls back actual membership and provenance when recording fails, without emitting committed events', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const link = (await sut.resolve(auth, { sources: [source('record-rollback', 'Rollback')] })).links[0];
      const repository = ctx.get(AlbumSourceRepository);
      const record = repository.record.bind(repository);
      const injected = vi.spyOn(repository, 'record').mockImplementationOnce(async (tx, linkId, ids) => {
        await record(tx, linkId, ids);
        throw new Error('injected provenance failure after write');
      });
      ctx.getMock(EventRepository).emit.mockClear();
      ctx.getMock(JobRepository).queue.mockClear();
      try {
        await expect(sut.addAssets(auth, link.id, { ids: [asset.id] })).rejects.toThrow('injected provenance failure');
        expect(await membersOf(defaultDatabase, link.albumId)).toEqual([]);
        expect(await claimsOf(defaultDatabase, link.id)).toEqual([]);
        expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
        expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
      } finally {
        injected.mockRestore();
      }
    });

    it('serializes unlink behind an in-flight add and rolls the entire failed add back', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const link = (await sut.resolve(auth, { sources: [source('unlink-rollback', 'Unlink rollback')] })).links[0];
      const recording = barrier();
      const release = barrier();
      const unlinkEntered = barrier();
      const repository = ctx.get(AlbumSourceRepository);
      const record = repository.record.bind(repository);
      const injected = vi.spyOn(repository, 'record').mockImplementationOnce(async (tx, linkId, ids) => {
        await record(tx, linkId, ids);
        recording.open();
        await release.reached;
        throw new Error('barrier provenance failure');
      });
      const albums = ctx.get(AlbumRepository);
      const write = albums.withMembershipWrite.bind(albums);
      let calls = 0;
      const observed = vi.spyOn(albums, 'withMembershipWrite').mockImplementation((ids, fn) => {
        if (++calls === 2) {
          unlinkEntered.open();
        }
        return write(ids, fn);
      });
      const adding = sut.addAssets(auth, link.id, { ids: [asset.id] });
      const rejection = expect(adding).rejects.toThrow('barrier provenance failure');
      let unlinking: Promise<void> | undefined;
      try {
        await recording.reached;
        let unlinked = false;
        unlinking = sut.delete(auth, link.id).then(() => {
          unlinked = true;
        });
        await unlinkEntered.reached;
        expect(await membersOf(defaultDatabase, link.albumId)).toEqual([]);
        expect(unlinked).toBe(false);
        release.open();
        await rejection;
        await unlinking;
        expect(await membersOf(defaultDatabase, link.albumId)).toEqual([]);
        expect(await claimsOf(defaultDatabase, link.id)).toEqual([]);
        await expect(sut.getAll(auth)).resolves.toEqual([]);
        const persisted = await defaultDatabase
          .selectFrom('asset')
          .select('deletedAt')
          .where('id', '=', asset.id)
          .executeTakeFirstOrThrow();
        expect(persisted).toMatchObject({ deletedAt: null });
      } finally {
        release.open();
        await Promise.allSettled([adding, ...(unlinking ? [unlinking] : [])]);
        injected.mockRestore();
        observed.mockRestore();
      }
    });

    it('refuses an add whose link was unlinked after its initial read but before the membership fence', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const link = (await sut.resolve(auth, { sources: [source('unlink-first', 'Fresh link')] })).links[0];
      const entered = barrier();
      const release = barrier();
      const albums = ctx.get(AlbumRepository);
      const write = albums.withMembershipWrite.bind(albums);
      const paused = vi.spyOn(albums, 'withMembershipWrite').mockImplementationOnce(async (ids, fn) => {
        entered.open();
        await release.reached;
        return write(ids, fn);
      });
      const adding = sut.addAssets(auth, link.id, { ids: [asset.id] });
      const rejection = expect(adding).rejects.toBeInstanceOf(NotFoundException);
      try {
        await entered.reached;
        await sut.delete(auth, link.id);
        release.open();
        await rejection;
        expect(await membersOf(defaultDatabase, link.albumId)).toEqual([]);
        expect(await claimsOf(defaultDatabase, link.id)).toEqual([]);
      } finally {
        release.open();
        await Promise.allSettled([adding]);
        paused.mockRestore();
      }
    });

    it('holds the actual membership row against a direct concurrent delete and manual replacement', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const link = (await sut.resolve(auth, { sources: [source('row-fence', 'Row fence')] })).links[0];
      await sut.addAssets(auth, link.id, { ids: [asset.id] });
      const locked = barrier();
      const release = barrier();
      const replacing = barrier();
      const repository = ctx.get(AlbumSourceRepository);
      const getRecorded = repository.getRecordedAssetIds.bind(repository);
      const paused = vi
        .spyOn(repository, 'getRecordedAssetIds')
        .mockImplementationOnce(async (tx, albumId, ids, linkId) => {
          const result = await getRecorded(tx, albumId, ids, linkId);
          locked.open();
          await release.reached;
          return result;
        });
      const removing = sut.removeAssets(auth, link.id, { ids: [asset.id] });
      let replacement: Promise<void> | undefined;
      try {
        await locked.reached;
        let replaced = false;
        replacement = defaultDatabase.transaction().execute(async (tx) => {
          replacing.open();
          await tx
            .deleteFrom('album_asset')
            .where('albumId', '=', link.albumId)
            .where('assetId', '=', asset.id)
            .execute();
          await tx.insertInto('album_asset').values({ albumId: link.albumId, assetId: asset.id }).execute();
          replaced = true;
        });
        await replacing.reached;
        expect(await membersOf(defaultDatabase, link.albumId)).toEqual([asset.id]);
        expect(replaced).toBe(false);
        release.open();
        await expect(removing).resolves.toEqual([{ id: asset.id, success: true }]);
        await replacement;
        expect(await membersOf(defaultDatabase, link.albumId)).toEqual([asset.id]);
        expect(await claimsOf(defaultDatabase, link.id)).toEqual([]);
      } finally {
        release.open();
        await Promise.allSettled([removing, ...(replacement ? [replacement] : [])]);
        paused.mockRestore();
      }
    });

    it('rolls back actual removal and the source claim when the membership delete fails after writing', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const link = (await sut.resolve(auth, { sources: [source('remove-rollback', 'Remove rollback')] })).links[0];
      await sut.addAssets(auth, link.id, { ids: [asset.id] });
      const before = await claimsOf(defaultDatabase, link.id);
      const remove = AlbumRepository.prototype.removeAssetIds;
      const injected = vi.spyOn(AlbumRepository.prototype, 'removeAssetIds').mockImplementationOnce(async function (
        this: AlbumRepository,
        albumId,
        ids,
      ) {
        await remove.call(this, albumId, ids);
        throw new Error('injected membership deletion failure');
      });
      ctx.getMock(EventRepository).emit.mockClear();
      try {
        await expect(sut.removeAssets(auth, link.id, { ids: [asset.id] })).rejects.toThrow(
          'injected membership deletion failure',
        );
        expect(await membersOf(defaultDatabase, link.albumId)).toEqual([asset.id]);
        expect(await claimsOf(defaultDatabase, link.id)).toEqual(before);
        expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
      } finally {
        injected.mockRestore();
      }
    });

    it('keeps a membership another link still records', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const phone = (await sut.resolve(auth, { sources: [source('local-5', 'Both', 'phone')] })).links[0];
      const tablet = (await sut.resolve(auth, { sources: [source('local-5', 'Both', 'tablet')] })).links[0];

      await sut.addAssets(auth, phone.id, { ids: [asset.id] });
      await expect(sut.addAssets(auth, tablet.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: true },
      ]);
      await sut.removeAssets(auth, phone.id, { ids: [asset.id] });
      expect(await membersOf(defaultDatabase, phone.albumId)).toEqual([asset.id]);
      await sut.removeAssets(auth, tablet.id, { ids: [asset.id] });
      expect(await membersOf(defaultDatabase, phone.albumId)).toEqual([]);
    });
  });

  describe('update', () => {
    it('renames the album only while nobody renamed it on the server', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { links } = await sut.resolve(auth, { sources: [source('cloud-6', 'Before')] });

      await expect(sut.update(auth, links[0].id, { name: 'After' })).resolves.toMatchObject({
        renamed: true,
        albumName: 'After',
        lastSourceName: 'After',
      });

      await defaultDatabase
        .updateTable('album')
        .set({ albumName: 'Mine' })
        .where('id', '=', links[0].albumId)
        .execute();
      await expect(sut.update(auth, links[0].id, { name: 'Again' })).resolves.toMatchObject({
        renamed: false,
        albumName: 'Mine',
        lastSourceName: 'Again',
      });
    });

    it('preserves an ordinary manual rename committed between initial link read and the phone fence', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const link = (await sut.resolve(auth, { sources: [source('rename-barrier', 'Before barrier')] })).links[0];
      const entered = barrier();
      const release = barrier();
      const repository = ctx.get(AlbumSourceRepository);
      const withLocks = repository.withLocks.bind(repository);
      const paused = vi.spyOn(repository, 'withLocks').mockImplementationOnce(async (keys, write) => {
        entered.open();
        await release.reached;
        return withLocks(keys, write);
      });
      const updating = sut.update(auth, link.id, { name: 'Phone name' });
      try {
        await entered.reached;
        await BaseService.create(AlbumService, sut).update(auth, link.albumId, { albumName: 'Manual name' });
        release.open();
        await expect(updating).resolves.toMatchObject({
          renamed: false,
          albumName: 'Manual name',
          lastSourceName: 'Phone name',
        });
        expect((await albumsOf(defaultDatabase, user.id)).find(({ id }) => id === link.albumId)?.albumName).toBe(
          'Manual name',
        );
      } finally {
        release.open();
        await Promise.allSettled([updating]);
        paused.mockRestore();
      }
    });

    it('rolls a followed album rename back when the source link write fails', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const link = (await sut.resolve(auth, { sources: [source('rename-rollback', 'Before rollback')] })).links[0];
      const repository = ctx.get(AlbumSourceRepository);
      const update = repository.update.bind(repository);
      const injected = vi.spyOn(repository, 'update').mockImplementationOnce(async (tx, id, values) => {
        await update(tx, id, values);
        throw new Error('injected source name failure');
      });
      ctx.getMock(EventRepository).emit.mockClear();
      try {
        await expect(sut.update(auth, link.id, { name: 'Phone name' })).rejects.toThrow('injected source name failure');
        await expect(sut.getAll(auth)).resolves.toEqual([
          expect.objectContaining({ albumName: 'Before rollback', lastSourceName: 'Before rollback' }),
        ]);
        expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
      } finally {
        injected.mockRestore();
      }
    });

    it('re-keys a link, refusing a source another link holds', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const folder = (sourceId: string, name: string) => ({
        kind: AlbumSourceKind.AndroidFolder,
        sourceId,
        name,
        deviceKey: 'android',
      });
      const { links } = await sut.resolve(auth, {
        sources: [folder('1:DCIM/Old', 'Old'), folder('2:DCIM/Other', 'Other')],
      });

      await expect(sut.update(auth, links[0].id, { name: 'New', sourceId: '3:DCIM/New' })).resolves.toMatchObject({
        sourceId: '3:DCIM/New',
        renamed: true,
      });
      await expect(sut.update(auth, links[0].id, { name: 'New', sourceId: '2:DCIM/Other' })).rejects.toThrow(
        'Another link already holds this source',
      );
      const again = await sut.resolve(auth, { sources: [folder('3:DCIM/New', 'New')] });
      expect(again.links[0]).toMatchObject({ outcome: 'existing', id: links[0].id });
    });
  });

  describe('canonical membership generation migration', () => {
    it('retains unknown migration-222 claims without inventing authority over current memberships', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const link = (await sut.resolve(auth, { sources: [source('legacy-claim', 'Legacy claim')] })).links[0];
      await BaseService.create(AlbumService, sut).addAssets(auth, link.albumId, { ids: [asset.id] });
      await defaultDatabase.transaction().execute(async (tx) => {
        await removeMembershipGeneration(tx);
        await sql`
          INSERT INTO public.album_source_asset ("linkId", "assetId") VALUES (${link.id}::uuid, ${asset.id}::uuid)
        `.execute(tx);
        await addMembershipGeneration(tx);
        const repository = new AlbumSourceRepository(tx);
        expect(await claimsOf(tx, link.id)).toEqual([{ assetId: asset.id, membershipUpdateId: null }]);
        expect(await repository.getRecordedAssetIds(tx, link.albumId, [asset.id], link.id)).toEqual(new Set());
      });
      await expect(sut.removeAssets(auth, link.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: 'not_found' },
      ]);
      expect(await membersOf(defaultDatabase, link.albumId)).toEqual([asset.id]);
    });
  });

  describe('delete and access', () => {
    it('unlinks and keeps the album and its photos', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { links } = await sut.resolve(auth, { sources: [source('cloud-7', 'Keep')] });
      await sut.addAssets(auth, links[0].id, { ids: [asset.id] });

      await sut.delete(auth, links[0].id);
      expect(await membersOf(defaultDatabase, links[0].albumId)).toEqual([asset.id]);
      await expect(sut.getAll(auth)).resolves.toEqual([]);
      const provenance = await sql<{ count: number }>`
        SELECT count(*)::int AS count FROM public.album_source_asset WHERE "linkId" = ${links[0].id}::uuid
      `.execute(defaultDatabase);
      expect(provenance.rows[0].count).toBe(0);
    });

    it('never lets another user use or see a link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: other.id });
      const { links } = await sut.resolve(factory.auth({ user }), { sources: [source('cloud-8', 'Private')] });
      const intruder = factory.auth({ user: other });

      await expect(sut.addAssets(intruder, links[0].id, { ids: [asset.id] })).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.removeAssets(intruder, links[0].id, { ids: [asset.id] })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(sut.update(intruder, links[0].id, { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.delete(intruder, links[0].id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.getAll(intruder)).resolves.toEqual([]);
    });

    it('cannot add another user’s assets through a link', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: other.id });
      const auth = factory.auth({ user });
      const { links } = await sut.resolve(auth, { sources: [source('cloud-9', 'Mine')] });

      await expect(sut.addAssets(auth, links[0].id, { ids: [asset.id] })).resolves.toEqual([
        expect.objectContaining({ id: asset.id, success: false, error: 'no_permission' }),
      ]);
      expect(await membersOf(defaultDatabase, links[0].albumId)).toEqual([]);
    });
  });
});
