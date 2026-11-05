import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-mysql84.json' with { type: 'json' };
import { mysqlSchemaFingerprint } from 'src/library-import/mysql-schema.js';

/**
 * Schema admission only; source fencing, complete inventory, ownership and privacy require separate evidence.
 * `bestEffort` (owner decision FL-1149) skips the version, engine, structure-version and fingerprint pins.
 */
export const admitPigallery2MysqlSchema = (
  input: {
    schema: unknown;
    version: string;
    databaseVersion: string;
    structureVersion: unknown;
  },
  options: { bestEffort?: boolean } = {},
): string => {
  const bestEffort = options.bestEffort === true;
  if (!bestEffort && input.version !== fixture.source.version)
    throw new Error('PiGallery2 source refused: PIGALLERY2_VERSION_UNQUALIFIED');
  if (!bestEffort && input.databaseVersion !== fixture.runtime.databaseVersion)
    throw new Error('PiGallery2 source refused: PIGALLERY2_ENGINE_UNQUALIFIED');
  if (!bestEffort && input.structureVersion !== fixture.runtime.dataStructureVersion)
    throw new Error('PiGallery2 source refused: PIGALLERY2_STRUCTURE_VERSION_UNQUALIFIED');
  try {
    const fingerprint = mysqlSchemaFingerprint(input.schema, '');
    if (bestEffort || fingerprint === fixture.schemaSha256) return fingerprint;
  } catch {
    // Complete native metadata must match; unknown schemas only proceed when the import is explicitly best effort.
    if (bestEffort) return '';
  }
  throw new Error('PiGallery2 source refused: PIGALLERY2_SCHEMA_UNQUALIFIED');
};
