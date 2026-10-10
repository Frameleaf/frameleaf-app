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
  await expectCanonicalTables(db, ['pet_audit', 'pet_observation_audit']);
  const {
    rows: [{ name }],
  } = await sql<{ name: string }>`select current_database() as name`.execute(db);
  const source = getFrameleafSchema();
  const target = await schemaFromDatabase({
    connection: {
      connectionType: 'url',
      url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, name),
    },
  });
  if (process.env.FL231_PET_CATALOG_OUT)
    await writeFile(process.env.FL231_PET_CATALOG_OUT, JSON.stringify(target, null, 2));
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
  if (process.env.FL231_PET_DRIFT_OUT)
    await writeFile(process.env.FL231_PET_DRIFT_OUT, JSON.stringify(drift.items, null, 2));
  expect(drift.items).toEqual([]);
});
