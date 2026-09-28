import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getCatalogEvidence, serializeCatalogManifest } from 'src/fork-schema/catalog.js';
import { createForkMigrationProvider } from 'src/fork-schema/migration-provider.js';
import type { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';

const url = process.env.DB_URL;
const output = process.argv[2];
if (!url || !output) {
  throw new Error('DB_URL and output path are required');
}

const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url }));
try {
  const { error } = await new Migrator({
    db,
    migrationTableSchema: 'immich_fork',
    migrationTableName: 'migrations',
    migrationLockTableName: 'migrations_lock',
    provider: createForkMigrationProvider(resolve(import.meta.dirname, '../src/fork-schema/migrations')),
  }).migrateToLatest();
  if (error) {
    throw error;
  }
  await writeFile(output, serializeCatalogManifest({ ...(await getCatalogEvidence(db)), source: 'fork-v2' }));
} finally {
  await db.destroy();
}
