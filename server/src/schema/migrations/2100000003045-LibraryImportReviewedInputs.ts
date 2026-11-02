import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.frameleaf_library_import
    ADD COLUMN reviewed_manifest jsonb,
    ADD COLUMN reviewed_plan jsonb,
    ADD CONSTRAINT frameleaf_library_import_inputs_pair CHECK ((reviewed_manifest IS NULL) = (reviewed_plan IS NULL)),
    ADD CONSTRAINT frameleaf_library_import_manifest_object CHECK (reviewed_manifest IS NULL OR jsonb_typeof(reviewed_manifest)='object'),
    ADD CONSTRAINT frameleaf_library_import_plan_object CHECK (reviewed_plan IS NULL OR jsonb_typeof(reviewed_plan)='object')`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    LOCK TABLE public.frameleaf_library_import IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.frameleaf_library_import WHERE reviewed_manifest IS NOT NULL OR reviewed_plan IS NOT NULL) THEN
      RAISE EXCEPTION 'Reviewed library import inputs must be retained';
    END IF;
    ALTER TABLE public.frameleaf_library_import DROP COLUMN reviewed_manifest, DROP COLUMN reviewed_plan;
  END $$`.execute(db);
}
