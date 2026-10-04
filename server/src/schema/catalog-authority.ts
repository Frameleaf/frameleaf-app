import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DatabaseSchema } from '@frameleaf/sql-tools';

export const CATALOG_HELPER_SOURCES = [
  'src/schema/frameleaf-feature-schema.ts',
  'src/schema/shared-services-schema.ts',
  'src/queue/schema.ts',
  'src/immich-import/state.ts',
] as const;

export const CATALOG_FIXED_SOURCES = [
  ...CATALOG_HELPER_SOURCES,
  'src/schema/index.ts',
  'src/schema/functions.ts',
  'src/schema/enums.ts',
  'src/enum.ts',
] as const;

export type CatalogProvenance = {
  sourceCommit: string;
  sourceHashes: Record<string, string>;
  baselineSha256: string;
};

const uniqueNames = (objects: { name: string }[], label: string) => {
  if (new Set(objects.map(({ name }) => name)).size !== objects.length) {
    throw new Error(`Canonical catalog contains duplicate ${label}`);
  }
};

/** Never accept a lossy reader output as the application's desired-schema authority. */
export const validateFrameleafCatalog = (catalog: DatabaseSchema): DatabaseSchema => {
  if (catalog.schemaName !== 'public' || catalog.tables.length === 0 || !Array.isArray(catalog.sequences)) {
    throw new Error('Canonical catalog must describe public tables and sequences');
  }
  if (catalog.warnings.length > 0) {
    throw new Error(`Canonical catalog has unresolved reader warnings: ${catalog.warnings.join('; ')}`);
  }
  uniqueNames(catalog.tables, 'tables');
  uniqueNames(catalog.functions, 'functions');
  uniqueNames(catalog.sequences, 'sequences');
  for (const table of catalog.tables) {
    uniqueNames(table.columns, `${table.name} columns`);
    uniqueNames(table.constraints, `${table.name} constraints`);
    uniqueNames(table.indexes, `${table.name} indexes`);
    uniqueNames(table.triggers, `${table.name} triggers`);
    for (const object of [...table.constraints, ...table.indexes, ...table.triggers]) {
      if (!object.definition)
        throw new Error(`Canonical catalog lacks exact definition for ${table.name}.${object.name}`);
    }
  }
  // These sentinels catch the previously omitted feature, queue, import, shared-service and album-source catalogs.
  for (const name of [
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
  ]) {
    if (catalog.tables.every((table) => table.name !== name)) throw new Error(`Canonical catalog is missing ${name}`);
  }
  for (const [tableName, columnName] of [
    ['job_run_item', 'selectionId'],
    ['job_queue', 'manifestFilling'],
  ]) {
    if (!catalog.tables.find(({ name }) => name === tableName)?.columns.some(({ name }) => name === columnName)) {
      throw new Error(`Canonical catalog is missing ${tableName}.${columnName}`);
    }
  }
  return structuredClone(catalog);
};

/** Hosted source guard: editing helper DDL requires reconciling the desired catalog and an explicit migration. */
export const verifyCatalogSources = async (serverRoot: string, provenance: CatalogProvenance): Promise<void> => {
  if (!/^[a-f\d]{40}$/u.test(provenance.sourceCommit) || !/^[a-f\d]{64}$/u.test(provenance.baselineSha256)) {
    throw new Error('Canonical catalog must record its immutable source commit and baseline digest');
  }
  const actualSources = await collectCatalogSourceHashes(serverRoot);
  if (Object.keys(actualSources).sort().join('\n') !== Object.keys(provenance.sourceHashes).sort().join('\n')) {
    throw new Error('Canonical catalog source inventory changed without reconciliation');
  }
  for (const [name, actual] of Object.entries(actualSources)) {
    const expected = provenance.sourceHashes[name];
    if (!expected || !/^[a-f\d]{64}$/u.test(expected))
      throw new Error(`Canonical catalog lacks source digest: ${name}`);
    if (actual !== expected) {
      throw new Error(`Canonical helper changed without catalog reconciliation: ${name}`);
    }
  }
};

/** Include model additions/deletions, not just edits to the raw helper files. */
export const collectCatalogSourceHashes = async (serverRoot: string): Promise<Record<string, string>> => {
  const names: string[] = [...CATALOG_FIXED_SOURCES];
  for (const entry of await readdir(resolve(serverRoot, 'src/schema/tables'))) {
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) names.push(`src/schema/tables/${entry}`);
  }
  const hashes: Record<string, string> = {};
  for (const name of names.sort())
    hashes[name] = createHash('sha256')
      .update(await readFile(resolve(serverRoot, name)))
      .digest('hex');
  return hashes;
};
