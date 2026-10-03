import { Kysely } from 'kysely';
import { AssetLockReason, UserMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { PartnerLockService } from 'src/services/partner-lock.service.js';
import { PartnerPeopleService } from 'src/services/partner-people.service.js';
import { PersonService } from 'src/services/person.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newEmbedding } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-326 against PostgreSQL: a partner copy brings its faces and maps the partner's people (auto-merge by
 * face similarity with an undo in correction history, or a new person that follows), and Locked items
 * arrive locked behind the recipient's own PIN.
 */
let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database,
    real: [
      AccessRepository,
      AssetRepository,
      ConfigRepository,
      DatabaseRepository,
      PartnerOriginRepository,
      PersonRepository,
      SearchRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [JobRepository, LoggingRepository],
  });
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  return { ctx, base: ctx.sut as BaseService };
};

const sharedPhoto = async (ctx: ReturnType<typeof setup>['ctx'], embedding: string) => {
  const { user: alice } = await ctx.newUser({ name: 'Jamie' });
  const { user: bob } = await ctx.newUser();
  const { person: emma } = await ctx.newPerson({ ownerId: alice.id, name: 'Emma' });
  const { asset: source } = await ctx.newAsset({ ownerId: alice.id });
  const { asset: copy } = await ctx.newAsset({ ownerId: bob.id });
  const box = { boundingBoxX1: 10, boundingBoxY1: 10, boundingBoxX2: 90, boundingBoxY2: 90 };
  const { assetFace: face } = await ctx.newAssetFace({ assetId: source.id, personGroupId: emma.personGroupId, ...box });
  await ctx.database.insertInto('face_search').values({ faceId: face.id, embedding }).execute();
  await ctx.get(PartnerOriginRepository).createAssetOrigin({
    id: copy.id,
    sourceId: source.id,
    ownerId: bob.id,
    rootOwnerId: alice.id,
    partnerSharedById: alice.id,
  });
  return { alice, bob, emma, source, copy, box };
};

describe('PartnerPeopleService (FL-326)', () => {
  it("merges into the recipient's matching person, logs it, and undoes it into a following person", async () => {
    const { ctx, base } = setup();
    const embedding = newEmbedding();
    const { alice, bob, emma, source, copy } = await sharedPhoto(ctx, embedding);
    // Bob already knows Emma: a face of his own with the same embedding
    const { person: bobsEmma } = await ctx.newPerson({ ownerId: bob.id, name: 'Em' });
    const { asset: bobsPhoto } = await ctx.newAsset({ ownerId: bob.id });
    const { assetFace: bobsFace } = await ctx.newAssetFace({
      assetId: bobsPhoto.id,
      personGroupId: bobsEmma.personGroupId,
    });
    await ctx.database.insertInto('face_search').values({ faceId: bobsFace.id, embedding }).execute();

    const people = BaseService.create(PartnerPeopleService, base);
    await expect(
      people.copyFaces({
        sourceAssetId: source.id,
        targetAssetId: copy.id,
        targetOwnerId: bob.id,
        partnerSharedById: alice.id,
      }),
    ).resolves.toBe(1);

    const copied = await ctx.database.selectFrom('asset_face').selectAll().where('assetId', '=', copy.id).execute();
    expect(copied.map(({ personGroupId }) => personGroupId)).toEqual([bobsEmma.personGroupId]);

    const auth = factory.auth({ user: bob });
    const personService = BaseService.create(PersonService, base);
    const { corrections } = await personService.getCorrectionHistory(auth, bobsEmma.personGroupId, {
      page: 1,
      size: 25,
    });
    expect(corrections).toEqual([
      expect.objectContaining({
        action: 'partner-merge',
        undoable: true,
        fromPerson: { id: emma.personGroupId, name: 'Emma', exists: false },
        toPerson: expect.objectContaining({ id: bobsEmma.personGroupId }),
      }),
    ]);

    await personService.undoCorrection(auth, corrections[0].id);

    const [moved] = await ctx.database.selectFrom('asset_face').selectAll().where('assetId', '=', copy.id).execute();
    expect(moved.personGroupId).not.toBe(bobsEmma.personGroupId);
    const own = await ctx.database
      .selectFrom('asset_face')
      .selectAll()
      .where('id', '=', bobsFace.id)
      .executeTakeFirstOrThrow();
    expect(own.personGroupId).toBe(bobsEmma.personGroupId);
    await expect(ctx.get(PartnerOriginRepository).getPersonMapping(bob.id, emma.personGroupId)).resolves.toMatchObject({
      personGroupId: moved.personGroupId,
      rootOwnerId: alice.id,
    });
  });

  it('creates a following person when nothing matches, and a rename reaches it until the recipient renames', async () => {
    const { ctx, base } = setup();
    const { alice, bob, emma, source, copy } = await sharedPhoto(ctx, newEmbedding());

    await BaseService.create(PartnerPeopleService, base).copyFaces({
      sourceAssetId: source.id,
      targetAssetId: copy.id,
      targetOwnerId: bob.id,
      partnerSharedById: alice.id,
    });
    const mapping = await ctx.get(PartnerOriginRepository).getPersonMapping(bob.id, emma.personGroupId);
    expect(mapping).toBeDefined();
    const personService = BaseService.create(PersonService, base);
    const aliceAuth = factory.auth({ user: alice });
    const bobAuth = factory.auth({ user: bob });
    const bobsPerson = () =>
      ctx.get(PersonRepository).getByGroupId({ ownerId: bob.id, personGroupId: mapping!.personGroupId });
    await expect(bobsPerson()).resolves.toMatchObject({ name: 'Emma' });

    await personService.update(aliceAuth, emma.personGroupId, { name: 'Emma Rose' });
    await expect(bobsPerson()).resolves.toMatchObject({ name: 'Emma Rose' });

    await personService.update(bobAuth, mapping!.personGroupId, { name: 'Cousin Emma' });
    await personService.update(aliceAuth, emma.personGroupId, { name: 'Emma R.', birthDate: '2015-04-01' });
    await expect(bobsPerson()).resolves.toMatchObject({ name: 'Cousin Emma' });
    const updated = await bobsPerson();
    expect(String(updated?.birthDate)).toContain('2015');
  });
});

describe('PartnerLockService (FL-326)', () => {
  it('locks the copy of a locked item and flags the notice for a recipient without a PIN', async () => {
    const { ctx, base } = setup();
    const { alice, bob, source, copy } = await sharedPhoto(ctx, newEmbedding());
    await ctx.get(AssetRepository).lock([source.id], AssetLockReason.Marked, alice.id);

    const locks = BaseService.create(PartnerLockService, base);
    const input = { sourceAssetId: source.id, sourceOwnerId: alice.id, targetAssetId: copy.id, targetOwnerId: bob.id };
    await expect(locks.mirrorLockedState(input)).resolves.toBe('locked');
    await expect(ctx.get(AssetRepository).getLockReasons([copy.id])).resolves.toEqual([
      expect.objectContaining({ assetId: copy.id, reason: AssetLockReason.Marked }),
    ]);
    const metadata = await ctx.get(UserRepository).getMetadata(bob.id);
    expect(metadata.find(({ key }) => key === UserMetadataKey.PartnerLockedNotice)).toBeDefined();

    await ctx.get(AssetRepository).unlock([source.id]);
    await expect(locks.mirrorLockedState(input)).resolves.toBe('unlocked');
    await expect(ctx.get(AssetRepository).getLockReasons([copy.id])).resolves.toEqual([]);
  });
});
