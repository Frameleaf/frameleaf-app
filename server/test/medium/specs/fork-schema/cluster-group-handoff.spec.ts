import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { REVERSIBLE_POST_CERTIFIED_MIGRATIONS } from 'src/fork-schema/post-certified-residue.js';
import { DB } from 'src/schema/index.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const migration = REVERSIBLE_POST_CERTIFIED_MIGRATIONS.get('1787148183729-ClusterGroups')!;

describe('shared cluster group official handoff', () => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    db = await getKyselyDB();
  });
  afterEach(async () => {
    await db.destroy();
  });

  it('preserves owner-specific people, faces, shared membership and official edits across repeated roundtrips', async () => {
    const a = await mediumFactory.userWithClusterGroup(db);
    const b = mediumFactory.userInsert({ clusterGroupId: a.clusterGroupId });
    const c = await mediumFactory.userWithClusterGroup(db);
    await db.insertInto('user').values([a, b, c]).execute();
    await db.updateTable('cluster_group').set({ name: 'Family' }).where('id', '=', a.clusterGroupId).execute();
    const group = await db
      .insertInto('person_group')
      .values({ clusterGroupId: a.clusterGroupId })
      .returningAll()
      .executeTakeFirstOrThrow();
    const removedGroup = await db
      .insertInto('person_group')
      .values({ clusterGroupId: a.clusterGroupId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('person')
      .values([
        { ownerId: a.id, personGroupId: group.id, name: 'Alice view', isFavorite: true },
        { ownerId: b.id, personGroupId: group.id, name: 'Bob view', isHidden: true },
        { ownerId: a.id, personGroupId: removedGroup.id, name: 'Remove while official' },
      ])
      .execute();
    const request = await db
      .insertInto('cluster_group_request')
      .values({ clusterGroupId: a.clusterGroupId, userId: c.id })
      .returningAll()
      .executeTakeFirstOrThrow();
    const assets = [mediumFactory.assetInsert({ ownerId: a.id }), mediumFactory.assetInsert({ ownerId: b.id })];
    await db.insertInto('asset').values(assets).execute();
    const faces = assets.map((asset) => mediumFactory.assetFaceInsert({ assetId: asset.id!, personGroupId: group.id }));
    await db.insertInto('asset_face').values(faces).execute();

    await db.transaction().execute((trx) => migration.revert(trx));
    const official = await sql<{ id: string; ownerId: string; name: string }>`
      SELECT id, "ownerId", name FROM public.person ORDER BY name
    `.execute(db);
    const alice = official.rows.find((person) => person.name === 'Alice view')!;
    const bob = official.rows.find((person) => person.name === 'Bob view')!;
    expect(alice.id).not.toBe(bob.id);
    const officialTombstones = await sql<{ personId: string; ownerId: string }>`
      SELECT "personId", "ownerId" FROM person_audit
    `.execute(db);
    expect(officialTombstones.rows).toEqual(
      expect.arrayContaining([
        { personId: group.id, ownerId: a.id },
        { personId: group.id, ownerId: b.id },
      ]),
    );
    const officialFaces = await sql<{ ownerId: string; personOwnerId: string }>`
      SELECT asset."ownerId", person."ownerId" AS "personOwnerId"
      FROM public.asset_face face JOIN public.asset asset ON asset.id = face."assetId"
      JOIN public.person person ON person.id = face."personId"
    `.execute(db);
    expect(officialFaces.rows).toHaveLength(2);
    expect(officialFaces.rows.every((row) => row.ownerId === row.personOwnerId)).toBe(true);

    await sql`UPDATE public.person SET name = 'Edited in official' WHERE id = ${alice.id}::uuid`.execute(db);
    await sql`DELETE FROM public.person WHERE name = 'Remove while official'`.execute(db);
    const officialNewPerson = randomUUID();
    await sql`INSERT INTO public.person (id, "ownerId", name) VALUES (${officialNewPerson}::uuid, ${a.id}::uuid, 'New in official')`.execute(
      db,
    );
    // An assignment changed in official must not be overwritten by the snapshot.
    await sql`UPDATE public.asset_face SET "personId" = ${officialNewPerson}::uuid WHERE id = ${faces[0]!.id}::uuid`.execute(
      db,
    );
    await db.transaction().execute((trx) => migration.apply(trx));

    expect(await db.selectFrom('person_audit').select(['personGroupId', 'ownerId']).execute()).toEqual(
      expect.arrayContaining([
        { personGroupId: alice.id, ownerId: a.id },
        { personGroupId: bob.id, ownerId: b.id },
      ]),
    );

    expect(
      await db
        .selectFrom('person')
        .select(['ownerId', 'personGroupId', 'name', 'isFavorite', 'isHidden'])
        .orderBy('name')
        .execute(),
    ).toEqual([
      expect.objectContaining({ ownerId: b.id, personGroupId: group.id, name: 'Bob view', isHidden: true }),
      expect.objectContaining({ ownerId: a.id, personGroupId: group.id, name: 'Edited in official', isFavorite: true }),
      expect.objectContaining({ ownerId: a.id, personGroupId: officialNewPerson, name: 'New in official' }),
    ]);
    expect(
      await db
        .selectFrom('asset_face')
        .select('personGroupId')
        .where('id', '=', faces[0]!.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ personGroupId: officialNewPerson });
    expect(
      await db
        .selectFrom('asset_face')
        .select('personGroupId')
        .where('id', '=', faces[1]!.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ personGroupId: group.id });
    expect(await db.selectFrom('user').select('clusterGroupId').where('id', 'in', [a.id, b.id]).execute()).toEqual([
      { clusterGroupId: a.clusterGroupId },
      { clusterGroupId: a.clusterGroupId },
    ]);
    expect(
      await db.selectFrom('cluster_group_request').selectAll().where('id', '=', request.id).executeTakeFirst(),
    ).toEqual(request);
    expect(
      await db.selectFrom('cluster_group').select('name').where('id', '=', a.clusterGroupId).executeTakeFirstOrThrow(),
    ).toEqual({ name: 'Family' });
    expect(await db.selectFrom('person_group').selectAll().where('id', '=', group.id).executeTakeFirst()).toEqual(
      group,
    );

    await db.transaction().execute((trx) => migration.revert(trx));
    await db.transaction().execute((trx) => migration.apply(trx));
    expect(
      await db.selectFrom('person').select('personGroupId').where('name', '=', 'Edited in official').executeTakeFirst(),
    ).toEqual({ personGroupId: group.id });
    expect(await db.selectFrom('person').selectAll().where('name', '=', 'Remove while official').execute()).toEqual([]);
  });

  it('handles face groups without materialized people and does not resurrect an official-deleted owner', async () => {
    const owner = await mediumFactory.userWithClusterGroup(db);
    await db.insertInto('user').values(owner).execute();
    const group = await db
      .insertInto('person_group')
      .values({ clusterGroupId: owner.clusterGroupId })
      .returningAll()
      .executeTakeFirstOrThrow();
    const asset = mediumFactory.assetInsert({ ownerId: owner.id });
    await db.insertInto('asset').values(asset).execute();
    await db
      .insertInto('asset_face')
      .values(mediumFactory.assetFaceInsert({ assetId: asset.id!, personGroupId: group.id }))
      .execute();
    await db.transaction().execute((trx) => migration.revert(trx));
    const officialPeople = await sql<{ count: number }>`SELECT count(*)::int AS count FROM person`.execute(db);
    expect(officialPeople.rows[0]!.count).toBe(1);
    await db.deleteFrom('user').where('id', '=', owner.id).execute();
    await db.transaction().execute((trx) => migration.apply(trx));
    expect(await db.selectFrom('user').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('person').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('person_group').selectAll().execute()).toEqual([]);
  });

  it("keeps a shared space's linked people through the handoff and drops a link whose person official deleted", async () => {
    const a = await mediumFactory.userWithClusterGroup(db);
    const b = mediumFactory.userInsert({ clusterGroupId: a.clusterGroupId });
    await db.insertInto('user').values([a, b]).execute();
    const kept = await db
      .insertInto('person_group')
      .values({ clusterGroupId: a.clusterGroupId })
      .returningAll()
      .executeTakeFirstOrThrow();
    const removed = await db
      .insertInto('person_group')
      .values({ clusterGroupId: a.clusterGroupId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('person')
      .values([
        { ownerId: a.id, personGroupId: kept.id, name: 'Alice view' },
        { ownerId: b.id, personGroupId: kept.id, name: 'Bob view' },
        { ownerId: a.id, personGroupId: removed.id, name: 'Remove while official' },
      ])
      .execute();
    const space = mediumFactory.albumInsert({});
    await db.insertInto('album').values(space).execute();
    await sql`
      INSERT INTO public.shared_space_person ("albumId", "personOwnerId", "personGroupId", name)
      VALUES (${space.id}::uuid, ${a.id}::uuid, ${kept.id}::uuid, 'Alice in the space'),
        (${space.id}::uuid, ${b.id}::uuid, ${kept.id}::uuid, 'Bob in the space'),
        (${space.id}::uuid, ${a.id}::uuid, ${removed.id}::uuid, 'Removed in the space')
    `.execute(db);
    const links = () =>
      sql<{ personOwnerId: string; personGroupId: string; name: string }>`
        SELECT "personOwnerId", "personGroupId", name FROM public.shared_space_person ORDER BY name
      `.execute(db);

    await db.transaction().execute((trx) => migration.revert(trx));
    // each link now names its owner's own official person
    const official = await sql<{ id: string; ownerId: string; name: string }>`
      SELECT id, "ownerId", name FROM public.person
    `.execute(db);
    const officialId = (name: string) => official.rows.find((person) => person.name === name)!.id;
    expect((await links()).rows).toEqual([
      { personOwnerId: a.id, personGroupId: officialId('Alice view'), name: 'Alice in the space' },
      { personOwnerId: b.id, personGroupId: officialId('Bob view'), name: 'Bob in the space' },
      { personOwnerId: a.id, personGroupId: officialId('Remove while official'), name: 'Removed in the space' },
    ]);

    await sql`DELETE FROM public.person WHERE name = 'Remove while official'`.execute(db);
    await db.transaction().execute((trx) => migration.apply(trx));

    expect((await links()).rows).toEqual([
      { personOwnerId: a.id, personGroupId: kept.id, name: 'Alice in the space' },
      { personOwnerId: b.id, personGroupId: kept.id, name: 'Bob in the space' },
    ]);
    const foreignKey = await sql<{ definition: string }>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname = 'shared_space_person_personGroupId_fkey'
    `.execute(db);
    expect(foreignKey.rows).toEqual([
      { definition: 'FOREIGN KEY ("personGroupId") REFERENCES person_group(id) ON UPDATE CASCADE ON DELETE CASCADE' },
    ]);
  });
});
