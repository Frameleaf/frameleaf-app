import { Kysely, sql } from 'kysely';
import { AssetFileType, AssetVisibility, SourceType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newEmbedding, newUuid } from 'test/small.factory.js';
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

  describe('getFeaturedAsset (FL-37)', () => {
    it('reads the photo of a face with what decides whether it may be shown', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      await expect(sut.getFeaturedAsset(assetFace.id, user.id)).resolves.toEqual({
        id: asset.id,
        visibility: AssetVisibility.Archive,
        deletedAt: null,
      });
      await expect(sut.getFeaturedAsset(newUuid(), user.id)).resolves.toBeUndefined();
    });

    // a person group spans a cluster's accounts, so the featured face can be on someone else's photo
    it("never names another account's photo", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: other.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

      await expect(sut.getFeaturedAsset(assetFace.id, user.id)).resolves.toBeUndefined();
      await expect(sut.getFeaturedAsset(assetFace.id, other.id)).resolves.toMatchObject({ id: asset.id });
    });

    it('never names the photo of a soft-deleted or invisible face', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { assetFace: removed } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: person.personGroupId,
        deletedAt: new Date(),
      });
      const { assetFace: invisible } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: person.personGroupId,
        isVisible: false,
      });

      await expect(sut.getFeaturedAsset(removed.id, user.id)).resolves.toBeUndefined();
      await expect(sut.getFeaturedAsset(invisible.id, user.id)).resolves.toBeUndefined();
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

      await expect(sut.reassignFace(assetFace.id, to.personGroupId)).resolves.toBe(1);

      const row = await ctx.database
        .selectFrom('asset_face')
        .select(['personGroupId', 'correctedAt'])
        .where('id', '=', assetFace.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ personGroupId: to.personGroupId, correctedAt: expect.any(Date) });
    });
  });

  describe('face correction history (FL-57)', () => {
    it("anchors a decision to the face's photo, checksum and normalized box, and pages the owner's history", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person: from } = await ctx.newPerson({ ownerId: user.id, name: 'Before' });
      const { person: to } = await ctx.newPerson({ ownerId: user.id, name: 'After' });
      const faces = [];
      for (let index = 0; index < 3; index++) {
        const { assetFace } = await ctx.newAssetFace({
          assetId: asset.id,
          personGroupId: to.personGroupId,
          imageWidth: 200,
          imageHeight: 100,
          boundingBoxX1: 20 * index,
          boundingBoxY1: 10,
          boundingBoxX2: 20 * index + 40,
          boundingBoxY2: 50,
        });
        faces.push(assetFace);
      }

      for (const face of faces) {
        await sut.recordFaceCorrections([
          {
            ownerId: user.id,
            actorId: user.id,
            action: 'reassign',
            faceId: face.id,
            fromPersonId: from.personGroupId,
            toPersonId: to.personGroupId,
            fromPersonName: 'Before',
            toPersonName: 'After',
          },
        ]);
      }
      const [merge] = await sut.recordFaceCorrections([
        {
          ownerId: user.id,
          actorId: user.id,
          action: 'merge',
          fromPersonId: from.personGroupId,
          toPersonId: to.personGroupId,
        },
      ]);
      expect(merge).toEqual(expect.objectContaining({ faceId: null, assetId: null, boxX1: null }));

      const first = await sut.getFaceCorrections(user.id, to.personGroupId, { take: 2, skip: 0 });
      expect(first.hasNextPage).toBe(true);
      expect(first.items.map(({ action }) => action)).toEqual(['merge', 'reassign']);
      const second = await sut.getFaceCorrections(user.id, to.personGroupId, { take: 2, skip: 2 });
      expect(second.hasNextPage).toBe(false);
      const oldest = second.items.at(-1)!;
      expect(oldest).toEqual(
        expect.objectContaining({
          faceId: faces[0].id,
          assetId: asset.id,
          assetChecksum: asset.checksum,
          boxX1: 0,
          boxY1: 0.1,
          boxX2: 0.2,
          boxY2: 0.5,
          undoneAt: null,
        }),
      );

      // the history of the person the faces left includes them too; another owner sees none of it
      await expect(sut.getFaceCorrections(user.id, from.personGroupId, { take: 10 })).resolves.toEqual(
        expect.objectContaining({ items: expect.arrayContaining([expect.objectContaining({ id: oldest.id })]) }),
      );
      await expect(sut.getFaceCorrections(other.id, to.personGroupId, { take: 10 })).resolves.toEqual({
        items: [],
        hasNextPage: false,
      });
      await expect(sut.getFaceCorrection(other.id, oldest.id)).resolves.toBeUndefined();

      // undo writes the face at the revision it was checked at, together with the history entry
      const revisionOf = async (id: string) =>
        (await ctx.database.selectFrom('asset_face').select('updateId').where('id', '=', id).executeTakeFirstOrThrow())
          .updateId;
      const checked = await revisionOf(faces[0].id);
      // another view corrects the face first: the undo leaves it alone and nothing is marked undone
      await ctx.database.updateTable('asset_face').set({ boundingBoxX1: 1 }).where('id', '=', faces[0].id).execute();
      await expect(
        sut.undoFaceCorrection(oldest.id, { id: faces[0].id, expectedRevision: checked }, { personGroupId: null }),
      ).resolves.toBe('face-changed');
      await expect(sut.getFaceCorrection(user.id, oldest.id)).resolves.toEqual(
        expect.objectContaining({ undoneAt: null }),
      );
      await expect(
        ctx.database.selectFrom('asset_face').select('personGroupId').where('id', '=', faces[0].id).executeTakeFirst(),
      ).resolves.toEqual({ personGroupId: to.personGroupId });

      const current = await revisionOf(faces[0].id);
      await expect(
        sut.undoFaceCorrection(
          oldest.id,
          { id: faces[0].id, expectedRevision: current },
          { personGroupId: from.personGroupId },
        ),
      ).resolves.toBe('undone');
      await expect(
        ctx.database.selectFrom('asset_face').select('personGroupId').where('id', '=', faces[0].id).executeTakeFirst(),
      ).resolves.toEqual({ personGroupId: from.personGroupId });
      await expect(
        sut.undoFaceCorrection(
          oldest.id,
          { id: faces[0].id, expectedRevision: await revisionOf(faces[0].id) },
          { personGroupId: from.personGroupId },
        ),
      ).resolves.toBe('already-undone');
    });

    it('offers the decisions about a face that no longer exists, newest first, to the face that replaces it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { assetFace } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: person.personGroupId,
        imageWidth: 100,
        imageHeight: 100,
        boundingBoxX1: 10,
        boundingBoxY1: 10,
        boundingBoxX2: 30,
        boundingBoxY2: 30,
      });
      await sut.recordFaceCorrections([
        {
          ownerId: user.id,
          actorId: user.id,
          action: 'unassign',
          faceId: assetFace.id,
          fromPersonId: person.personGroupId,
        },
      ]);
      await sut.recordFaceCorrections([
        {
          ownerId: user.id,
          actorId: user.id,
          action: 'reassign',
          faceId: assetFace.id,
          toPersonId: person.personGroupId,
        },
      ]);
      await expect(sut.getOrphanedFaceCorrections(asset.id)).resolves.toEqual([]);

      await sut.deleteAssetFace(assetFace.id);
      const [latest] = await sut.getOrphanedFaceCorrections(asset.id);
      expect(latest).toEqual(expect.objectContaining({ action: 'reassign', faceId: assetFace.id }));

      const { assetFace: replacement } = await ctx.newAssetFace({ assetId: asset.id });
      await sut.reanchorFaceCorrections(assetFace.id, replacement.id);
      await expect(sut.getOrphanedFaceCorrections(asset.id)).resolves.toEqual([]);
      const { items } = await sut.getFaceCorrections(user.id, person.personGroupId, { take: 10 });
      expect(items.every(({ faceId }) => faceId === replacement.id)).toBe(true);
    });

    it('keeps faces with an explicit decision through a forced detection rebuild, unless the original changed', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: replaced } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { assetFace: plain } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      const { assetFace: corrected } = await ctx.newAssetFace({ assetId: asset.id });
      const { assetFace: removed } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      const { assetFace: stale } = await ctx.newAssetFace({ assetId: replaced.id });
      await sut.reassignFace(corrected.id, person.personGroupId);
      await sut.reassignFace(stale.id, person.personGroupId);
      await sut.softDeleteAssetFaces(removed.id);
      for (const faceId of [corrected.id, removed.id, stale.id]) {
        await sut.recordFaceCorrections([{ ownerId: user.id, actorId: user.id, action: 'reassign', faceId }]);
      }
      await ctx.database
        .updateTable('asset')
        .set({ checksum: Buffer.from('a replaced original') })
        .where('id', '=', replaced.id)
        .execute();

      await sut.deleteFaces({ sourceType: SourceType.MachineLearning });

      const left = await ctx.database
        .selectFrom('asset_face')
        .select('id')
        .where('assetId', 'in', [asset.id, replaced.id])
        .execute();
      expect(left.map(({ id }) => id).toSorted()).toEqual([corrected.id, removed.id].toSorted());
      expect(left.some(({ id }) => id === plain.id)).toBe(false);
    });

    it('keeps corrected and merged faces with their person through a forced recognition rebuild', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { person: merged } = await ctx.newPerson({ ownerId: user.id });
      const { assetFace: plain } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      const { assetFace: corrected } = await ctx.newAssetFace({ assetId: asset.id });
      const { assetFace: fromMerge } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: merged.personGroupId,
      });
      await sut.reassignFace(corrected.id, person.personGroupId);
      await sut.reassignFaces({
        oldPersonGroupId: merged.personGroupId,
        newPersonGroupId: person.personGroupId,
        ownerId: user.id,
        corrected: true,
      });

      await sut.unassignFaces({ sourceType: SourceType.MachineLearning });

      const rows = await ctx.database
        .selectFrom('asset_face')
        .select(['id', 'personGroupId'])
        .where('assetId', '=', asset.id)
        .execute();
      const byId = new Map(rows.map(({ id, personGroupId }) => [id, personGroupId]));
      expect(byId.get(plain.id)).toBeNull();
      expect(byId.get(corrected.id)).toBe(person.personGroupId);
      expect(byId.get(fromMerge.id)).toBe(person.personGroupId);

      // recognition only takes a face that is still undecided
      await expect(
        sut.reassignFaces({ faceIds: [corrected.id], newPersonGroupId: merged.personGroupId, onlyUndecided: true }),
      ).resolves.toBe(0);
      await expect(
        sut.reassignFaces({ faceIds: [plain.id], newPersonGroupId: merged.personGroupId, onlyUndecided: true }),
      ).resolves.toBe(1);
    });

    it("shows only the viewer's own, visible, unlocked, untrashed media as evidence", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset: own } = await ctx.newAsset({ ownerId: user.id });
      const { asset: archived } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { asset: foreign } = await ctx.newAsset({ ownerId: other.id });

      const visible = await sut.getVisibleEvidenceAssetIds(user.id, [
        own.id,
        archived.id,
        locked.id,
        trashed.id,
        foreign.id,
      ]);
      expect([...visible].toSorted()).toEqual([own.id, archived.id].toSorted());
    });

    it('picks the featured face as the reference face only when it may be shown', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: own } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { assetFace: lockedFace } = await ctx.newAssetFace({
        assetId: locked.id,
        personGroupId: person.personGroupId,
      });
      const { assetFace: ownFace } = await ctx.newAssetFace({ assetId: own.id, personGroupId: person.personGroupId });
      await sut.update({ ownerId: user.id, personGroupId: person.personGroupId, faceAssetId: lockedFace.id });

      await expect(sut.getReferenceFaces(user.id, [person.personGroupId])).resolves.toEqual([
        expect.objectContaining({ personGroupId: person.personGroupId, faceId: ownFace.id, assetId: own.id }),
      ]);
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

    it('should drop verdicts naming a person the owner no longer has and no anchor face (FL-57)', async () => {
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

      await expect(sut.reanchorMergeVerdicts(user.id)).resolves.toBe(1);
      const remaining = await sql<{ personId: string }>`
        SELECT "personId" FROM immich_fork.person_merge_verdict WHERE "ownerId" IN (${user.id}::uuid, ${other.id}::uuid)
        ORDER BY "personId"
      `.execute(ctx.database);
      expect(remaining.rows.map(({ personId }) => personId).toSorted()).toEqual([b, x].toSorted());

      await sut.deleteForkPeopleData(other.id);
      await expect(sut.reanchorMergeVerdicts(other.id)).resolves.toBe(0);
    });

    it('should keep an answer with its people when recognition rebuilds them, and drop it once they are merged (FL-57)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const newPersonWithFace = async () => {
        const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
        const { person } = await ctx.newPerson({ ownerId: user.id, faceAssetId: assetFace.id });
        await sut.reassignFaces({ faceIds: [assetFace.id], newPersonGroupId: person.personGroupId! });
        return { personGroupId: person.personGroupId!, faceId: assetFace.id };
      };
      const [first, second] = [await newPersonWithFace(), await newPersonWithFace()].toSorted((l, r) =>
        l.personGroupId.localeCompare(r.personGroupId),
      );
      await sut.setMergeVerdict(user.id, first.personGroupId, second.personGroupId, 'different');
      await sut.setMergeVerdict(user.id, first.personGroupId, first.personGroupId, 'ignore');

      // a forced recognition run takes the faces off, deletes the empty people ...
      await sut.unassignFaces({ sourceType: SourceType.MachineLearning });
      await sut.delete([first.personGroupId, second.personGroupId], user.id);
      await expect(sut.reanchorMergeVerdicts(user.id)).resolves.toBe(0);
      const count = async () =>
        (
          await sql<{ count: number }>`
            SELECT count(*)::int AS count FROM immich_fork.person_merge_verdict WHERE "ownerId" = ${user.id}::uuid
          `.execute(ctx.database)
        ).rows[0].count;
      await expect(count()).resolves.toBe(2);

      // ... and clusters them into new people: the answers follow their anchor faces
      const rebuilt = async ({ faceId }: { faceId: string }) => {
        const { person } = await ctx.newPerson({ ownerId: user.id, faceAssetId: faceId });
        await sut.reassignFaces({ faceIds: [faceId], newPersonGroupId: person.personGroupId! });
        return person.personGroupId!;
      };
      const [p, q] = [await rebuilt(first), await rebuilt(second)];
      await expect(sut.reanchorMergeVerdicts(user.id)).resolves.toBe(0);
      const rows = await sql<{ personId: string; suggestionId: string; verdict: string }>`
        SELECT "personId", "suggestionId", verdict FROM immich_fork.person_merge_verdict WHERE "ownerId" = ${user.id}::uuid
        ORDER BY verdict
      `.execute(ctx.database);
      expect(rows.rows).toEqual([
        { personId: [p, q].toSorted()[0], suggestionId: [p, q].toSorted()[1], verdict: 'different' },
        { personId: p, suggestionId: p, verdict: 'ignore' },
      ]);

      // once both anchors belong to one person the pair answer goes; "ignore" stays with the person
      await sut.reassignFaces({ oldPersonGroupId: q, newPersonGroupId: p, corrected: true });
      await sut.delete([q], user.id);
      await expect(sut.reanchorMergeVerdicts(user.id)).resolves.toBe(1);
      await expect(count()).resolves.toBe(1);
    });

    it('should never let "later" replace "different", and suggest nobody with an ignored person (FL-57)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const embedding = newEmbedding();
      const ids: string[] = [];
      for (let index = 0; index < 3; index++) {
        const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
        await ctx.database.insertInto('face_search').values({ faceId: assetFace.id, embedding }).execute();
        const { person } = await ctx.newPerson({ ownerId: user.id, faceAssetId: assetFace.id });
        ids.push(person.personGroupId!);
      }
      const [a, b, c] = ids.toSorted();

      await sut.setMergeVerdict(user.id, a, b, 'different');
      await expect(sut.setMergeVerdict(user.id, a, b, 'later')).resolves.toEqual(
        expect.objectContaining({ verdict: 'different' }),
      );

      await sut.setMergeVerdict(user.id, c, c, 'ignore');
      await expect(sut.getMergeSuggestions(user.id, { maxDistance: 0.5 })).resolves.toEqual([]);
      await expect(sut.deleteMergeVerdict(user.id, c, c)).resolves.toBe(true);
      await expect(sut.getMergeSuggestions(user.id, { maxDistance: 0.5 })).resolves.toHaveLength(2);

      await expect(
        sql`INSERT INTO immich_fork.person_merge_verdict ("ownerId", "personId", "suggestionId", verdict)
            VALUES (${user.id}::uuid, ${a}::uuid, ${b}::uuid, 'ignore')`.execute(ctx.database),
      ).rejects.toThrow();
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
