import { Kysely } from 'kysely';
import { writeFile } from 'node:fs/promises';
import { getCatalogEvidence, serializeCatalogManifest } from 'src/fork-schema/catalog.js';
import type { DB } from 'src/schema/index.js';
import { getKyselyConfig } from 'src/utils/database.js';

const url = process.env.DB_URL;
const output = process.argv[2];
if (!url || !output) {
  throw new Error('DB_URL and output path are required');
}

const db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url }));
try {
  await writeFile(output, serializeCatalogManifest({ ...(await getCatalogEvidence(db)), source: 'fork-v2' }));
} finally {
  await db.destroy();
}
