import { Kysely } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { up as clearLockedAlbumCovers } from 'src/schema/migrations/2100000000290-ClearLockedAlbumCovers.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Owner decision, September 22, 2026 (FL-53): an album cover is never a Locked photo. Whatever moves
 * a cover into the Locked folder removes it as the cover of every album that uses it, in the same
 * transaction, and the album falls back to its automatic cover (never Locked) or to none.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const older = new Date('2024-01-01T00:00:00.000Z');
const newer = new Date('2024-06-01T00:00:00.000Z');

/**
 * A cover photo used by two albums: its owner's own album, which has an older photo to fall back to
 * and a newer Locked one it must skip, and another person's album where it is the only member.
 */
const seed = async ({ ctx }: ReturnType<typeof setup>) => {
  const { user: owner } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const { asset: cover } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: newer });
  const { asset: fallback } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: older });
  const { asset: alreadyLocked } = await ctx.newAsset({
    ownerId: owner.id,
    fileCreatedAt: new Date('2025-01-01T00:00:00.000Z'),
    visibility: AssetVisibility.Locked,
  });
  const { album: ownAlbum } = await ctx.newAlbum({ ownerId: owner.id, albumThumbnailAssetId: cover.id }, [
    cover.id,
    fallback.id,
    alreadyLocked.id,
  ]);
  const { album: otherAlbum } = await ctx.newAlbum({ ownerId: other.id, albumThumbnailAssetId: cover.id }, [cover.id]);
  return { owner, cover, fallback, alreadyLocked, ownAlbum, otherAlbum };
};

const coverOf = (db: Kysely<DB>, albumId: string) =>
  db
    .selectFrom('album')
    .select('albumThumbnailAssetId')
    .where('id', '=', albumId)
    .executeTakeFirstOrThrow()
    .then(({ albumThumbnailAssetId }) => albumThumbnailAssetId);

describe('Locked album covers (FL-53)', () => {
  describe(AssetRepository.prototype.update.name, () => {
    it('removes a cover that becomes Locked from every album and falls back to the automatic cover', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { cover, fallback, ownAlbum, otherAlbum } = await seed(context);

      // `locked` is a lock record (FL-34): the stored visibility stays as it was
      await expect(sut.update({ id: cover.id, visibility: AssetVisibility.Locked })).resolves.toEqual(
        expect.objectContaining({ id: cover.id, visibility: AssetVisibility.Timeline }),
      );

      await expect(coverOf(ctx.database, ownAlbum.id)).resolves.toBe(fallback.id);
      await expect(coverOf(ctx.database, otherAlbum.id)).resolves.toBeNull();
    });

    it('keeps the cover for any other visibility change', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { cover, ownAlbum, otherAlbum } = await seed(context);

      await sut.update({ id: cover.id, visibility: AssetVisibility.Archive });
      await sut.update({ id: cover.id, isFavorite: true });

      await expect(coverOf(ctx.database, ownAlbum.id)).resolves.toBe(cover.id);
      await expect(coverOf(ctx.database, otherAlbum.id)).resolves.toBe(cover.id);
    });

    it('joins the transaction it is bound to, so a rollback keeps both the visibility and the cover', async () => {
      const context = setup();
      const { ctx } = context;
      const { cover, fallback, ownAlbum } = await seed(context);

      await expect(
        ctx.database.transaction().execute(async (tx) => {
          await new AssetRepository(tx).update({ id: cover.id, visibility: AssetVisibility.Locked });
          await expect(coverOf(tx, ownAlbum.id)).resolves.toBe(fallback.id);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      await expect(coverOf(ctx.database, ownAlbum.id)).resolves.toBe(cover.id);
      await expect(
        ctx.database.selectFrom('asset').select('visibility').where('id', '=', cover.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ visibility: AssetVisibility.Timeline });
    });
  });

  describe(AssetRepository.prototype.updateAll.name, () => {
    it('removes covers that become Locked in a bulk update and falls back to the automatic cover', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { cover, fallback, ownAlbum, otherAlbum } = await seed(context);
      const { asset: unrelated } = await ctx.newAsset({ ownerId: fallback.ownerId });

      await sut.updateAll([cover.id, unrelated.id], { visibility: AssetVisibility.Locked });

      await expect(coverOf(ctx.database, ownAlbum.id)).resolves.toBe(fallback.id);
      await expect(coverOf(ctx.database, otherAlbum.id)).resolves.toBeNull();
    });

    it('leaves no cover when every remaining album member is Locked', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { cover, fallback, ownAlbum } = await seed(context);

      await sut.updateAll([cover.id, fallback.id], { visibility: AssetVisibility.Locked });

      await expect(coverOf(ctx.database, ownAlbum.id)).resolves.toBeNull();
    });

    it('keeps the cover for any other bulk change', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { cover, ownAlbum } = await seed(context);

      await sut.updateAll([cover.id], { visibility: AssetVisibility.Archive, isFavorite: true });

      await expect(coverOf(ctx.database, ownAlbum.id)).resolves.toBe(cover.id);
    });
  });

  describe('migration 2100000000290-ClearLockedAlbumCovers', () => {
    it('repairs albums whose saved cover is already Locked and leaves the others alone', async () => {
      const context = setup();
      const { ctx } = context;
      const { cover, fallback, alreadyLocked, ownAlbum, otherAlbum } = await seed(context);
      const { asset: plain } = await ctx.newAsset({ ownerId: cover.ownerId });
      const { album: untouched } = await ctx.newAlbum({ ownerId: cover.ownerId, albumThumbnailAssetId: plain.id }, [
        plain.id,
      ]);
      // data written before FL-53 and FL-34: the cover moved into the upstream Locked folder, kept its
      // albums' covers, and the newer photo was in the folder too
      await ctx.database
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Locked })
        .where('id', 'in', [cover.id, alreadyLocked.id])
        .execute();
      await expect(coverOf(ctx.database, ownAlbum.id)).resolves.toBe(cover.id);

      await clearLockedAlbumCovers(ctx.database);

      await expect(coverOf(ctx.database, ownAlbum.id)).resolves.toBe(fallback.id);
      await expect(coverOf(ctx.database, otherAlbum.id)).resolves.toBeNull();
      await expect(coverOf(ctx.database, untouched.id)).resolves.toBe(plain.id);
    });
  });
});
