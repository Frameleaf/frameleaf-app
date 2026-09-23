import { Kysely, sql } from 'kysely';
import { AlbumKind, AssetFileType, AssetLockReason, AssetVisibility, PetObservationState } from 'src/enum.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { up as clearLockedCoverReferences } from 'src/schema/migrations/2100000000300-ClearLockedCoverReferences.js';
import { BaseService } from 'src/services/base.service.js';
import { effectiveVisibility } from 'src/utils/locked.js';
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

/** The fork schema phase decides where the sensitive flag and Best Photos scores are read. */
const setForkPhase = (db: Kysely<DB>, phase: string) =>
  sql`UPDATE immich_fork.state SET phase = ${phase} WHERE id = 1`.execute(db);

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  // a library before the fork schema cutover: `asset.is_nsfw` and the public scores are authoritative
  await setForkPhase(defaultDatabase, 'legacy');
});

/** Marks a photo as a Best Photo (score 0.9 and up). */
const markBestPhoto = (db: Kysely<DB>, asset: { id: string; ownerId: string }, score = 0.95) =>
  db
    .insertInto('asset_best_photo_score')
    .values({ assetId: asset.id, ownerId: asset.ownerId, score, scoreVersion: 1, computedAt: new Date() })
    .execute();

/** The visibility each asset shows a caller (FL-34): `locked` when it has a lock record. */
const visibilityOf = async (db: Kysely<DB>, assetIds: string[]) => {
  const rows = await db
    .selectFrom('asset')
    .select(['id', effectiveVisibility('asset').as('visibility')])
    .where('id', 'in', assetIds)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.id, row.visibility]));
};

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

/**
 * A stack of two photos, the second of them the cover of an album that also holds an older photo
 * outside the stack.
 */
const seedStack = async ({ ctx }: ReturnType<typeof setup>) => {
  const { user: owner } = await ctx.newUser();
  const { asset: primary } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: newer });
  const { asset: member } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: newer });
  const { asset: other } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: older });
  await ctx.newStack({ ownerId: owner.id }, [primary.id, member.id]);
  const { album } = await ctx.newAlbum({ ownerId: owner.id, albumThumbnailAssetId: member.id }, [member.id, other.id]);
  return { owner, primary, member, other, album };
};

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

/** A writer that bypassed the release: a lock record (FL-34), covers kept. */
const lockBehindTheRelease = (db: Kysely<DB>, assetId: string) =>
  db
    .insertInto('asset_lock')
    .values({ assetId, reason: AssetLockReason.Marked, lockedBy: null })
    .onConflict((oc) => oc.column('assetId').doNothing())
    .execute();

/** Data saved before FL-53 and before FL-34: the upstream Locked folder, covers kept. */
const lockInOldFolder = (db: Kysely<DB>, assetId: string) =>
  db.updateTable('asset').set({ visibility: AssetVisibility.Locked }).where('id', '=', assetId).execute();

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

  describe('reads that choose or show a cover', () => {
    it('never picks a face on a Locked photo as a person thumbnail, even for another cluster member', async () => {
      const context = setup();
      const { ctx } = context;
      const seeded = await seed(context);
      await lockBehindTheRelease(ctx.database, seeded.cover.id);

      await expect(ctx.get(PersonRepository).getRandomFace(seeded.person.personGroupId)).resolves.toEqual(
        expect.objectContaining({ id: seeded.nextFace.id }),
      );

      await lockBehindTheRelease(ctx.database, seeded.fallback.id);
      await expect(ctx.get(PersonRepository).getRandomFace(seeded.person.personGroupId)).resolves.toBeUndefined();
    });

    it('never returns a Locked cover for a person linked into a shared space', async () => {
      const context = setup();
      const { ctx } = context;
      const seeded = await seed(context);
      await lockBehindTheRelease(ctx.database, seeded.cover.id);

      await expect(ctx.get(AlbumUserRepository).getLinkedPeople(seeded.space.id)).resolves.toEqual([
        expect.objectContaining({ id: seeded.link.id, coverAssetId: null }),
      ]);
    });

    it('returns the cover of a linked person when it is not Locked', async () => {
      const context = setup();
      const { ctx } = context;
      const seeded = await seed(context);

      await expect(ctx.get(AlbumUserRepository).getLinkedPeople(seeded.space.id)).resolves.toEqual([
        expect.objectContaining({ id: seeded.link.id, coverAssetId: seeded.cover.id }),
      ]);
    });
  });

  describe('migration 2100000000300-ClearLockedCoverReferences', () => {
    it('repairs every reference to a photo that was Locked before the fix and leaves the others alone', async () => {
      const context = setup();
      const { ctx } = context;
      const seeded = await seed(context);
      const untouched = await seed(context);
      await lockInOldFolder(ctx.database, seeded.cover.id);
      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({ personFace: seeded.lockedFace.id, petFeatured: seeded.cover.id }),
      );

      await clearLockedCoverReferences(ctx.database);

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual({
        collectionCover: null,
        spaceCover: seeded.fallback.id,
        personFace: seeded.nextFace.id,
        personThumbnailPath: '',
        // the phase says where the sensitive flag is kept, so the space takes a photo every member sees
        spacePersonCover: seeded.fallback.id,
        petFeatured: null,
      });
      await expect(membershipOf(ctx.database, seeded.cover.id)).resolves.toHaveLength(2);
      await expect(referencesOf(ctx.database, untouched)).resolves.toEqual({
        collectionCover: untouched.cover.id,
        spaceCover: untouched.cover.id,
        personFace: untouched.lockedFace.id,
        personThumbnailPath: '/thumbs/person.jpeg',
        spacePersonCover: untouched.cover.id,
        petFeatured: untouched.cover.id,
      });
    });

    it('leaves a person without a face when every face of theirs is on a Locked photo', async () => {
      const context = setup();
      const { ctx } = context;
      const seeded = await seed(context);
      await lockInOldFolder(ctx.database, seeded.cover.id);
      await lockInOldFolder(ctx.database, seeded.fallback.id);

      await clearLockedCoverReferences(ctx.database);

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({ spaceCover: null, personFace: null, personThumbnailPath: '' }),
      );
    });

    it('takes a Best Photo first, then the newest photo', async () => {
      const context = setup();
      const { ctx } = context;
      const seeded = await seed(context);
      const { asset: best } = await ctx.newAsset({ ownerId: seeded.owner.id, fileCreatedAt: new Date('2020-01-01Z') });
      await ctx.newAlbumAsset({ albumId: seeded.space.id, assetId: best.id });
      const { assetFace: bestFace } = await ctx.newAssetFace({
        assetId: best.id,
        personGroupId: seeded.person.personGroupId,
      });
      await markBestPhoto(ctx.database, best);
      await lockInOldFolder(ctx.database, seeded.cover.id);

      await clearLockedCoverReferences(ctx.database);

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({ spaceCover: best.id, personFace: bestFace.id, spacePersonCover: best.id }),
      );
    });

    it('takes only a Timeline Best Photo that is not flagged sensitive where others see it, when it cannot tell which photos are sensitive', async () => {
      const context = setup();
      const { ctx } = context;
      const seeded = await seed(context);
      await lockInOldFolder(ctx.database, seeded.cover.id);

      await setForkPhase(ctx.database, 'inactive');
      try {
        await clearLockedCoverReferences(ctx.database);
        // the fallback is not a Best Photo, so the shared space and its picture of the person take none
        await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
          expect.objectContaining({ spaceCover: null, spacePersonCover: null, personFace: seeded.nextFace.id }),
        );

        await markBestPhoto(ctx.database, seeded.fallback);
        await ctx.database
          .updateTable('album')
          .set({ albumThumbnailAssetId: seeded.cover.id })
          .where('id', '=', seeded.space.id)
          .execute();
        await clearLockedCoverReferences(ctx.database);
        await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
          expect.objectContaining({ spaceCover: seeded.fallback.id }),
        );
      } finally {
        await setForkPhase(ctx.database, 'legacy');
      }
    });

    it('gives a pet the photo of another confirmed observation', async () => {
      const context = setup();
      const { ctx } = context;
      const seeded = await seed(context);
      await ctx.database
        .insertInto('pet_observation')
        .values([
          { petId: seeded.pet.id, assetId: seeded.cover.id },
          { petId: seeded.pet.id, assetId: seeded.fallback.id },
        ])
        .execute();
      await lockInOldFolder(ctx.database, seeded.cover.id);

      await clearLockedCoverReferences(ctx.database);

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({ petFeatured: seeded.fallback.id }),
      );
    });
  });

  describe('replacements (owner decisions 1 and 4)', () => {
    it('prefers a Best Photo over the newest photo for every cover it replaces', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const seeded = await seed(context);
      const { asset: best } = await ctx.newAsset({ ownerId: seeded.owner.id, fileCreatedAt: new Date('2020-01-01Z') });
      await ctx.newAlbumAsset({ albumId: seeded.space.id, assetId: best.id });
      const { assetFace: bestFace } = await ctx.newAssetFace({
        assetId: best.id,
        personGroupId: seeded.person.personGroupId,
      });
      await markBestPhoto(ctx.database, best);

      await sut.update({ id: seeded.cover.id, visibility: AssetVisibility.Locked });

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({ spaceCover: best.id, personFace: bestFace.id, spacePersonCover: best.id }),
      );
    });

    it('ignores a score below the Best Photos threshold', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const seeded = await seed(context);
      const { asset: good } = await ctx.newAsset({ ownerId: seeded.owner.id, fileCreatedAt: new Date('2020-01-01Z') });
      await ctx.newAlbumAsset({ albumId: seeded.space.id, assetId: good.id });
      await markBestPhoto(ctx.database, good, 0.8);

      await sut.update({ id: seeded.cover.id, visibility: AssetVisibility.Locked });

      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({ spaceCover: seeded.fallback.id }),
      );
    });

    it('never takes a sensitive photo for a cover others see, and takes it last for a private album', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { user: owner } = await ctx.newUser();
      const { asset: cover } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: newer });
      const { asset: sensitive } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: older, is_nsfw: true });
      const { album: space } = await ctx.newAlbum(
        { ownerId: owner.id, kind: AlbumKind.Space, albumThumbnailAssetId: cover.id },
        [cover.id, sensitive.id],
      );
      const { album: shared } = await ctx.newAlbum({ ownerId: owner.id, albumThumbnailAssetId: cover.id }, [
        cover.id,
        sensitive.id,
      ]);
      const { user: member } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: shared.id, userId: member.id });
      const { album: own } = await ctx.newAlbum({ ownerId: owner.id, albumThumbnailAssetId: cover.id }, [
        cover.id,
        sensitive.id,
      ]);

      await sut.update({ id: cover.id, visibility: AssetVisibility.Locked });

      await expect(coverOf(ctx.database, space.id)).resolves.toBeNull();
      await expect(coverOf(ctx.database, shared.id)).resolves.toBeNull();
      await expect(coverOf(ctx.database, own.id)).resolves.toBe(sensitive.id);
    });

    it('falls back to the newest confirmed observation of a pet that is not Locked', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const seeded = await seed(context);
      const { asset: rejected } = await ctx.newAsset({ ownerId: seeded.owner.id, fileCreatedAt: newer });
      const { asset: newest } = await ctx.newAsset({
        ownerId: seeded.owner.id,
        fileCreatedAt: new Date('2024-03-01Z'),
      });
      await ctx.database
        .insertInto('pet_observation')
        .values([
          { petId: seeded.pet.id, assetId: seeded.cover.id },
          { petId: seeded.pet.id, assetId: seeded.fallback.id },
          { petId: seeded.pet.id, assetId: newest.id },
          { petId: seeded.pet.id, assetId: rejected.id, state: PetObservationState.Rejected },
        ])
        .execute();

      await sut.update({ id: seeded.cover.id, visibility: AssetVisibility.Locked });

      // the rejected observation is newer, but it is not the pet
      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(
        expect.objectContaining({ petFeatured: newest.id }),
      );

      // with every other confirmed photo Locked, the pet has none
      await sut.updateAll([seeded.fallback.id, newest.id], { visibility: AssetVisibility.Locked });
      await expect(referencesOf(ctx.database, seeded)).resolves.toEqual(expect.objectContaining({ petFeatured: null }));
    });
  });

  describe('stacks (owner decision 3)', () => {
    it('locks the whole stack when one photo becomes Locked and releases every cover of it', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { primary, member, other, album } = await seedStack(context);

      await sut.update({ id: primary.id, visibility: AssetVisibility.Locked });

      await expect(visibilityOf(ctx.database, [primary.id, member.id, other.id])).resolves.toEqual({
        [primary.id]: AssetVisibility.Locked,
        [member.id]: AssetVisibility.Locked,
        [other.id]: AssetVisibility.Timeline,
      });
      // the other photo of the stack was the album cover
      await expect(coverOf(ctx.database, album.id)).resolves.toBe(other.id);
    });

    it('locks whole stacks in a bulk move', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { primary, member, other, album } = await seedStack(context);

      await sut.updateAll([member.id], { visibility: AssetVisibility.Locked, isFavorite: true });

      await expect(visibilityOf(ctx.database, [primary.id, member.id])).resolves.toEqual({
        [primary.id]: AssetVisibility.Locked,
        [member.id]: AssetVisibility.Locked,
      });
      // only the visibility moves the rest of the stack; the other fields are the caller's own
      const favorites = await ctx.database
        .selectFrom('asset')
        .select(['id', 'isFavorite'])
        .where('id', 'in', [primary.id, member.id])
        .execute();
      expect(Object.fromEntries(favorites.map((row) => [row.id, row.isFavorite]))).toEqual({
        [primary.id]: false,
        [member.id]: true,
      });
      await expect(coverOf(ctx.database, album.id)).resolves.toBe(other.id);
    });

    it('unlocks the whole stack, each photo back exactly where it was (FL-34)', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { primary, member } = await seedStack(context);
      await sut.update({ id: member.id, visibility: AssetVisibility.Archive });
      await sut.update({ id: primary.id, visibility: AssetVisibility.Locked });

      await expect(visibilityOf(ctx.database, [primary.id, member.id])).resolves.toEqual({
        [primary.id]: AssetVisibility.Locked,
        [member.id]: AssetVisibility.Locked,
      });

      await expect(sut.unlock([member.id])).resolves.toEqual(
        expect.arrayContaining([
          { assetId: primary.id, reason: AssetLockReason.Marked },
          { assetId: member.id, reason: AssetLockReason.Marked },
        ]),
      );
      await expect(visibilityOf(ctx.database, [primary.id, member.id])).resolves.toEqual({
        [primary.id]: AssetVisibility.Timeline,
        [member.id]: AssetVisibility.Archive,
      });
    });

    it('leaves the rest of the stack alone for a change that does not touch the Locked folder', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { primary, member } = await seedStack(context);

      await sut.update({ id: primary.id, visibility: AssetVisibility.Archive });

      await expect(visibilityOf(ctx.database, [primary.id, member.id])).resolves.toEqual({
        [primary.id]: AssetVisibility.Archive,
        [member.id]: AssetVisibility.Timeline,
      });
    });

    it('locks a new or merged stack that holds a Locked photo as a whole', async () => {
      const context = setup();
      const { ctx } = context;
      const { user: owner } = await ctx.newUser();
      const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
      const { asset: open } = await ctx.newAsset({ ownerId: owner.id });

      const stack = await ctx.get(StackRepository).create({ ownerId: owner.id }, [open.id, locked.id]);

      expect(stack.lockedAssetIds).toEqual([open.id]);
      await expect(visibilityOf(ctx.database, [open.id])).resolves.toEqual({ [open.id]: AssetVisibility.Locked });

      const { asset: first } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: second } = await ctx.newAsset({ ownerId: owner.id });
      const { stack: target } = await ctx.newStack({ ownerId: owner.id }, [first.id, second.id]);
      await ctx.get(StackRepository).merge({ sourceId: stack.id, targetId: target.id });

      await expect(visibilityOf(ctx.database, [first.id, second.id])).resolves.toEqual({
        [first.id]: AssetVisibility.Locked,
        [second.id]: AssetVisibility.Locked,
      });
    });

    it('queues a new thumbnail for a person whose featured face was on another photo of the stack', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const { owner, primary, member, other } = await seedStack(context);
      const { person } = await ctx.newPerson({ ownerId: owner.id, thumbnailPath: '/thumbs/person.jpeg' });
      const { assetFace } = await ctx.newAssetFace({ assetId: member.id, personGroupId: person.personGroupId });
      await ctx.newAssetFace({ assetId: other.id, personGroupId: person.personGroupId });
      await ctx.database
        .updateTable('person')
        .set({ faceAssetId: assetFace.id })
        .where('ownerId', '=', owner.id)
        .where('personGroupId', '=', person.personGroupId)
        .execute();

      await sut.update({ id: primary.id, visibility: AssetVisibility.Locked });

      await expect(ctx.get(PersonRepository).getMissingThumbnailsForAssets([primary.id])).resolves.toEqual([
        { ownerId: owner.id, personGroupId: person.personGroupId },
      ]);
    });
  });

  describe('profile pictures (owner decision 2)', () => {
    it('finds a picture copied from a photo that became Locked and the photo that replaces it', async () => {
      const context = setup();
      const { ctx, sut } = context;
      const users = ctx.get(UserRepository);
      const { user } = await ctx.newUser();
      const { asset: source } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: newer });
      const { asset: newest } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2024-05-01Z') });
      const { asset: best } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2019-01-01Z') });
      const { asset: sensitive } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: newer, is_nsfw: true });
      const { asset: archived } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: newer,
        visibility: AssetVisibility.Archive,
      });
      for (const asset of [source, newest, best, sensitive, archived]) {
        await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `/thumbs/${asset.id}.jpeg` });
      }
      await markBestPhoto(ctx.database, best);
      await markBestPhoto(ctx.database, sensitive, 0.99);
      await markBestPhoto(ctx.database, archived, 0.99);
      await users.update(user.id, { profileImagePath: '/profile/old.webp', profileImageAssetId: source.id });

      await expect(users.hasLockedProfileImageSource(user.id)).resolves.toBe(false);

      await sut.update({ id: source.id, visibility: AssetVisibility.Locked });

      await expect(users.hasLockedProfileImageSource(user.id)).resolves.toBe(true);
      await expect(users.getLockedProfileImageSources()).resolves.toContainEqual({
        id: user.id,
        profileImagePath: '/profile/old.webp',
        profileImageAssetId: source.id,
      });
      // a Best Photo anyone may see first: not sensitive, on the Timeline
      await expect(users.getProfileImageReplacement(user.id)).resolves.toEqual({
        id: best.id,
        path: `/thumbs/${best.id}.jpeg`,
      });

      await expect(
        users.replaceLockedProfileImage(user.id, source.id, {
          profileImagePath: '/profile/new.webp',
          profileImageAssetId: best.id,
        }),
      ).resolves.toBe(true);
      await expect(users.hasLockedProfileImageSource(user.id)).resolves.toBe(false);
      // a second replacement for the same Locked photo finds a picture the user no longer has
      await expect(
        users.replaceLockedProfileImage(user.id, source.id, { profileImagePath: '', profileImageAssetId: null }),
      ).resolves.toBe(false);

      // without Best Photos, the newest photo anyone may see
      await ctx.database.deleteFrom('asset_best_photo_score').where('assetId', '=', best.id).execute();
      await expect(users.getProfileImageReplacement(user.id)).resolves.toEqual(
        expect.objectContaining({ id: newest.id }),
      );
    });
  });
});
