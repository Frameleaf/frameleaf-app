import { Kysely, sql } from 'kysely';
// Standalone migration tooling loads helpers without application aliases.
// eslint-disable-next-line no-restricted-imports
import { LIBRARY_IMPORT_SCHEMA_SQL } from '../../library-import/state-schema.js';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw(LIBRARY_IMPORT_SCHEMA_SQL).execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    LOCK TABLE public.frameleaf_library_import, public.frameleaf_library_import_mapping IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.frameleaf_library_import) OR EXISTS (SELECT 1 FROM public.frameleaf_library_import_mapping) THEN
      RAISE EXCEPTION 'Library import recovery records must be retained';
    END IF;
    DROP TABLE public.frameleaf_library_import_mapping;
    DROP TABLE public.frameleaf_library_import;
  END $$`.execute(db);
}
