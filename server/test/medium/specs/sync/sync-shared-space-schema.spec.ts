import { schemaDiff, schemaFromDatabase } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { writeFile } from 'node:fs/promises';
import { getFrameleafSchema } from 'src/schema/frameleaf-schema.js';
import { DB } from 'src/schema/index.js';
import { canonicalDatabaseUrl, expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});
it('installs canonical sync objects and matches the registered schema', async () => {
  await expectCanonicalTables(db, ['session_tag_sync_state']);
  const {
    rows: [{ name }],
  } = await sql<{ name: string }>`select current_database() as name`.execute(db);
  const order = await sql<{
    present: boolean;
  }>`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='session_tag_sync_state' AND column_name='deliveryOrder') AS present`.execute(
    db,
  );
  expect(order.rows[0].present).toBe(true);
  const source = getFrameleafSchema();
  const target = await schemaFromDatabase({
    connection: {
      connectionType: 'url',
      url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, name),
    },
  });
  if (process.env.FL231_SPACE_CATALOG_OUT)
    await writeFile(process.env.FL231_SPACE_CATALOG_OUT, JSON.stringify(target, null, 2));
  const drift = schemaDiff(source, target, {
    tables: { ignoreExtra: true },
    constraints: { ignoreExtra: true },
    indexes: { ignoreExtra: true },
    triggers: { ignoreExtra: true },
    columns: { ignoreExtra: true },
    functions: { ignoreExtra: true },
    parameters: { ignoreExtra: true },
    extensions: { ignoreExtra: true },
  });
  console.log('FL231 registered schema drift:', drift.asSql());
  if (process.env.FL231_SPACE_DRIFT_OUT)
    await writeFile(process.env.FL231_SPACE_DRIFT_OUT, JSON.stringify(drift.items, null, 2));
  expect(drift.items).toEqual([]);
});
