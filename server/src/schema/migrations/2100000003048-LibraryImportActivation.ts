import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.frameleaf_library_import
    ADD COLUMN activation jsonb,
    ADD COLUMN activation_sha256 text,
    ADD CONSTRAINT frameleaf_library_import_activation_pair CHECK ((activation IS NULL) = (activation_sha256 IS NULL)),
    ADD CONSTRAINT frameleaf_library_import_activation_object CHECK (activation IS NULL OR jsonb_typeof(activation)='object'),
    ADD CONSTRAINT frameleaf_library_import_activation_hash CHECK (activation_sha256 IS NULL OR activation_sha256 ~ '^[a-f0-9]{64}$'),
    ADD CONSTRAINT frameleaf_library_import_activation_phase CHECK (activation IS NULL OR status='activated')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    LOCK TABLE public.frameleaf_library_import IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.frameleaf_library_import WHERE activation IS NOT NULL OR activation_sha256 IS NOT NULL) THEN
      RAISE EXCEPTION 'Activation recovery evidence must be retained';
    END IF;
    ALTER TABLE public.frameleaf_library_import DROP COLUMN activation, DROP COLUMN activation_sha256;
  END $$`.execute(db);
}
