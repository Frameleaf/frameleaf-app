import { Kysely, sql } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * `AlbumRepository.updateThumbnails` picks an automatic cover with the same picker
 * `releaseLockedCoverReferences` uses when a Locked photo releases the cover it was
 * (`albumCoverReplacement` in `src/utils/cover-references.ts`, FL-53): a Best Photo first, the highest
 * score first, then the newest; never Locked or trashed, and never sensitive for an album someone
 * besides its owner sees. One picker, so an automatic cover never disagrees with a fallback cover.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

/** The fork schema phase decides where the sensitive flag and Best Photos scores are read. */
const setForkPhase = (db: Kysely<DB>, phase: string) =>
  sql`UPDATE immich_fork.state SET phase = ${phase} WHERE id = 1`.execute(db);

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  await setForkPhase(defaultDatabase, 'legacy');
});

/** Marks a photo as a Best Photo (score 0.9 and up). */
const markBestPhoto = (db: Kysely<DB>, asset: { id: string; ownerId: string }, score = 0.95) =>
  db
    .insertInto('asset_best_photo_score')
    .values({ assetId: asset.id, ownerId: asset.ownerId, score, scoreVersion: 1, computedAt: new Date() })
    .execute();

const coverOf = async (db: Kysely<DB>, albumId: string) => {
  const { albumThumbnailAssetId } = await db
    .selectFrom('album')
    .select('albumThumbnailAssetId')
    .where('id', '=', albumId)
    .executeTakeFirstOrThrow();
  return albumThumbnailAssetId;
};

const older = new Date('2024-01-01T00:00:00.000Z');
const newer = new Date('2024-06-01T00:00:00.000Z');

describe(AlbumRepository.prototype.updateThumbnails.name, () => {
  it('prefers a Best Photo over a newer photo without a qualifying score', async () => {
    const { ctx, sut } = setup();
    const owner = await ctx.newUser();
    const { asset: bestPhoto } = await ctx.newAsset({ ownerId: owner.user.id, fileCreatedAt: older });
    const { asset: newest } = await ctx.newAsset({ ownerId: owner.user.id, fileCreatedAt: newer });
    await markBestPhoto(ctx.database, bestPhoto, 0.95);
    const { album } = await ctx.newAlbum({ ownerId: owner.user.id, albumThumbnailAssetId: null }, [
      bestPhoto.id,
      newest.id,
    ]);

    await sut.updateThumbnails();

    await expect(coverOf(ctx.database, album.id)).resolves.toBe(bestPhoto.id);
  });

  it('ignores a score below the Best Photos threshold and falls back to the newest photo', async () => {
    const { ctx, sut } = setup();
    const owner = await ctx.newUser();
    const { asset: belowThreshold } = await ctx.newAsset({ ownerId: owner.user.id, fileCreatedAt: older });
    const { asset: newest } = await ctx.newAsset({ ownerId: owner.user.id, fileCreatedAt: newer });
    await markBestPhoto(ctx.database, belowThreshold, 0.8);
    const { album } = await ctx.newAlbum({ ownerId: owner.user.id, albumThumbnailAssetId: null }, [
      belowThreshold.id,
      newest.id,
    ]);

    await sut.updateThumbnails();

    await expect(coverOf(ctx.database, album.id)).resolves.toBe(newest.id);
  });

  it('never picks a Locked or trashed photo', async () => {
    const { ctx, sut } = setup();
    const owner = await ctx.newUser();
    const { asset: locked } = await ctx.newAsset({
      ownerId: owner.user.id,
      fileCreatedAt: newer,
      visibility: AssetVisibility.Locked,
    });
    const { asset: trashed } = await ctx.newAsset({
      ownerId: owner.user.id,
      fileCreatedAt: newer,
      deletedAt: newer,
    });
    const { asset: plain } = await ctx.newAsset({ ownerId: owner.user.id, fileCreatedAt: older });
    const { album } = await ctx.newAlbum({ ownerId: owner.user.id, albumThumbnailAssetId: null }, [
      locked.id,
      trashed.id,
      plain.id,
    ]);

    await sut.updateThumbnails();

    await expect(coverOf(ctx.database, album.id)).resolves.toBe(plain.id);
  });

  it('never picks a sensitive photo for an album someone besides its owner sees', async () => {
    const { ctx, sut } = setup();
    const owner = await ctx.newUser();
    const member = await ctx.newUser();
    const { asset: sensitive } = await ctx.newAsset({
      ownerId: owner.user.id,
      fileCreatedAt: newer,
      is_nsfw: true,
    });
    const { album: shared } = await ctx.newAlbum({ ownerId: owner.user.id, albumThumbnailAssetId: null }, [
      sensitive.id,
    ]);
    await ctx.newAlbumUser({ albumId: shared.id, userId: member.user.id });

    await sut.updateThumbnails();

    await expect(coverOf(ctx.database, shared.id)).resolves.toBeNull();
  });

  it('takes a sensitive photo as a last resort for a private album', async () => {
    const { ctx, sut } = setup();
    const owner = await ctx.newUser();
    const { asset: sensitive } = await ctx.newAsset({
      ownerId: owner.user.id,
      fileCreatedAt: newer,
      is_nsfw: true,
    });
    const { album: own } = await ctx.newAlbum({ ownerId: owner.user.id, albumThumbnailAssetId: null }, [sensitive.id]);

    await sut.updateThumbnails();

    await expect(coverOf(ctx.database, own.id)).resolves.toBe(sensitive.id);
  });
});
