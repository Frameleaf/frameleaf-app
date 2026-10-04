import { schemaDiff, schemaFromCode, schemaFromDatabase } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { writeFile } from 'node:fs/promises';
import { getCatalogEvidence, serializeCatalogManifest } from 'src/fork-schema/catalog.js';
import { DB } from 'src/schema/index.js';
import * as migration from 'src/schema/migrations/2100000000721-TagSyncEvents.js';
import * as petMigration from 'src/schema/migrations/2100000000722-PetSyncEvents.js';
import * as spaceMigration from 'src/schema/migrations/2100000000723-SharedSpaceDeliveryOrder.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});
it('round-trips the reserved migration and matches the registered schema', async () => {
  const before = await getCatalogEvidence(db);
  await spaceMigration.down(db);
  await petMigration.down(db);
  await migration.down(db);
  expect(
    (await getCatalogEvidence(db)).tables.some(({ identity }) => identity === 'public.session_tag_sync_state'),
  ).toBe(false);
  await migration.up(db);
  await petMigration.up(db);
  await spaceMigration.up(db);
  const after = await getCatalogEvidence(db);
  expect(after).toEqual(before);
  if (process.env.FL231_CATALOG_OUT) await writeFile(process.env.FL231_CATALOG_OUT, serializeCatalogManifest(after));
  const {
    rows: [{ name }],
  } = await sql<{ name: string }>`select current_database() as name`.execute(db);
  const source = schemaFromCode({
    overrides: true,
    namingStrategy: 'default',
    uuidFunction: (version) => (version === 7 ? 'immich_uuid_v7()' : 'uuid_generate_v4()'),
  });
  const target = await schemaFromDatabase({
    connection: {
      connectionType: 'url',
      url: process.env.IMMICH_TEST_POSTGRES_URL!.replace('/mich', () => `/${name}`),
    },
  });
  const drift = schemaDiff(source, target, {
    tables: { ignoreExtra: true },
    constraints: { ignoreExtra: false },
    indexes: { ignoreExtra: true },
    triggers: { ignoreExtra: true },
    columns: { ignoreExtra: true },
    functions: { ignoreExtra: false },
    parameters: { ignoreExtra: true },
    extensions: { ignoreExtra: true },
  });
  console.log('FL231 registered schema drift:', drift.asSql());
  if (process.env.FL231_DRIFT_OUT) await writeFile(process.env.FL231_DRIFT_OUT, JSON.stringify(drift.items, null, 2));
  expect(drift.items).toEqual([]);
});
