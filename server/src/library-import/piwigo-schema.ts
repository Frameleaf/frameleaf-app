import fixture from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { mysqlSchemaFingerprint } from 'src/library-import/mysql-schema.js';

/** Schema admission only; source identity, consistent snapshots, inventory, originals and privacy need separate evidence. */
export const admitPiwigoSchema = (input: {
  schema: unknown;
  prefix: string;
  version: string;
  databaseVersion: string;
}): string => {
  if (input.version !== fixture.source.version) throw new Error('Piwigo source refused: PIWIGO_VERSION_UNQUALIFIED');
  if (input.databaseVersion !== fixture.runtime.databaseVersion)
    throw new Error('Piwigo source refused: PIWIGO_ENGINE_UNQUALIFIED');
  try {
    const fingerprint = mysqlSchemaFingerprint(input.schema, input.prefix);
    if (fingerprint === fixture.schemaSha256) return fingerprint;
  } catch {
    // Native metadata or namespace differences must never become a best-effort conversion.
  }
  throw new Error('Piwigo source refused: PIWIGO_SCHEMA_UNQUALIFIED');
};
