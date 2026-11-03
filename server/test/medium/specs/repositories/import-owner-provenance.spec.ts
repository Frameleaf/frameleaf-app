import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { type DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000003049-ImportedOwnerProvenance.js';
import { getKyselyDB } from 'test/utils.js';

it('backfills mapped and reviewed owners, preserves legacy users and refuses provenance loss on downgrade', async () => {
  const db: Kysely<DB> = await getKyselyDB();
  try {
    await down(db);
    const operation = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids)
      await sql`WITH g AS (INSERT INTO cluster_group(id) VALUES(${id}::uuid) RETURNING id)
        INSERT INTO public."user"(id,email,"clusterGroupId") SELECT id,${id + '@example.test'},id FROM g`.execute(db);
    await sql`INSERT INTO frameleaf_library_import(operation_id,binding,status,reviewed_manifest,reviewed_plan)
      VALUES(${operation}::uuid,${JSON.stringify({ operationId: operation })}::text::jsonb,'copying','{}'::jsonb,
        ${JSON.stringify({ owners: [{ sourceId: 'reviewed', destinationId: ids[1] }] })}::text::jsonb)`.execute(db);
    await sql`INSERT INTO frameleaf_library_import_mapping(operation_id,entity_kind,source_id,destination_id,record_sha256)
      VALUES(${operation}::uuid,'owner','mapped',${ids[0]}::uuid,${'a'.repeat(64)})`.execute(db);
    await up(db);
    const rows = await db.selectFrom('user').select(['id', 'importOperationId']).execute();
    expect(new Map(rows.map((row) => [row.id, row.importOperationId]))).toEqual(
      new Map([
        [ids[0], operation],
        [ids[1], operation],
        [ids[2], null],
      ]),
    );
    await sql`TRUNCATE frameleaf_library_import CASCADE`.execute(db);
    await expect(down(db)).rejects.toThrow('Imported owner provenance must be retained');
    expect(await db.selectFrom('user').select('id').where('importOperationId', '=', operation).execute()).toHaveLength(
      2,
    );
    await sql`TRUNCATE public."user" CASCADE`.execute(db);
    await down(db);
    await up(db);
  } finally {
    await db.destroy();
  }
});
