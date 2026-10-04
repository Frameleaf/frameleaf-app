// Standalone migration tooling loads this module with native ESM, without application aliases.
// eslint-disable-next-line no-restricted-imports
import { readCatalogArtifact } from './catalog-artifacts.js';
import type { DatabaseSchema } from '@frameleaf/sql-tools';

/** The complete captured catalog is the single evolving desired-schema authority. */
export const getFrameleafSchema = (): DatabaseSchema => readCatalogArtifact('desired-schema');

/** Frozen initial catalog, also used by isolated schema fixtures. Never rebuilt from current models. */
export const getFrameleafBaselineSchema = (): DatabaseSchema => readCatalogArtifact('baseline');

/** Source-only guard used by hosted verification and the migration generation CLI. */
export const verifyFrameleafSchemaSources = async (): Promise<void> => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { verifyCatalogSources } = await import('./catalog-authority.js');
  const provenance = JSON.parse(
    await readFile(new URL('catalog/desired-schema.provenance.json', import.meta.url), 'utf8'),
  );
  await verifyCatalogSources(fileURLToPath(new URL('../../', import.meta.url)), provenance);
};
