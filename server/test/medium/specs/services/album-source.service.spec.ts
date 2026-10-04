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
import { AlbumSourceService } from 'src/services/album-source.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

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

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumSourceService.name, () => {
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
        SELECT count(*)::int AS count FROM immich_fork.album_source_asset WHERE "linkId" = ${links[0].id}::uuid
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
