import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.frameleaf_library_import
    ADD COLUMN private_owners jsonb,
    ADD COLUMN private_owners_sha256 text,
    ADD CONSTRAINT frameleaf_library_import_private_owners_pair CHECK ((private_owners IS NULL) = (private_owners_sha256 IS NULL)),
    ADD CONSTRAINT frameleaf_library_import_private_owners_object CHECK (private_owners IS NULL OR jsonb_typeof(private_owners)='object'),
    ADD CONSTRAINT frameleaf_library_import_private_owners_hash CHECK (private_owners_sha256 IS NULL OR private_owners_sha256 ~ '^[a-f0-9]{64}$')`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    LOCK TABLE public.frameleaf_library_import IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.frameleaf_library_import WHERE private_owners IS NOT NULL OR private_owners_sha256 IS NOT NULL) THEN
      RAISE EXCEPTION 'Private owner recovery inputs must be retained';
    END IF;
    ALTER TABLE public.frameleaf_library_import DROP COLUMN private_owners, DROP COLUMN private_owners_sha256;
  END $$`.execute(db);
}
