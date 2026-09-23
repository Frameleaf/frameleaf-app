import { Kysely } from 'kysely';
import { AlbumKind, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Owner decision, September 22, 2026 (FL-53): a Locked photo is never a cover, a featured photo or a
 * face thumbnail. Whatever moves a photo into the Locked folder releases every such reference to it
 * in the same transaction: collection and shared space covers, a shared space's picture for a linked
 * person, a person's featured face and a pet's featured photo. The photo keeps every membership.
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
 * One photo that is every kind of cover: of a collection and of a shared space, the space's picture
 * for a linked person, that person's featured face, and a pet's featured photo. An older photo of
 * the same person, also in the space, is what each reference that has a fallback falls back to.
 */
const seed = async ({ ctx }: ReturnType<typeof setup>) => {
  const { user: owner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  const { asset: cover } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: newer });
  const { asset: fallback } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: older });

  const { album: collection } = await ctx.newAlbum(
    { ownerId: owner.id, kind: AlbumKind.Collection, albumThumbnailAssetId: cover.id },
    [cover.id],
  );
  const { album: space } = await ctx.newAlbum(
    { ownerId: member.id, kind: AlbumKind.Space, albumThumbnailAssetId: cover.id },
    [cover.id, fallback.id],
  );

  const { person } = await ctx.newPerson({ ownerId: owner.id, thumbnailPath: '/thumbs/person.jpeg' });
  const { assetFace: lockedFace } = await ctx.newAssetFace({
    assetId: cover.id,
    personGroupId: person.personGroupId,
  });
  const { assetFace: nextFace } = await ctx.newAssetFace({
    assetId: fallback.id,
    personGroupId: person.personGroupId,
  });
  await ctx.database
    .updateTable('person')
    .set({ faceAssetId: lockedFace.id })
    .where('ownerId', '=', owner.id)
    .where('personGroupId', '=', person.personGroupId)
    .execute();

  const link = await ctx.database
    .insertInto('shared_space_person')
    .values({
      albumId: space.id,
      personOwnerId: owner.id,
      personGroupId: person.personGroupId,
      name: 'Ada',
      coverAssetId: cover.id,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const pet = await ctx.database
    .insertInto('pet')
    .values({ ownerId: owner.id, name: 'Biscuit', featuredAssetId: cover.id })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { owner, cover, fallback, collection, space, person, lockedFace, nextFace, link, pet };
};

type Seeded = Awaited<ReturnType<typeof seed>>;

const referencesOf = async (db: Kysely<DB>, seeded: Seeded) => {
  const albums = await db
    .selectFrom('album')
    .select(['id', 'albumThumbnailAssetId'])
    .where('id', 'in', [seeded.collection.id, seeded.space.id])
    .execute();
  const covers = Object.fromEntries(albums.map((album) => [album.id, album.albumThumbnailAssetId]));
  const person = await db
    .selectFrom('person')
    .select(['faceAssetId', 'thumbnailPath'])
    .where('ownerId', '=', seeded.owner.id)
    .where('personGroupId', '=', seeded.person.personGroupId)
    .executeTakeFirstOrThrow();
  const link = await db
    .selectFrom('shared_space_person')
    .select('coverAssetId')
    .where('id', '=', seeded.link.id)
    .executeTakeFirstOrThrow();
  const pet = await db
    .selectFrom('pet')
    .select('featuredAssetId')
    .where('id', '=', seeded.pet.id)
    .executeTakeFirstOrThrow();

  return {
    collectionCover: covers[seeded.collection.id],
    spaceCover: covers[seeded.space.id],
    personFace: person.faceAssetId,
    personThumbnailPath: person.thumbnailPath,
    spacePersonCover: link.coverAssetId,
    petFeatured: pet.featuredAssetId,
  };
};

const membershipOf = (db: Kysely<DB>, assetId: string) =>
  db.selectFrom('album_asset').select('albumId').where('assetId', '=', assetId).execute();

describe('Locked cover references (FL-53)', () => {
  describe(AssetRepository.prototype.update.name, () => {
    it('releases every cover, featured photo and face thumbnail a photo was when it becomes Locked', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const seeded = await seed(context);

      await sut.update({ id: seeded.cover.id, visibility: AssetVisibility.Locked });

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual({
        // a collection has no photos of its own to fall back to
        collectionCover: null,
        spaceCover: seeded.fallback.id,
        personFace: seeded.nextFace.id,
        // the crop cut from the Locked photo is never served again; a new one is generated
        personThumbnailPath: '',
        spacePersonCover: seeded.fallback.id,
        petFeatured: null,
      });
      // the photo stays in the collection and the space
      await expect(membershipOf(ctx.database, seeded.cover.id)).resolves.toHaveLength(2);
    });

    it('leaves a person without a face when every other face is on a Locked photo', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const seeded = await seed(context);

      await sut.update({ id: seeded.fallback.id, visibility: AssetVisibility.Locked });
      await sut.update({ id: seeded.cover.id, visibility: AssetVisibility.Locked });

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({ personFace: null, personThumbnailPath: '', spacePersonCover: null }),
      );
    });

    it('keeps every reference for any other visibility change', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const seeded = await seed(context);

      await sut.update({ id: seeded.cover.id, visibility: AssetVisibility.Archive });
      await sut.update({ id: seeded.cover.id, isFavorite: true });

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual({
        collectionCover: seeded.cover.id,
        spaceCover: seeded.cover.id,
        personFace: seeded.lockedFace.id,
        personThumbnailPath: '/thumbs/person.jpeg',
        spacePersonCover: seeded.cover.id,
        petFeatured: seeded.cover.id,
      });
    });

    it('rolls back with the transaction it is bound to', async () => {
      const context = setup();
      const { ctx } = context;
      const seeded = await seed(context);

      await expect(
        ctx.database.transaction().execute(async (tx) => {
          await new AssetRepository(tx).update({ id: seeded.cover.id, visibility: AssetVisibility.Locked });
          await expect(referencesOf(tx, seeded)).resolves.toEqual(expect.objectContaining({ petFeatured: null }));
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({ personFace: seeded.lockedFace.id, petFeatured: seeded.cover.id }),
      );
    });
  });

  describe(AssetRepository.prototype.updateAll.name, () => {
    it('releases every reference in a bulk move into the Locked folder', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const seeded = await seed(context);
      const { asset: unrelated } = await ctx.newAsset({ ownerId: seeded.owner.id });

      await sut.updateAll([seeded.cover.id, unrelated.id], { visibility: AssetVisibility.Locked });

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual({
        collectionCover: null,
        spaceCover: seeded.fallback.id,
        personFace: seeded.nextFace.id,
        personThumbnailPath: '',
        spacePersonCover: seeded.fallback.id,
        petFeatured: null,
      });
    });

    it('does not touch a person whose featured face is on another photo', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const seeded = await seed(context);

      // only the fallback photo, which is not the featured face, moves
      await sut.updateAll([seeded.fallback.id], { visibility: AssetVisibility.Locked });

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({
          personFace: seeded.lockedFace.id,
          personThumbnailPath: '/thumbs/person.jpeg',
          spacePersonCover: seeded.cover.id,
          petFeatured: seeded.cover.id,
        }),
      );
    });
  });
});
