import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { randomUUID } from 'node:crypto';
import { getCatalogEvidence, getCatalogTableLocks } from 'src/fork-schema/catalog.js';
import { assertICloudReferences, reconcileICloudReferences } from 'src/fork-schema/icloud-reconciliation.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as migration from 'src/fork-schema/migrations/0000000000090-ICloudSync.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

const cloud = (entries: { identity: string; definition: string }[]) =>
  entries.filter(({ identity }) => identity.startsWith('immich_fork.icloud_'));

const publicEntries = (entries: { identity: string; definition: string }[]) =>
  entries.filter(({ identity }) => identity.startsWith('public.'));

describe('fork-owned iCloud state', () => {
  let db: Kysely<DB>;
  let migrator: Migrator;
  const ownerId = randomUUID();
  const otherOwnerId = randomUUID();
  const connectionId = randomUUID();
  const assetId = randomUUID();
  const albumId = randomUUID();

  beforeAll(async () => {
    db = await getKyselyDB();
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`DROP SCHEMA IF EXISTS immich_fork CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
    await sql`CREATE SCHEMA immich_fork`.execute(db);
    await sql`CREATE TABLE public.migration_overrides (name text)`.execute(db);
    await sql`CREATE TABLE public.user (id uuid PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE public.asset (id uuid PRIMARY KEY, "ownerId" uuid NOT NULL)`.execute(db);
    await sql`CREATE TABLE public.album (id uuid PRIMARY KEY)`.execute(db);
    await sql`CREATE TABLE public.album_user ("albumId" uuid REFERENCES public.album ON DELETE CASCADE,"userId" uuid REFERENCES public.user ON DELETE CASCADE,role text,PRIMARY KEY ("albumId","userId"))`.execute(
      db,
    );
    await sql`CREATE TABLE immich_fork.orphaned_records (
      "sourceTable" text, "sourceKey" text, payload jsonb, PRIMARY KEY ("sourceTable", "sourceKey")
    )`.execute(db);
    await sql`INSERT INTO public.user VALUES (${ownerId}::uuid), (${otherOwnerId}::uuid)`.execute(db);
    await sql`INSERT INTO public.asset VALUES (${assetId}::uuid, ${ownerId}::uuid)`.execute(db);
    await sql`INSERT INTO public.album VALUES (${albumId}::uuid)`.execute(db);
    await sql`INSERT INTO public.album_user VALUES (${albumId}::uuid,${ownerId}::uuid,'owner')`.execute(db);
    migrator = new Migrator({
      db,
      migrationTableSchema: 'immich_fork',
      provider: { getMigrations: () => Promise.resolve({ '0000000000090-ICloudSync': migration }) },
    });
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('migrates once, keeps distinct source renditions, validates ownership and digest/byte bounds, and rolls back cleanly', async () => {
    const before = await getCatalogEvidence(db, { includeForkLedger: false });
    const result1 = await migrator.migrateToLatest();
    expect(result1.error).toBeUndefined();
    await sql`
      INSERT INTO immich_fork.icloud_connection (id, "ownerId", label)
      VALUES (${connectionId}::uuid, ${ownerId}::uuid, 'Photos')
    `.execute(db);
    const insertResource = (sourceAssetId: string, sha1 = Buffer.alloc(20)) =>
      sql`
      INSERT INTO immich_fork.icloud_resource
        ("connectionId", "ownerId", "libraryKey", library, "sourceAssetId", "recordId", "resourceKey", role,
         fingerprint, source, "expectedSize", "assetId", sha1)
      VALUES (${connectionId}::uuid, ${ownerId}::uuid, 'private', '{}', ${sourceAssetId}, 'record', 'adjusted',
        'adjusted', 'version1', '{}', 100, ${assetId}::uuid, ${sha1})
    `.execute(db);
    await insertResource('photo1');
    await insertResource('photo2');
    await expect(insertResource('photo1')).rejects.toMatchObject({ code: '23505' });
    await expect(insertResource('bad-digest', Buffer.alloc(19))).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`
      UPDATE immich_fork.icloud_resource SET "ownerId" = ${otherOwnerId}::uuid
    `.execute(db),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(sql`UPDATE immich_fork.icloud_resource SET "expectedSize" = -1`.execute(db)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      sql`UPDATE immich_fork.icloud_resource SET "reservedBytes" = 9007199254740992`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`UPDATE immich_fork.icloud_resource SET "leaseToken" = gen_random_uuid()`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    const result2 = await migrator.migrateToLatest();
    expect(result2.results).toEqual([]);
    const result3 = await sql`SELECT * FROM immich_fork.icloud_resource`.execute(db);
    expect(result3.rows).toHaveLength(2);

    const actual = await getCatalogEvidence(db, { includeForkLedger: false });
    for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
      expect(cloud(actual[kind])).toEqual(cloud(manifest[kind]));
    }
    expect(getCatalogTableLocks(manifest).filter((table) => table.startsWith('immich_fork.icloud_'))).toHaveLength(7);
    const crossSchema = await sql`
      SELECT 1 FROM pg_constraint constraint_record
      JOIN pg_class source ON source.oid = constraint_record.conrelid
      JOIN pg_class target ON target.oid = constraint_record.confrelid
      WHERE constraint_record.contype = 'f' AND source.relname LIKE 'icloud_%'
        AND source.relnamespace <> target.relnamespace
    `.execute(db);
    expect(crossSchema.rows).toEqual([]);
    const result4 = await migrator.migrateDown();
    expect(result4.error).toBeUndefined();
    const after = await getCatalogEvidence(db, { includeForkLedger: false });
    expect(after.tables.filter(({ identity }) => identity.startsWith('immich_fork.icloud_'))).toEqual([]);
    for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
      expect(publicEntries(after[kind])).toEqual(publicEntries(before[kind]));
    }
  });

  it('preserves source records and files, clears missing/foreign mappings, disables removed owners, and leaves other owners intact', async () => {
    const result5 = await migrator.migrateToLatest();
    expect(result5.error).toBeUndefined();
    const otherConnection = randomUUID();
    await sql`
      INSERT INTO immich_fork.icloud_connection (id, "ownerId", label, state, "encryptedSession", "nextRunAt")
      VALUES (${connectionId}::uuid, ${ownerId}::uuid, 'Removed', 'active', 'encrypted', now()),
        (${otherConnection}::uuid, ${otherOwnerId}::uuid, 'Keep', 'active', 'other-encrypted', now())
    `.execute(db);
    await sql`
      INSERT INTO immich_fork.icloud_resource
        ("connectionId", "ownerId", "libraryKey", library, "sourceAssetId", "recordId", "resourceKey", role,
         fingerprint, source, "expectedSize", "assetId", path, "pendingJobs", "leaseToken", "leaseExpiresAt")
      VALUES (${connectionId}::uuid, ${ownerId}::uuid, 'private', '{}', 'photo', 'record', 'adjusted',
        'adjusted', 'v1', '{}', 100, ${assetId}::uuid, '/preserved/source.jpg', '[{"name":"pending"}]', gen_random_uuid(), now())
    `.execute(db);
    await sql`
      INSERT INTO immich_fork.icloud_record ("connectionId", "libraryKey", "recordId", "recordType", fields)
      VALUES (${connectionId}::uuid, 'private', 'record', 'CPLAsset', '{"preserved":true}')
    `.execute(db);
    await sql`
      INSERT INTO immich_fork.icloud_album ("connectionId", "libraryKey", "sourceId", name, "albumId")
      VALUES (${connectionId}::uuid, 'private', 'album', 'Vacation', ${albumId}::uuid)
    `.execute(db);
    await sql`
      INSERT INTO immich_fork.icloud_membership
        ("connectionId", "libraryKey", "sourceAlbumId", "sourceAssetId", "albumId", "assetId", "addedBySync", "snapshotId")
      VALUES (${connectionId}::uuid, 'private', 'album', 'photo', ${albumId}::uuid, ${assetId}::uuid, true, gen_random_uuid())
    `.execute(db);
    await assertICloudReferences(db);
    await sql`DELETE FROM public.user WHERE id = ${ownerId}::uuid`.execute(db);
    // Reused foreign-owner UUIDs must not be accepted as a valid mapping.
    await sql`UPDATE public.asset SET "ownerId" = ${otherOwnerId}::uuid`.execute(db);
    await sql`DELETE FROM public.album WHERE id = ${albumId}::uuid`.execute(db);
    await expect(assertICloudReferences(db)).rejects.toThrow('unresolved iCloud references');
    await expect(db.transaction().execute(reconcileICloudReferences)).resolves.toBe(3);
    await assertICloudReferences(db);
    const result6 =
      await sql`SELECT state, "encryptedSession", "lastError", "nextRunAt" FROM immich_fork.icloud_connection WHERE id = ${connectionId}::uuid`.execute(
        db,
      );
    expect(result6.rows[0]).toEqual({
      state: 'paused',
      encryptedSession: null,
      lastError: 'owner_removed',
      nextRunAt: null,
    });
    const result7 =
      await sql`SELECT state, "encryptedSession" FROM immich_fork.icloud_connection WHERE id = ${otherConnection}::uuid`.execute(
        db,
      );
    expect(result7.rows[0]).toEqual({ state: 'active', encryptedSession: 'other-encrypted' });
    const result8 =
      await sql`SELECT "assetId", path, status, "pendingJobs", "leaseToken" FROM immich_fork.icloud_resource`.execute(
        db,
      );
    expect(result8.rows[0]).toEqual({
      assetId: null,
      path: '/preserved/source.jpg',
      status: 'removed',
      pendingJobs: [],
      leaseToken: null,
    });
    const result9 = await sql`SELECT "albumId", name FROM immich_fork.icloud_album`.execute(db);
    expect(result9.rows[0]).toEqual({
      albumId: null,
      name: 'Vacation',
    });
    const result10 =
      await sql`SELECT "assetId", "albumId", "addedBySync", "sourcePresent" FROM immich_fork.icloud_membership`.execute(
        db,
      );
    expect(result10.rows[0]).toEqual({ assetId: null, albumId: null, addedBySync: false, sourcePresent: true });
    const result11 = await sql`SELECT fields FROM immich_fork.icloud_record`.execute(db);
    expect(result11.rows[0]).toEqual({
      fields: { preserved: true },
    });
    const result12 = await sql`SELECT * FROM immich_fork.orphaned_records`.execute(db);
    expect(result12.rows).toHaveLength(3);
    await expect(db.transaction().execute(reconcileICloudReferences)).resolves.toBe(0);
    const result13 = await sql`SELECT * FROM immich_fork.orphaned_records`.execute(db);
    expect(result13.rows).toHaveLength(3);
    await sql`DELETE FROM immich_fork.icloud_connection WHERE id = ${connectionId}::uuid`.execute(db);
    for (const table of ['icloud_resource', 'icloud_record', 'icloud_album', 'icloud_membership']) {
      const result14 = await sql.raw(`SELECT * FROM immich_fork.${table}`).execute(db);
      expect(result14.rows).toEqual([]);
    }
  });
  it.each(['deleted', 'transferred'])(
    'suppresses an album %s while official Immich owns the database',
    async (change) => {
      const connection = randomUUID(),
        album = randomUUID(),
        recipient = randomUUID();
      await sql`INSERT INTO public.user VALUES(${recipient}::uuid)`.execute(db);
      await sql`INSERT INTO public.album VALUES(${album}::uuid)`.execute(db);
      await sql`INSERT INTO public.album_user VALUES(${album}::uuid,${otherOwnerId}::uuid,'owner')`.execute(db);
      await sql`INSERT INTO immich_fork.icloud_connection(id,"ownerId",label) VALUES(${connection}::uuid,${otherOwnerId}::uuid,'Photos')`.execute(
        db,
      );
      await sql`INSERT INTO immich_fork.icloud_album("connectionId","libraryKey","sourceId",name,"albumId",source)
      VALUES(${connection}::uuid,'private','removed','Keep source name',${album}::uuid,'{"_sync":{"appliedName":"baseline"},"sourceMetadata":"keep"}')`.execute(
        db,
      );
      if (change === 'deleted') {
        await sql`DELETE FROM public.album WHERE id=${album}::uuid`.execute(db);
      } else {
        await sql`UPDATE public.album_user SET role='viewer' WHERE "albumId"=${album}::uuid`.execute(db);
        await sql`INSERT INTO public.album_user VALUES(${album}::uuid,${recipient}::uuid,'owner')`.execute(db);
      }
      await db.transaction().execute(reconcileICloudReferences);
      const { rows } = await sql<{
        albumId: string | null;
        source: object;
      }>`SELECT "albumId",source FROM immich_fork.icloud_album WHERE "connectionId"=${connection}::uuid`.execute(db);
      expect(rows[0]).toEqual({
        albumId: null,
        source: { _sync: { appliedName: 'baseline', suppressed: true }, sourceMetadata: 'keep' },
      });
      await assertICloudReferences(db);
      if (change === 'transferred') {
        const { rows: owners } =
          await sql`SELECT "userId" FROM public.album_user WHERE "albumId"=${album}::uuid AND role='owner'`.execute(db);
        expect(owners).toEqual([{ userId: recipient }]);
      }
    },
  );
});
