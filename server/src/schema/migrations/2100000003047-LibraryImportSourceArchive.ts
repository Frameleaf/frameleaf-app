import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE public.frameleaf_library_import_archive (
    operation_id uuid PRIMARY KEY REFERENCES public.frameleaf_library_import(operation_id),
    destination_id uuid NOT NULL,
    version integer NOT NULL CHECK (version=1),
    expected_count bigint NOT NULL CHECK (expected_count>=0),
    expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
    written_count bigint NOT NULL DEFAULT 0 CHECK (written_count>=0 AND written_count<=expected_count),
    sealed boolean NOT NULL DEFAULT false CHECK (NOT sealed OR written_count=expected_count)
  )`.execute(db);
  await sql`CREATE TABLE public.frameleaf_library_import_archive_record (
    operation_id uuid NOT NULL REFERENCES public.frameleaf_library_import_archive(operation_id),
    ordinal bigint NOT NULL CHECK (ordinal>=0),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY(operation_id,ordinal)
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    LOCK TABLE public.frameleaf_library_import_archive IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public.frameleaf_library_import_archive) THEN
      RAISE EXCEPTION 'Source metadata recovery archives must be retained';
    END IF;
    DROP TABLE public.frameleaf_library_import_archive_record;
    DROP TABLE public.frameleaf_library_import_archive;
  END $$`.execute(db);
}
