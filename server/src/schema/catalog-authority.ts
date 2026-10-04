import type { DatabaseSchema } from '@frameleaf/sql-tools';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const CATALOG_HELPER_SOURCES = [
  'src/schema/frameleaf-feature-schema.ts',
  'src/schema/shared-services-schema.ts',
  'src/queue/schema.ts',
  'src/immich-import/state.ts',
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
    'frameleaf_immich_import',
    'frameleaf_rate_limit',
    'socket_io_attachments',
    'album_source_link',
    'album_source_asset',
  ]) {
    if (!catalog.tables.some((table) => table.name === name)) throw new Error(`Canonical catalog is missing ${name}`);
  }
  return structuredClone(catalog);
};

/** Hosted source guard: editing helper DDL requires reconciling the desired catalog and an explicit migration. */
export const verifyCatalogSources = async (serverRoot: string, provenance: CatalogProvenance): Promise<void> => {
  if (!/^[a-f\d]{40}$/u.test(provenance.sourceCommit) || !/^[a-f\d]{64}$/u.test(provenance.baselineSha256)) {
    throw new Error('Canonical catalog must record its immutable source commit and baseline digest');
  }
  for (const name of CATALOG_HELPER_SOURCES) {
    const expected = provenance.sourceHashes[name];
    if (!expected || !/^[a-f\d]{64}$/u.test(expected))
      throw new Error(`Canonical catalog lacks source digest: ${name}`);
    const actual = createHash('sha256')
      .update(await readFile(resolve(serverRoot, name)))
      .digest('hex');
    if (actual !== expected) {
      throw new Error(`Canonical helper changed without catalog reconciliation: ${name}`);
    }
  }
};
