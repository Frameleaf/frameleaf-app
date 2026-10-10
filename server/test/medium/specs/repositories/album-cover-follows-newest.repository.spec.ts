import { Kysely } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-83 (AL-13): "Always use the newest item" as an album cover. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

const coverOf = async (albumId: string) => {
  const { albumThumbnailAssetId } = await db
    .selectFrom('album')
    .select('albumThumbnailAssetId')
    .where('id', '=', albumId)
    .executeTakeFirstOrThrow();
  return albumThumbnailAssetId;
};

const oldest = new Date('2023-01-01T00:00:00.000Z');
const older = new Date('2024-01-01T00:00:00.000Z');
const newer = new Date('2024-06-01T00:00:00.000Z');

it('installs feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, ['album_cover_follows_newest']);
});

it('makes the newest item the cover when turned on and keeps the cover when turned off', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { asset: old } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: older });
  const { asset: newest } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: newer });
  const { album } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: old.id }, [old.id, newest.id]);

  await expect(sut.isCoverFollowingNewest(album.id)).resolves.toBe(false);
  await sut.setCoverFollowsNewest(album.id, true);
  await expect(sut.isCoverFollowingNewest(album.id)).resolves.toBe(true);
  await expect(coverOf(album.id)).resolves.toBe(newest.id);

  await sut.setCoverFollowsNewest(album.id, false);
  await expect(sut.isCoverFollowingNewest(album.id)).resolves.toBe(false);
  await expect(coverOf(album.id)).resolves.toBe(newest.id);
});

it('follows items as they are added and removed, and leaves other albums alone', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { asset: first } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: oldest });
  const { asset: second } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: older });
  const { asset: latest } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: newer });
  const { album } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: first.id }, [first.id, second.id]);
  const { album: picked } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: first.id }, [
    first.id,
    latest.id,
  ]);
  await sut.setCoverFollowsNewest(album.id, true);
  await expect(coverOf(album.id)).resolves.toBe(second.id);

  await sut.addAssetIds(album.id, [latest.id]);
  await sut.updateNewestCovers([album.id]);
  await expect(coverOf(album.id)).resolves.toBe(latest.id);

  await sut.removeAssetIds(album.id, [latest.id]);
  await sut.updateThumbnails();
  await expect(coverOf(album.id)).resolves.toBe(second.id);
  // An album whose cover was picked by hand keeps it.
  await expect(coverOf(picked.id)).resolves.toBe(first.id);
});

it('never follows onto a Locked or trashed item', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { asset: plain } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: older });
  const { asset: locked } = await ctx.newAsset({
    ownerId: user.id,
    fileCreatedAt: newer,
    visibility: AssetVisibility.Locked,
  });
  const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: newer, deletedAt: newer });
  const { album } = await ctx.newAlbum({ ownerId: user.id }, [plain.id, locked.id, trashed.id]);

  await sut.setCoverFollowsNewest(album.id, true);

  await expect(coverOf(album.id)).resolves.toBe(plain.id);
});

it('forgets the setting when the album is deleted', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  await sut.setCoverFollowsNewest(album.id, true);

  await sut.delete(album.id);

  await expect(sut.isCoverFollowingNewest(album.id)).resolves.toBe(false);
});
