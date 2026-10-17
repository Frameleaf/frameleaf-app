import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { SourceType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newEmbedding } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-326: universal people for partner copies (PersonRepository). */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(PersonRepository), origins: ctx.get(PartnerOriginRepository) };
};

describe('PartnerOriginRepository.getOriginLabels', () => {
  it("labels only the owner's own copies with the original uploader's name", async () => {
    const { ctx, origins } = setup();
    const { user: alice } = await ctx.newUser({ name: 'Jamie' });
    const { user: bob } = await ctx.newUser();
    const { asset: source } = await ctx.newAsset({ ownerId: alice.id });
    const { asset: copy } = await ctx.newAsset({ ownerId: bob.id });
    const { asset: own } = await ctx.newAsset({ ownerId: bob.id });
    await origins.createAssetOrigin({
      id: copy.id,
      sourceId: source.id,
      ownerId: bob.id,
      rootOwnerId: alice.id,
      partnerSharedById: alice.id,
    });

    await expect(origins.getOriginLabels('asset', [copy.id, own.id], bob.id)).resolves.toEqual(
      new Map([[copy.id, { rootOwnerId: alice.id, rootOwnerName: 'Jamie' }]]),
    );
    await expect(origins.getOriginLabels('asset', [copy.id], alice.id)).resolves.toEqual(new Map());
    await expect(origins.getOriginLabels('album', [], bob.id)).resolves.toEqual(new Map());
  });
});

describe('PersonRepository partner people', () => {
  it('copies faces with their exact boxes, embedding and mapped person, once', async () => {
    const { ctx, sut } = setup();
    const { user: alice } = await ctx.newUser();
    const { user: bob } = await ctx.newUser();
    const { person: emma } = await ctx.newPerson({ ownerId: alice.id, name: 'Emma' });
    const { person: bobsEmma } = await ctx.newPerson({ ownerId: bob.id, name: 'Emma' });
    const { asset: source } = await ctx.newAsset({ ownerId: alice.id });
    const { asset: copy } = await ctx.newAsset({ ownerId: bob.id });
    const { assetFace: face } = await ctx.newAssetFace({
      assetId: source.id,
      personGroupId: emma.personGroupId,
      imageWidth: 1000,
      imageHeight: 800,
      boundingBoxX1: 10,
      boundingBoxY1: 20,
      boundingBoxX2: 110,
      boundingBoxY2: 140,
      sourceType: SourceType.Manual,
    });
    const embedding = newEmbedding();
    await ctx.database.insertInto('face_search').values({ faceId: face.id, embedding }).execute();

    await expect(sut.getFacesForPartnerCopy(source.id)).resolves.toEqual([
      { id: face.id, personGroupId: emma.personGroupId, hasEmbedding: true },
    ]);
    const faceId = randomUUID();
    await expect(
      sut.copyFacesToAsset(copy.id, [{ sourceFaceId: face.id, faceId, personGroupId: bobsEmma.personGroupId }]),
    ).resolves.toBe(1);

    const copied = await ctx.database
      .selectFrom('asset_face')
      .selectAll()
      .where('id', '=', faceId)
      .executeTakeFirstOrThrow();
    expect(copied).toMatchObject({
      assetId: copy.id,
      personGroupId: bobsEmma.personGroupId,
      imageWidth: 1000,
      imageHeight: 800,
      boundingBoxX1: 10,
      boundingBoxY1: 20,
      boundingBoxX2: 110,
      boundingBoxY2: 140,
      sourceType: SourceType.Manual,
      correctedAt: null,
    });
    await expect(sut.getFaceEmbedding(faceId)).resolves.toEqual(await sut.getFaceEmbedding(face.id));

    // copying again leaves the copy alone
    await expect(
      sut.copyFacesToAsset(copy.id, [{ sourceFaceId: face.id, faceId: randomUUID(), personGroupId: null }]),
    ).resolves.toBe(0);
  });

  it('keeps a mapping per recipient, only while its person exists, and follows a merge', async () => {
    const { ctx, sut } = setup();
    const { user: alice } = await ctx.newUser();
    const { user: bob } = await ctx.newUser();
    const { person: emma } = await ctx.newPerson({ ownerId: alice.id, name: 'Emma' });
    const { person: copyOfEmma } = await ctx.newPerson({ ownerId: bob.id, name: 'Emma' });
    const { person: bobsOwn } = await ctx.newPerson({ ownerId: bob.id, name: 'Em' });
    const link = {
      ownerId: bob.id,
      sourcePersonGroupId: emma.personGroupId,
      personGroupId: copyOfEmma.personGroupId,
      kind: 'created' as const,
      partnerSharedById: alice.id,
      correctionId: null,
    };

    await sut.savePartnerPersonLink(link);
    await expect(sut.getPartnerPersonLink(bob.id, emma.personGroupId)).resolves.toEqual(link);
    await expect(sut.getPartnerPersonLink(alice.id, emma.personGroupId)).resolves.toBeUndefined();

    await sut.repointPartnerPersonLinks(bob.id, copyOfEmma.personGroupId, bobsOwn.personGroupId);
    await expect(sut.getPartnerPersonLink(bob.id, emma.personGroupId)).resolves.toEqual({
      ...link,
      personGroupId: bobsOwn.personGroupId,
      kind: 'merged',
    });

    await ctx.database
      .deleteFrom('person')
      .where('ownerId', '=', bob.id)
      .where('personGroupId', '=', bobsOwn.personGroupId)
      .execute();
    await expect(sut.getPartnerPersonLink(bob.id, emma.personGroupId)).resolves.toBeUndefined();
  });

  it('records an auto-merge and undoes it by moving only the merged faces', async () => {
    const { ctx, sut, origins } = setup();
    const { user: alice } = await ctx.newUser();
    const { user: bob } = await ctx.newUser();
    const { person: emma } = await ctx.newPerson({ ownerId: alice.id, name: 'Emma' });
    const { person: bobsEmma } = await ctx.newPerson({ ownerId: bob.id, name: 'Emma R.' });
    const { person: split } = await ctx.newPerson({ ownerId: bob.id, name: 'Emma' });
    const { asset: source } = await ctx.newAsset({ ownerId: alice.id });
    const { asset: copy } = await ctx.newAsset({ ownerId: bob.id });
    const { asset: bobsPhoto } = await ctx.newAsset({ ownerId: bob.id });
    const box = { boundingBoxX1: 5, boundingBoxY1: 5, boundingBoxX2: 50, boundingBoxY2: 50 };
    await ctx.newAssetFace({ assetId: source.id, personGroupId: emma.personGroupId, ...box });
    const { assetFace: merged } = await ctx.newAssetFace({
      assetId: copy.id,
      personGroupId: bobsEmma.personGroupId,
      ...box,
    });
    const { assetFace: own } = await ctx.newAssetFace({
      assetId: bobsPhoto.id,
      personGroupId: bobsEmma.personGroupId,
      ...box,
    });
    await origins.createAssetOrigin({
      id: copy.id,
      sourceId: source.id,
      ownerId: bob.id,
      rootOwnerId: alice.id,
      partnerSharedById: alice.id,
    });

    const [correction] = await sut.recordFaceCorrections([
      {
        ownerId: bob.id,
        actorId: bob.id,
        action: 'partner-merge',
        faceId: null,
        fromPersonId: null,
        toPersonId: bobsEmma.personGroupId,
        fromPersonName: 'Emma',
        toPersonName: 'Emma R.',
      },
    ]);
    expect(correction).toMatchObject({ action: 'partner-merge', assetId: null, toPersonId: bobsEmma.personGroupId });
    const { items } = await sut.getFaceCorrections(bob.id, bobsEmma.personGroupId, { take: 10, skip: 0 });
    expect(items.map(({ id }) => id)).toEqual([correction.id]);

    await sut.savePartnerPersonLink({
      ownerId: bob.id,
      sourcePersonGroupId: emma.personGroupId,
      personGroupId: bobsEmma.personGroupId,
      kind: 'merged',
      partnerSharedById: alice.id,
      correctionId: correction.id,
    });
    await expect(sut.getPartnerPersonLinkByCorrection(bob.id, correction.id)).resolves.toMatchObject({
      sourcePersonGroupId: emma.personGroupId,
    });

    const faceIds = await sut.getPartnerMergedFaceIds(bob.id, emma.personGroupId, bobsEmma.personGroupId);
    expect(faceIds).toEqual([merged.id]);

    await expect(sut.undoPartnerMerge(correction.id, faceIds, split.personGroupId)).resolves.toBe(true);
    await expect(sut.undoPartnerMerge(correction.id, faceIds, split.personGroupId)).resolves.toBe(false);

    const faces = await ctx.database
      .selectFrom('asset_face')
      .select(['id', 'personGroupId'])
      .where('id', 'in', [merged.id, own.id])
      .execute();
    expect(Object.fromEntries(faces.map(({ id, personGroupId }) => [id, personGroupId]))).toEqual({
      [merged.id]: split.personGroupId,
      [own.id]: bobsEmma.personGroupId,
    });
    await expect(sut.getFaceCorrection(bob.id, correction.id)).resolves.toMatchObject({ undoneAt: expect.any(Date) });
  });
});
