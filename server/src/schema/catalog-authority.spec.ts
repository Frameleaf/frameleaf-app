import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSchema } from '@frameleaf/sql-tools';
import {
  CATALOG_FIXED_SOURCES,
  CatalogProvenance,
  validateFrameleafCatalog,
  verifyCatalogSources,
} from 'src/schema/catalog-authority.js';

// Minimal parser fixture only; this is never used as a production schema or a captured PG19 catalog.
const catalog = (): DatabaseSchema => ({
  databaseName: 'fixture',
  schemaName: 'public',
  sequences: [],
  functions: [],
  enums: [],
  extensions: [],
  parameters: [],
  overrides: [],
  warnings: [],
  tables: [
    'asset',
    'user',
    'icloud_weekly_grant',
    'job',
    'job_run_item',
    'job_selection',
    'frameleaf_immich_import',
    'frameleaf_rate_limit',
    'socket_io_attachments',
    'album_source_link',
    'album_source_asset',
  ].map((name) => ({ name, columns: [], indexes: [], constraints: [], triggers: [], synchronize: true })),
});

it('refuses incomplete or lossy catalog capture instead of hiding missing helper objects', () => {
  const missing = catalog();
  missing.tables = missing.tables.filter(({ name }) => name !== 'job_run_item');
  expect(() => validateFrameleafCatalog(missing)).toThrow('missing job_run_item');
  const lossy = catalog();
  lossy.warnings.push('Unable to find type for smart_search.embedding');
  expect(() => validateFrameleafCatalog(lossy)).toThrow('unresolved reader warnings');
  const duplicate = catalog();
  duplicate.tables.push(duplicate.tables[0]);
  expect(() => validateFrameleafCatalog(duplicate)).toThrow('duplicate tables');
});

it('detects a helper DDL edit even when its desired-schema catalog was not changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'catalog-source-guard-'));
  const provenance: CatalogProvenance = {
    sourceCommit: 'a'.repeat(40),
    baselineSha256: 'b'.repeat(64),
    sourceHashes: {},
  };
  try {
    for (const name of CATALOG_FIXED_SOURCES) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), name);
      provenance.sourceHashes[name] = createHash('sha256').update(name).digest('hex');
    }
    await mkdir(join(root, 'src/schema/tables'), { recursive: true });
    await verifyCatalogSources(root, provenance);
    await writeFile(join(root, 'src/queue/schema.ts'), 'a new CHECK constraint');
    await expect(verifyCatalogSources(root, provenance)).rejects.toThrow(
      'helper changed without catalog reconciliation',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
