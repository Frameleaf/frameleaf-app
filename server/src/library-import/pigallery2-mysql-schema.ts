import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-mysql84.json' with { type: 'json' };
import { mysqlSchemaFingerprint } from 'src/library-import/mysql-schema.js';

/** Schema admission only; source fencing, complete inventory, ownership and privacy require separate evidence. */
export const admitPigallery2MysqlSchema = (input: {
  schema: unknown;
  version: string;
  databaseVersion: string;
  structureVersion: unknown;
}): string => {
  if (input.version !== fixture.source.version)
    throw new Error('PiGallery2 source refused: PIGALLERY2_VERSION_UNQUALIFIED');
  if (input.databaseVersion !== fixture.runtime.databaseVersion)
    throw new Error('PiGallery2 source refused: PIGALLERY2_ENGINE_UNQUALIFIED');
  if (input.structureVersion !== fixture.runtime.dataStructureVersion)
    throw new Error('PiGallery2 source refused: PIGALLERY2_STRUCTURE_VERSION_UNQUALIFIED');
  try {
    const fingerprint = mysqlSchemaFingerprint(input.schema, '');
    if (fingerprint === fixture.schemaSha256) return fingerprint;
  } catch {
    // Complete native metadata must match; unknown schemas never select a best-effort conversion.
  }
  throw new Error('PiGallery2 source refused: PIGALLERY2_SCHEMA_UNQUALIFIED');
};
