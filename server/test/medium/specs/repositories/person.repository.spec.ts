import { Kysely, sql } from 'kysely';
import { AssetFileType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newEmbedding } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(PersonRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(PersonRepository.name, () => {
  describe('createAll', () => {
    it('should create people in the groups they were given', async () => {
      const { ctx, sut } = setup();
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];

      const [group1, group2] = await sut.createGroups([
        { clusterGroupId: user1.clusterGroupId },
        { clusterGroupId: user1.clusterGroupId },
      ]);
      const group3 = await sut.createGroup(user2.id);

      const people = await sut.createAll([
        { ownerId: user1.id, name: 'Alice', personGroupId: group1.id },
        { ownerId: user1.id, name: 'Bob', personGroupId: group2.id },
        { ownerId: user2.id, name: 'Carol', personGroupId: group3.id },
      ]);

      expect(people.map(({ personGroupId }) => personGroupId)).toEqual([group1.id, group2.id, group3.id]);

      const groups = await ctx.database
        .selectFrom('person')
        .innerJoin('person_group', 'person_group.id', 'person.personGroupId')
        .innerJoin('user', 'user.id', 'person.ownerId')
        .select(['person.name', 'person_group.clusterGroupId', 'user.clusterGroupId as ownerClusterGroupId'])
        .where(
          'person.personGroupId',
          'in',
          people.map(({ personGroupId }) => personGroupId),
        )
        .execute();

      expect(groups).toHaveLength(3);
      for (const group of groups) {
        expect(group.clusterGroupId).toBe(group.ownerClusterGroupId);
      }
    });
  });

  describe('createGroup', () => {
    it('should create a group in the owner cluster group', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const group = await sut.createGroup(user.id);

      const owner = await ctx.database
        .selectFrom('person_group')
        .innerJoin('user', 'user.clusterGroupId', 'person_group.clusterGroupId')
        .select('user.id')
        .where('person_group.id', '=', group.id)
        .executeTakeFirstOrThrow();

      expect(owner.id).toBe(user.id);
    });

    it('should put people created with the same group into that group', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];

      const group = await sut.createGroup(user1.id);
      const person1 = await sut.create({ ownerId: user1.id, name: 'Alice', personGroupId: group.id });
      const person2 = await sut.create({ ownerId: user2.id, name: 'Alice', personGroupId: group.id });

      expect(person1.personGroupId).toBe(group.id);
      expect(person2.personGroupId).toBe(group.id);

      const groups = await ctx.database.selectFrom('person_group').select('person_group.id').execute();
      expect(groups.map(({ id }) => id)).toEqual([group.id]);
    });
  });

  describe('getByGroupId', () => {
    it('should not return a person owned by another user', async () => {
      const { ctx, sut } = setup();
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];
      const group = await sut.createGroup(user1.id);

      const person1 = await sut.create({ ownerId: user1.id, name: 'Alice', personGroupId: group.id });
      const person2 = await ctx.database
        .insertInto('person')
        .values({ ownerId: user2.id, name: 'Alice', personGroupId: person1.personGroupId })
        .returningAll()
        .executeTakeFirstOrThrow();

      await expect(sut.getByGroupId({ ownerId: user1.id, personGroupId: person1.personGroupId })).resolves.toEqual(
        expect.objectContaining({ personGroupId: person1.personGroupId, ownerId: user1.id }),
      );
      await expect(sut.getByGroupId({ ownerId: user2.id, personGroupId: person1.personGroupId })).resolves.toEqual(
        expect.objectContaining({ personGroupId: person2.personGroupId, ownerId: user2.id }),
      );
    });

    it('should return nothing when the group belongs to another user', async () => {
      const { ctx, sut } = setup();
      const [{ user: user1 }, { user: user2 }] = [await ctx.newUser(), await ctx.newUser()];
      const group = await sut.createGroup(user1.id);

      const person = await sut.create({ ownerId: user1.id, name: 'Alice', personGroupId: group.id });

      await expect(
        sut.getByGroupId({ ownerId: user2.id, personGroupId: person.personGroupId }),
      ).resolves.toBeUndefined();
    });
  });

  describe('deleteEmptyGroups', () => {
    it('should delete groups that no longer have any people', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const [keptGroup, emptiedGroup] = await sut.createGroups([
        { clusterGroupId: user.clusterGroupId },
        { clusterGroupId: user.clusterGroupId },
      ]);

      const kept = await sut.create({ ownerId: user.id, name: 'Alice', personGroupId: keptGroup.id });
      const emptied = await sut.create({ ownerId: user.id, name: 'Bob', personGroupId: emptiedGroup.id });
      await ctx.database
        .deleteFrom('person')
        .where('person.ownerId', '=', emptied.ownerId)
        .where('person.personGroupId', '=', emptied.personGroupId)
        .execute();

      await expect(sut.deleteEmptyGroups()).resolves.toBe(1);

      const groups = await ctx.database.selectFrom('person_group').select('person_group.id').execute();
      expect(groups.map(({ id }) => id)).toEqual([kept.personGroupId]);
    });
  });

  describe('deleteOrphanedClusterGroups', () => {
    it('should delete cluster groups that no longer belong to a user, along with their people', async () => {
      const { ctx, sut } = setup(await getKyselyDB());
      const [{ user: kept }, { user: removed }] = [await ctx.newUser(), await ctx.newUser()];
      const keptGroup = await sut.createGroup(kept.id);
      const removedGroup = await sut.createGroup(removed.id);

      const keptPerson = await sut.create({ ownerId: kept.id, name: 'Alice', personGroupId: keptGroup.id });
      await sut.create({ ownerId: removed.id, name: 'Bob', personGroupId: removedGroup.id });
      const { clusterGroupId } = await ctx.database
        .selectFrom('user')
        .select('user.clusterGroupId')
        .where('user.id', '=', kept.id)
        .executeTakeFirstOrThrow();
      await ctx.database.deleteFrom('user').where('user.id', '=', removed.id).execute();

      await expect(sut.deleteOrphanedClusterGroups()).resolves.toBe(1);

      const clusterGroups = await ctx.database.selectFrom('cluster_group').select('cluster_group.id').execute();
      expect(clusterGroups.map(({ id }) => id)).toEqual([clusterGroupId]);

      const groups = await ctx.database.selectFrom('person_group').select('person_group.id').execute();
      expect(groups.map(({ id }) => id)).toEqual([keptPerson.personGroupId]);
    });
  });

  describe('getDataForThumbnailGenerationJob', () => {
    it('should not return the edited preview path', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });

      const { assetFace } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: person.personGroupId,
        boundingBoxX1: 10,
        boundingBoxY1: 10,
        boundingBoxX2: 90,
        boundingBoxY2: 90,
      });

      // there's a circular dependency between assetFace and person, so we need to update the person after creating the assetFace
      await ctx.database
        .updateTable('person')
        .set({ faceAssetId: assetFace.id })
        .where('ownerId', '=', person.ownerId)
        .where('personGroupId', '=', person.personGroupId)
        .execute();

      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_edited.jpg',
        isEdited: true,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_unedited.jpg',
        isEdited: false,
      });

      const result = await sut.getDataForThumbnailGenerationJob({
        ownerId: person.ownerId,
        personGroupId: person.personGroupId,
      });

      expect(result).toEqual(
        expect.objectContaining({
          previewPath: 'preview_unedited.jpg',
        }),
      );
    });
  });

  describe('getForFeatureFaceUpdate', () => {
    it('should ignore soft deleted faces', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, deletedAt: new Date(), personGroupId: person.personGroupId });

      await expect(
        sut.getForFeatureFaceUpdate({ personGroupId: person.personGroupId, assetId: asset.id }),
      ).resolves.toEqual(undefined);
    });
  });

  describe('reassignFace', () => {
    it('should stamp correctedAt as a durable marker of the manual reassignment', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person: from } = await ctx.newPerson({ ownerId: user.id });
      const { person: to } = await ctx.newPerson({ ownerId: user.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: from.personGroupId });

      await expect(sut.getCorrections(from.personGroupId)).resolves.toEqual([]);

      const changed = await sut.reassignFace(assetFace.id, to.personGroupId);
      expect(changed).toBe(1);

      const [row] = await sut.getCorrections(to.personGroupId);
      expect(row).toEqual(
        expect.objectContaining({ id: assetFace.id, assetId: asset.id, correctedAt: expect.any(Date) }),
      );
    });
  });

  describe('getCorrections', () => {
    it('should only return faces that were manually corrected onto this person', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      // Untouched, machine-learning-only assignment: not a correction.
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      await expect(sut.getCorrections(person.personGroupId)).resolves.toEqual([]);
    });

    it('should order corrections most recent first and stop at deleted faces', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { person: elsewhere } = await ctx.newPerson({ ownerId: user.id });

      const { assetFace: older } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: elsewhere.personGroupId,
      });
      const { assetFace: newer } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: elsewhere.personGroupId,
      });
      const { assetFace: deleted } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: elsewhere.personGroupId,
      });

      await sut.reassignFace(older.id, person.personGroupId);
      await sut.reassignFace(newer.id, person.personGroupId);
      await sut.reassignFace(deleted.id, person.personGroupId);
      await ctx.database
        .updateTable('asset_face')
        .set({ deletedAt: new Date() })
        .where('id', '=', deleted.id)
        .execute();

      const corrections = await sut.getCorrections(person.personGroupId);
      expect(corrections.map((face) => face.id)).toEqual([newer.id, older.id]);
    });
  });

  describe('getMergeSuggestions', () => {
    it('should not suggest a hidden person', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { person: hidden } = await ctx.newPerson({ ownerId: user.id, isHidden: true });
      const { person: visible } = await ctx.newPerson({ ownerId: user.id });

      const suggestions = await sut.getMergeSuggestions(user.id, { maxDistance: 1, limit: 20 });
      expect(
        suggestions.some((row) => row.personId === hidden.personGroupId || row.suggestionId === hidden.personGroupId),
      ).toBe(false);
      // Without face_search embeddings for either person's feature face, no pair can be
      // formed at all — this only asserts the hidden-person filter shape, not distance math.
      expect(suggestions.some((row) => row.personId === visible.personGroupId)).toBe(false);
    });

    it('should leave out pairs answered "different", and "later" ones for 30 days (FL-57)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const embedding = newEmbedding();
      const newPersonWithFace = async () => {
        const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
        await ctx.database.insertInto('face_search').values({ faceId: assetFace.id, embedding }).execute();
        const { person } = await ctx.newPerson({ ownerId: user.id, faceAssetId: assetFace.id });
        return person.personGroupId!;
      };
      const [a, b, c] = [await newPersonWithFace(), await newPersonWithFace(), await newPersonWithFace()].toSorted();
      const pairsOf = async () =>
        (await sut.getMergeSuggestions(user.id, { maxDistance: 0.5, limit: 20 }))
          .map(({ personId, suggestionId }) => `${personId}:${suggestionId}`)
          .toSorted();

      await expect(pairsOf()).resolves.toEqual([`${a}:${b}`, `${a}:${c}`, `${b}:${c}`]);

      await expect(sut.setMergeVerdict(user.id, a, b, 'different')).resolves.toEqual(
        expect.objectContaining({ verdict: 'different' }),
      );
      await sut.setMergeVerdict(user.id, a, c, 'later');
      await expect(pairsOf()).resolves.toEqual([`${b}:${c}`]);

      await sql`
        UPDATE immich_fork.person_merge_verdict SET "createdAt" = now() - interval '31 days'
        WHERE "personId" = ${a}::uuid AND "suggestionId" = ${c}::uuid
      `.execute(ctx.database);
      await expect(pairsOf()).resolves.toEqual([`${a}:${c}`, `${b}:${c}`]);

      await expect(sut.deleteMergeVerdict(user.id, a, b)).resolves.toBe(true);
      await expect(sut.deleteMergeVerdict(user.id, a, b)).resolves.toBe(false);
      await expect(pairsOf()).resolves.toEqual([`${a}:${b}`, `${a}:${c}`, `${b}:${c}`]);
    });

    it('should drop verdicts naming a person the owner no longer has (FL-57)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const people = [];
      for (let index = 0; index < 3; index++) {
        const { person } = await ctx.newPerson({ ownerId: user.id });
        people.push(person.personGroupId!);
      }
      const [a, b, c] = people.toSorted();
      const { person: foreign } = await ctx.newPerson({ ownerId: other.id });
      const { person: foreign2 } = await ctx.newPerson({ ownerId: other.id });
      const [x, y] = [foreign.personGroupId!, foreign2.personGroupId!].toSorted();

      await sut.setMergeVerdict(user.id, a, b, 'different');
      await sut.setMergeVerdict(user.id, b, c, 'later');
      await sut.setMergeVerdict(other.id, x, y, 'different');
      await sut.delete([a], user.id);

      await expect(sut.deleteOrphanedMergeVerdicts(user.id)).resolves.toBe(1);
      const remaining = await sql<{ personId: string }>`
        SELECT "personId" FROM immich_fork.person_merge_verdict WHERE "ownerId" IN (${user.id}::uuid, ${other.id}::uuid)
        ORDER BY "personId"
      `.execute(ctx.database);
      expect(remaining.rows.map(({ personId }) => personId).toSorted()).toEqual([b, x].toSorted());

      await ctx.database.deleteFrom('user').where('id', '=', other.id).execute();
      await expect(sut.deleteOrphanedMergeVerdicts(other.id)).resolves.toBe(1);
    });

    it("should not apply one owner's verdict to another owner's suggestions (FL-57)", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const embedding = newEmbedding();
      const ids: string[] = [];
      for (let index = 0; index < 2; index++) {
        const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
        await ctx.database.insertInto('face_search').values({ faceId: assetFace.id, embedding }).execute();
        const { person } = await ctx.newPerson({ ownerId: user.id, faceAssetId: assetFace.id });
        ids.push(person.personGroupId!);
      }
      const [a, b] = ids.toSorted();

      await sut.setMergeVerdict(other.id, a, b, 'different');
      await expect(sut.getMergeSuggestions(user.id, { maxDistance: 0.5 })).resolves.toHaveLength(1);
    });
  });
});
