import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { frozenSource } from 'src/immich-import/adapters.js';
import { assertImmichImportActivated } from 'src/immich-import/state.js';
import { PostgresImportFixture } from 'test/medium/specs/immich-import/postgres-transport.fixture.js';

// FL-995. Real PostgreSQL on both sides: a 3.2 library with Noodle Gallery's own tables on top, read through
// the read-only source role, into a migrated Frameleaf database.
describe('offline import of a Noodle Gallery library', () => {
  let fixture: PostgresImportFixture | undefined;
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  }, 30_000);

  const ids = {
    readerAsset: randomUUID(),
    human: randomUUID(),
    pet: randomUUID(),
    humanFace: randomUUID(),
    petFace: randomUUID(),
    petFaceElsewhere: randomUUID(),
    family: randomUUID(),
    readers: randomUUID(),
    ada: randomUUID(),
    hiddenPerson: randomUUID(),
    unnamedPerson: randomUUID(),
    spacePet: randomUUID(),
  };

  const start = async () => {
    const f = (fixture = new PostgresImportFixture('3.2.4'));
    await f.initialize();
    const reader = Buffer.from('reader original');
    for (const root of ['source', 'target'] as const) {
      await writeFile(f.file('reader.jpg', root), reader);
    }
    await f.mutateSource(async (db) => {
      await db.query(
        await readFile(
          new URL('../../../../src/immich-import/fixtures/structure/gallery-5.11.1.sql', import.meta.url),
          {
            encoding: 'utf8',
          },
        ),
      );
      await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${f.role}"`);
      await db.query(
        `INSERT INTO public.asset(id,"ownerId",type,"originalPath","originalFileName",checksum,"checksumAlgorithm",
          "fileCreatedAt","fileModifiedAt","localDateTime")
        VALUES ($1,$2,'IMAGE',$3,'reader.jpg',$4,'sha1','2026-02-01','2026-02-01','2026-02-01')`,
        [ids.readerAsset, f.reader, f.file('reader.jpg'), createHash('sha1').update(reader).digest()],
      );
      await db.query('INSERT INTO public.person_group(id,"clusterGroupId") VALUES ($1,$3),($2,$3)', [
        ids.human,
        ids.pet,
        f.group,
      ]);
      // Both accounts name the same person; only the owner keeps the dog.
      await db.query(
        `INSERT INTO public.person("ownerId","personGroupId",name,"birthDate","isFavorite")
        VALUES ($1,$3,'Ada',NULL,false),($2,$3,'Grandma',NULL,false),($1,$4,'Rex','2020-05-01',true)`,
        [f.owner, f.reader, ids.human, ids.pet],
      );
      await db.query(
        `INSERT INTO public.asset_face(id,"assetId","personGroupId","imageWidth","imageHeight",
          "boundingBoxX1","boundingBoxY1","boundingBoxX2","boundingBoxY2")
        VALUES ($1,$4,$6,4000,3000,10,20,110,120),($2,$5,$7,4000,3000,1,2,3,4),($3,$4,$7,4000,3000,5,6,7,8)`,
        [ids.humanFace, ids.petFace, ids.petFaceElsewhere, ids.readerAsset, f.asset, ids.human, ids.pet],
      );
      await db.query(`INSERT INTO public.person_pet("personGroupId",species) VALUES ($1,'Dog')`, [ids.pet]);

      await db.query(
        `INSERT INTO public.shared_space(id,name,description,"createdById","createdAt")
        VALUES ($1,'Family','Everyone',$3,'2026-03-01T00:00:00Z'),($2,'Readers',NULL,$4,'2026-03-02T00:00:00Z')`,
        [ids.family, ids.readers, f.owner, f.reader],
      );
      // 'Readers' has two owners (its creator stays the owner) and 'Family' an editor.
      await db.query(
        `INSERT INTO public.shared_space_member("spaceId","userId",role)
        VALUES ($1,$3,'owner'),($1,$4,'editor'),($2,$4,'owner'),($2,$3,'owner')`,
        [ids.family, ids.readers, f.owner, f.reader],
      );
      await db.query(
        `INSERT INTO public.shared_space_asset("spaceId","assetId","addedAt")
        VALUES ($1,$2,'2026-03-03T00:00:00Z'),($1,$3,'2026-03-04T00:00:00Z')`,
        [ids.family, f.asset, ids.readerAsset],
      );
      await db.query(
        `INSERT INTO public.shared_space_person(id,"spaceId",name,"isHidden",type)
        VALUES ($1,$5,'Ada',false,'person'),($2,$5,'Hidden',true,'person'),($3,$5,'',false,'person'),($4,$5,'Rex',false,'pet')`,
        [ids.ada, ids.hiddenPerson, ids.unnamedPerson, ids.spacePet, ids.family],
      );
      await db.query(
        `INSERT INTO public.shared_space_person_face("personId","assetFaceId") VALUES ($1,$4),($2,$4),($3,$4),($5,$6)`,
        [ids.ada, ids.hiddenPerson, ids.unnamedPerson, ids.humanFace, ids.spacePet, ids.petFace],
      );
      // The owner's own heart is asset."isFavorite"; the other two are hearts on somebody else's photo.
      await db.query('INSERT INTO public.asset_favorite("userId","assetId") VALUES ($1,$3),($2,$3),($1,$4)', [
        f.owner,
        f.reader,
        f.asset,
        ids.readerAsset,
      ]);
      await db.query(`INSERT INTO public.user_group(name,"createdById") VALUES ('Cousins',$1)`, [f.owner]);
      await db.query(
        `INSERT INTO public.gallery_migrations(name,"timestamp") VALUES ('1798700000000-AddPersonPetTable','x')`,
      );
    });
    return f;
  };

  it('keeps Spaces, roles, linked people, other people’s favourites and pets, and reports the rest', async () => {
    const f = await start();
    // Gallery reports its own release; the Immich base comes from the migration ledger.
    const config = { ...f.config, version: '5.11.1' };
    const importer = f.importer(config);
    const report = await importer.preflight();
    expect(report).toMatchObject({ sourceKind: 'gallery', notImported: ['user groups'], status: 'fresh' });
    expect(importer.source.fixture.commit).toBe(frozenSource('3.2.4').commit);
    // FL-1742: what the import will carry, counted through the reads themselves. 'Readers' has two members and
    // 'Family' two; Ada is the one named, visible person; two hearts sit on somebody else's photo; Rex is the pet.
    const counts = { spaces: 2, members: 2, memberships: 4, spacePhotos: 2, people: 1, favourites: 2, pets: 1 };
    expect(report.gallery).toEqual(counts);
    // Manager's review asks the running source the same questions (manager/src/gallery-preview.ts) and must
    // get the same answers. Its statement is read here without the session settings, through the read-only role.
    const manager: {
      readGalleryPreview: (sql: (statement: string) => Promise<string>) => Promise<Record<string, unknown>>;
    } = await import(new URL('../../../../../manager/src/gallery-preview.ts', import.meta.url).href);
    const preview = await manager.readGalleryPreview(async (statement) => {
      const [row] = await importer.source.db.query(statement.replace(/^(?:SET [^;]+;\n)+/u, '').replace(/;$/u, ''));
      return JSON.stringify(Object.values(row)[0]);
    });
    expect(preview).toEqual({
      readable: true,
      counts,
      spaces: [
        { name: 'Family', members: 2, photos: 2 },
        { name: 'Readers', members: 2, photos: 0 },
      ],
      notImported: ['user groups'],
    });
    // Nothing is written to the Gallery database: its tables hold what they held before either look.
    expect(
      await importer.source.db.query(`SELECT (SELECT count(*) FROM public.shared_space)::int AS spaces,
        (SELECT count(*) FROM public.shared_space_member)::int AS members,
        (SELECT count(*) FROM public.shared_space_asset)::int AS photos,
        (SELECT count(*) FROM public.asset_favorite)::int AS favourites,
        (SELECT count(*) FROM public.person_pet)::int AS pets,
        (SELECT count(*) FROM public.shared_space_person)::int AS people`),
    ).toEqual([{ spaces: 2, members: 4, photos: 2, favourites: 3, pets: 1, people: 4 }]);
    // The importer's source role cannot write at all.
    await expect(importer.source.db.query(`UPDATE public.shared_space SET name = name`)).rejects.toThrow();

    await importer.run();
    // A resumed run repeats the Gallery step without doubling anything.
    await f.importer(config).run(true);
    await f.importer(config).verify(async () => {
      await f.destination.db.query('UPDATE public.frameleaf_immich_import_work SET dispatched_at=now()');
    });
    await expect(assertImmichImportActivated(f.destination.db)).resolves.toBeUndefined();
    // The source is read through a read-only role and transaction; its content fingerprint is unchanged.
    expect(await f.importer(config).source.preflight()).toBe(report.fingerprint);

    const query = (sql: string, parameters?: unknown[]) => f.destination.db.query(sql, parameters);
    // The owner's photo was in Gallery's Locked folder, so the Space cover is the photo that may be shown.
    expect(
      await query(
        `SELECT a.id,"albumName",description,"albumThumbnailAssetId",
          EXISTS (SELECT 1 FROM public.album_closure c WHERE c.id_ancestor=a.id AND c.id_descendant=a.id) AS closed
        FROM public.album a WHERE kind='space' ORDER BY "albumName"`,
      ),
    ).toEqual([
      {
        id: ids.family,
        albumName: 'Family',
        description: 'Everyone',
        albumThumbnailAssetId: ids.readerAsset,
        closed: true,
      },
      { id: ids.readers, albumName: 'Readers', description: null, albumThumbnailAssetId: null, closed: true },
    ]);
    expect(await query(`SELECT 1 FROM public.asset_lock WHERE "assetId"=$1`, [f.asset])).toHaveLength(1);
    const members = await query(
      `SELECT "albumId","userId",role::text FROM public.album_user WHERE "albumId" IN ($1,$2)`,
      [ids.family, ids.readers],
    );
    expect(members).toHaveLength(4);
    expect(members).toEqual(
      expect.arrayContaining([
        { albumId: ids.family, userId: f.owner, role: 'owner' },
        { albumId: ids.family, userId: f.reader, role: 'editor' },
        { albumId: ids.readers, userId: f.reader, role: 'owner' },
        { albumId: ids.readers, userId: f.owner, role: 'editor' },
      ]),
    );
    expect(
      await query(`SELECT "assetId" FROM public.album_asset WHERE "albumId"=$1 ORDER BY "createdAt"`, [ids.family]),
    ).toEqual([{ assetId: f.asset }, { assetId: ids.readerAsset }]);
    // The fixture's ordinary shared album is still an album.
    expect(await query('SELECT kind FROM public.album WHERE id=$1', [f.album])).toEqual([{ kind: 'album' }]);

    // One link: the named, visible person, under the member whose own name for them matches the Space's.
    expect(
      await query(
        'SELECT "albumId","personOwnerId","personGroupId",name,"coverAssetId" FROM public.shared_space_person',
      ),
    ).toEqual([
      {
        albumId: ids.family,
        personOwnerId: f.owner,
        personGroupId: ids.human,
        name: 'Ada',
        coverAssetId: ids.readerAsset,
      },
    ]);

    expect(await query('SELECT "userId","assetId" FROM public.asset_favorite ORDER BY "assetId"')).toEqual(
      [
        { userId: f.reader, assetId: f.asset },
        { userId: f.owner, assetId: ids.readerAsset },
      ].toSorted((a, b) => a.assetId.localeCompare(b.assetId)),
    );
    expect(await query('SELECT "isFavorite" FROM public.asset WHERE id=$1', [f.asset])).toEqual([{ isFavorite: true }]);

    // The dog is a pet with a sighting on its owner's photo only, and no longer shows among the people.
    const pets = await query(
      `SELECT id,"ownerId",name,species,"birthDate"::text AS "birthDate","isFavorite","featuredAssetId" FROM public.pet`,
    );
    expect(pets).toEqual([
      expect.objectContaining({
        ownerId: f.owner,
        name: 'Rex',
        species: 'dog',
        birthDate: '2020-05-01',
        isFavorite: true,
        // its only photo is Locked
        featuredAssetId: null,
      }),
    ]);
    expect(
      await query(
        `SELECT "petId","assetId",state,source,"boundingBoxX1","boundingBoxY2","imageWidth" FROM public.pet_observation`,
      ),
    ).toEqual([
      {
        petId: pets[0].id,
        assetId: f.asset,
        state: 'confirmed',
        source: 'review',
        boundingBoxX1: 1,
        boundingBoxY2: 4,
        imageWidth: 4000,
      },
    ]);
    expect(await query('SELECT "ownerId",name,"isHidden" FROM public.person ORDER BY name')).toEqual([
      { ownerId: f.owner, name: 'Ada', isHidden: false },
      { ownerId: f.reader, name: 'Grandma', isHidden: false },
      { ownerId: f.owner, name: 'Rex', isHidden: true },
    ]);

    const notices = await query(
      `SELECT "userId",data FROM public.notification WHERE data->>'kind'='noodle-gallery-not-imported'`,
    );
    expect(notices).toEqual([
      { userId: f.owner, data: { kind: 'noodle-gallery-not-imported', items: ['user groups'] } },
    ]);
  }, 180_000);

  it('refuses activation when a Space photo did not arrive', async () => {
    const f = await start();
    const config = { ...f.config, version: '5.11.1' };
    await f.importer(config).run();
    await f.destination.db.query('DELETE FROM public.album_asset WHERE "albumId"=$1 AND "assetId"=$2', [
      ids.family,
      ids.readerAsset,
    ]);
    await expect(f.importer(config).verify(() => Promise.resolve())).rejects.toThrow(
      'DESTINATION_CARDINALITY_MISMATCH',
    );
  }, 180_000);
});
