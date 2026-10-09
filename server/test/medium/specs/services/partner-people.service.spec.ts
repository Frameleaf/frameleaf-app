import { Kysely, sql } from 'kysely';
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
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
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
  it('serializes concurrent copies of one partner person without losing faces or leaving orphan people', async () => {
    const { ctx, base } = setup();
    const embedding = newEmbedding();
    const { alice, bob, emma, source, copy, box } = await sharedPhoto(ctx, embedding);
    await ctx.database
      .updateTable('person')
      .set({ birthDate: new Date('2015-04-01'), isHidden: true })
      .where('ownerId', '=', alice.id)
      .where('personGroupId', '=', emma.personGroupId)
      .execute();
    const { asset: source2 } = await ctx.newAsset({ ownerId: alice.id });
    const { asset: copy2 } = await ctx.newAsset({ ownerId: bob.id });
    const { assetFace: face2 } = await ctx.newAssetFace({
      assetId: source2.id,
      personGroupId: emma.personGroupId,
      ...box,
    });
    await ctx.database.insertInto('face_search').values({ faceId: face2.id, embedding }).execute();
    const [storedSource] = await ctx.database
      .selectFrom('face_search')
      .innerJoin('asset_face', 'asset_face.id', 'face_search.faceId')
      .select('embedding')
      .where('asset_face.assetId', '=', source.id)
      .execute();
    expect(storedSource).toBeDefined();
    const groupsBefore = await ctx.database.selectFrom('person_group').select('id').execute();
    const repository = ctx.get(PersonRepository);
    const readSource = repository.getByGroupId.bind(repository);
    let arrivals = 0;
    const { promise: bothCreating, resolve: release } = Promise.withResolvers<void>();
    // Both real source SELECTs complete after each caller has chosen creation. Only scheduling is
    // controlled: no database row, error, transaction or write is replaced.
    const schedule = vi.spyOn(repository, 'getByGroupId').mockImplementation(async (input) => {
      const person = await readSource(input);
      if (input.ownerId === alice.id && input.personGroupId === emma.personGroupId && arrivals < 2) {
        if (++arrivals === 2) release();
        await bothCreating;
      }
      return person;
    });
    const people = BaseService.create(PartnerPeopleService, base);
    let outcomes: PromiseSettledResult<number>[];
    try {
      outcomes = await Promise.allSettled([
        people.copyFaces({
          sourceAssetId: source.id,
          targetAssetId: copy.id,
          targetOwnerId: bob.id,
          partnerSharedById: alice.id,
        }),
        people.copyFaces({
          sourceAssetId: source2.id,
          targetAssetId: copy2.id,
          targetOwnerId: bob.id,
          partnerSharedById: alice.id,
        }),
      ]);
    } finally {
      release();
      schedule.mockRestore();
    }
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 1 },
    ]);
    const recipientPeople = await ctx.database.selectFrom('person').selectAll().where('ownerId', '=', bob.id).execute();
    expect(recipientPeople).toHaveLength(1);
    const groupId = recipientPeople[0].personGroupId;
    expect(
      (await sql`SELECT 1 FROM public.person_origin WHERE "ownerId" = ${bob.id}::uuid`.execute(ctx.database)).rows,
    ).toHaveLength(1);
    expect(recipientPeople[0]).toMatchObject({ name: 'Emma', birthDate: new Date('2015-04-01'), isHidden: true });
    expect(await ctx.database.selectFrom('person_group').select('id').execute()).toHaveLength(groupsBefore.length + 1);
    const faces = await ctx.database
      .selectFrom('asset_face')
      .selectAll()
      .where('assetId', 'in', [copy.id, copy2.id])
      .execute();
    expect(faces).toHaveLength(2);
    for (const face of faces) expect(face).toMatchObject({ ...box, personGroupId: groupId });
    const embeddings = await ctx.database
      .selectFrom('face_search')
      .selectAll()
      .where(
        'faceId',
        'in',
        faces.map((face) => face.id),
      )
      .execute();
    expect(embeddings).toHaveLength(2);
    for (const face of embeddings) expect(face.embedding).toEqual(storedSource.embedding);
    await expect(ctx.get(PartnerOriginRepository).getPersonMapping(bob.id, emma.personGroupId)).resolves.toMatchObject({
      ownerId: bob.id,
      personGroupId: groupId,
      sourceOwnerId: alice.id,
      sourcePersonGroupId: emma.personGroupId,
      rootOwnerId: alice.id,
      partnerSharedById: alice.id,
      following: true,
      overriddenFields: [],
    });
    await expect(repository.getPartnerPersonLink(bob.id, emma.personGroupId)).resolves.toMatchObject({
      ownerId: bob.id,
      sourcePersonGroupId: emma.personGroupId,
      personGroupId: groupId,
      kind: 'created',
      correctionId: null,
    });
  });

  it('rolls back person allocation and propagates an origin insert failure', async () => {
    const { ctx, base } = setup();
    const { alice, bob, source, copy } = await sharedPhoto(ctx, newEmbedding());
    const groupsBefore = await ctx.database.selectFrom('person_group').select('id').execute();
    await sql`CREATE FUNCTION public.partner_person_origin_failure() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN RAISE EXCEPTION USING MESSAGE = ''injected origin insert failure'', ERRCODE = ''P0001''; END;'`.execute(
      ctx.database,
    );
    try {
      await sql`CREATE TRIGGER partner_person_origin_failure BEFORE INSERT ON public.person_origin
        FOR EACH ROW EXECUTE FUNCTION public.partner_person_origin_failure()`.execute(ctx.database);
      await expect(
        BaseService.create(PartnerPeopleService, base).copyFaces({
          sourceAssetId: source.id,
          targetAssetId: copy.id,
          targetOwnerId: bob.id,
          partnerSharedById: alice.id,
        }),
      ).rejects.toMatchObject({ code: 'P0001', message: 'injected origin insert failure' });
    } finally {
      await sql`DROP TRIGGER IF EXISTS partner_person_origin_failure ON public.person_origin`.execute(ctx.database);
      await sql`DROP FUNCTION public.partner_person_origin_failure()`.execute(ctx.database);
    }
    expect(
      await ctx.database.selectFrom('person').select('personGroupId').where('ownerId', '=', bob.id).execute(),
    ).toEqual([]);
    expect(await ctx.database.selectFrom('person_group').select('id').execute()).toHaveLength(groupsBefore.length);
    expect(
      (await sql`SELECT 1 FROM public.person_origin WHERE "ownerId" = ${bob.id}::uuid`.execute(ctx.database)).rows,
    ).toEqual([]);
    expect(
      (await sql`SELECT 1 FROM public.partner_person_link WHERE "ownerId" = ${bob.id}::uuid`.execute(ctx.database))
        .rows,
    ).toEqual([]);
    expect(await ctx.database.selectFrom('asset_face').select('id').where('assetId', '=', copy.id).execute()).toEqual(
      [],
    );
  });

  it('isolates the same source person by recipient and preserves a live recipient decision', async () => {
    const { ctx, base } = setup();
    const { alice, bob, emma, source, copy } = await sharedPhoto(ctx, newEmbedding());
    const { user: carol } = await ctx.newUser();
    const { asset: carolsCopy } = await ctx.newAsset({ ownerId: carol.id });
    const people = BaseService.create(PartnerPeopleService, base);
    await Promise.all([
      people.copyFaces({
        sourceAssetId: source.id,
        targetAssetId: copy.id,
        targetOwnerId: bob.id,
        partnerSharedById: alice.id,
      }),
      people.copyFaces({
        sourceAssetId: source.id,
        targetAssetId: carolsCopy.id,
        targetOwnerId: carol.id,
        partnerSharedById: alice.id,
      }),
    ]);
    const origin = ctx.get(PartnerOriginRepository);
    const bobsMapping = await origin.getPersonMapping(bob.id, emma.personGroupId);
    const carolsMapping = await origin.getPersonMapping(carol.id, emma.personGroupId);
    expect(bobsMapping).toMatchObject({ ownerId: bob.id, sourceOwnerId: alice.id, rootOwnerId: alice.id });
    expect(carolsMapping).toMatchObject({ ownerId: carol.id, sourceOwnerId: alice.id, rootOwnerId: alice.id });
    expect(bobsMapping!.personGroupId).not.toBe(carolsMapping!.personGroupId);
    await origin.markPersonOverridden(bob.id, [bobsMapping!.personGroupId], ['name']);
    await origin.stopFollowing(alice.id, bob.id);
    await people.copyFaces({
      sourceAssetId: source.id,
      targetAssetId: copy.id,
      targetOwnerId: bob.id,
      partnerSharedById: alice.id,
    });
    await expect(origin.getPersonMapping(bob.id, emma.personGroupId)).resolves.toMatchObject({
      personGroupId: bobsMapping!.personGroupId,
      overriddenFields: ['name'],
      following: false,
    });
    await expect(origin.getPersonMapping(carol.id, emma.personGroupId)).resolves.toMatchObject({
      personGroupId: carolsMapping!.personGroupId,
      overriddenFields: [],
      following: true,
    });
    await expect(origin.getPersonMapping(alice.id, emma.personGroupId)).resolves.toBeUndefined();
  });

  it('replaces only a deleted recipient person mapping when another copy arrives', async () => {
    const { ctx, base } = setup();
    const { alice, bob, emma, source, copy } = await sharedPhoto(ctx, newEmbedding());
    const people = BaseService.create(PartnerPeopleService, base);
    const input = {
      sourceAssetId: source.id,
      targetAssetId: copy.id,
      targetOwnerId: bob.id,
      partnerSharedById: alice.id,
    };
    await people.copyFaces(input);
    const origin = ctx.get(PartnerOriginRepository);
    const oldMapping = await origin.getPersonMapping(bob.id, emma.personGroupId);
    expect(oldMapping).toBeDefined();
    await ctx.get(PersonRepository).delete([oldMapping!.personGroupId], bob.id);
    await expect(origin.getPersonMapping(bob.id, emma.personGroupId)).resolves.toBeUndefined();
    const { asset: nextCopy } = await ctx.newAsset({ ownerId: bob.id });
    await expect(people.copyFaces({ ...input, targetAssetId: nextCopy.id })).resolves.toBe(1);
    const nextMapping = await origin.getPersonMapping(bob.id, emma.personGroupId);
    expect(nextMapping).toMatchObject({
      ownerId: bob.id,
      sourcePersonGroupId: emma.personGroupId,
      rootOwnerId: alice.id,
    });
    expect(nextMapping!.personGroupId).not.toBe(oldMapping!.personGroupId);
    expect(
      await ctx.database.selectFrom('person').select('personGroupId').where('ownerId', '=', bob.id).execute(),
    ).toHaveLength(1);
    const origins =
      await sql`SELECT "personGroupId" FROM public.person_origin WHERE "ownerId" = ${bob.id}::uuid`.execute(
        ctx.database,
      );
    expect(origins.rows).toEqual([{ personGroupId: nextMapping!.personGroupId }]);
  });

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

    const groupsBeforeUndo = await ctx.database.selectFrom('person_group').select('id').execute();
    const undoOutcomes = await Promise.allSettled([
      personService.undoCorrection(auth, corrections[0].id),
      personService.undoCorrection(auth, corrections[0].id),
    ]);
    expect(undoOutcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const lostUndo = undoOutcomes.find((outcome) => outcome.status === 'rejected');
    expect(lostUndo).toBeDefined();
    expect(lostUndo!.reason.getResponse()).toMatchObject({ reason: 'already-undone' });
    expect(await ctx.database.selectFrom('person_group').select('id').execute()).toHaveLength(
      groupsBeforeUndo.length + 1,
    );
    expect(
      await ctx.database.selectFrom('person').select('personGroupId').where('ownerId', '=', bob.id).execute(),
    ).toHaveLength(2);

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
