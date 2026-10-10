import { schemaDiff } from '@frameleaf/sql-tools';
import { ImportDatabase, ImportRefused } from 'src/immich-import/types.js';
import { getFrameleafSchema } from 'src/schema/frameleaf-schema.js';
import { RawCatalog, verifyRawCatalog } from 'src/schema/raw-catalog.js';

/** Inspect the destination, never repair it or infer authority from an existing ledger. */
export const assertCanonicalDestination = async (destination: ImportDatabase): Promise<void> => {
  try {
    if (!destination.readSchema) {
      throw new Error('Destination schema reader is required');
    }
    const desired = getFrameleafSchema();
    const actual = await destination.readSchema();
    if (actual.schemaName !== 'public' || !Array.isArray(actual.sequences) || actual.warnings.length > 0) {
      throw new Error('Destination schema reader is incomplete or has warnings');
    }
    const drift = schemaDiff(desired, actual, {
      tables: { ignoreExtra: false },
      columns: { ignoreExtra: false },
      constraints: { ignoreExtra: false },
      indexes: { ignoreExtra: false },
      triggers: { ignoreExtra: false },
      functions: { ignoreExtra: false },
      enums: { ignoreExtra: false },
      parameters: { ignoreExtra: true },
      extensions: { ignoreExtra: true },
    });
    if (drift.asSql().length > 0) {
      throw new Error('Destination schema differs from canonical catalog');
    }
    const [raw] = await destination.query(`SELECT
      COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',t.relname,
        'name',c.conname,'definition',pg_get_constraintdef(c.oid)))
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'),'[]'::jsonb) AS constraints,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',t.relname,
        'name',g.tgname,'definition',pg_get_triggerdef(g.oid)))
        FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid
        JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND NOT g.tgisinternal),
        '[]'::jsonb) AS triggers`);
    if (!raw || !Array.isArray(raw.constraints) || !Array.isArray(raw.triggers)) {
      throw new Error('Destination raw catalog is incomplete');
    }
    verifyRawCatalog(desired, {
      constraints: raw.constraints as RawCatalog['constraints'],
      triggers: raw.triggers as RawCatalog['triggers'],
    });
  } catch {
    // Catalog/driver failures may expose SQL or credentials. Every uncertainty blocks admission.
    throw new ImportRefused('DESTINATION_SCHEMA_NOT_CANONICAL');
  }
};
