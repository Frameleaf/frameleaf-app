import { createPostgres, schemaFromDatabase } from '@frameleaf/sql-tools';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ConfigRepository } from '../src/repositories/config.repository.js';
import { collectCatalogSourceHashes, validateFrameleafCatalog } from '../src/schema/catalog-authority.js';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: snapshot-frameleaf-schema-catalog.ts <output.json>');
const serverRoot = resolve(import.meta.dirname, '..');
const connection = new ConfigRepository().getEnv().database.config;
const schema = validateFrameleafCatalog(
  await schemaFromDatabase({ connection, overrides: false, excludeMigrationTables: true }),
);
const sourceHashes = await collectCatalogSourceHashes(serverRoot);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: serverRoot, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['diff', 'HEAD', '--', ...Object.keys(sourceHashes)], {
  cwd: serverRoot,
  encoding: 'utf8',
});
if (dirty) throw new Error('Capture requires committed schema sources');
// Ask the same database used by the reader; do not infer the server version from the client binary.
const client = createPostgres({ connection });
let serverVersion: number;
try {
  const [row] = await client`select current_setting('server_version_num')::integer as version`;
  serverVersion = Number(row.version);
} finally {
  await client.end();
}
if (serverVersion < 190000 || serverVersion >= 200000) throw new Error('Canonical capture requires PostgreSQL 19');
await writeFile(destination, JSON.stringify(schema, null, 2) + '\n');
await writeFile(
  resolve(dirname(destination), 'frameleaf-capture-source.json'),
  JSON.stringify({ sourceCommit, sourceHashes, serverVersion }, null, 2) + '\n',
);
