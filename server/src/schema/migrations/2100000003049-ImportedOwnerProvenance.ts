import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public."user" ADD COLUMN "importOperationId" uuid;
    WITH evidence AS (
      SELECT operation_id,destination_id FROM public.frameleaf_library_import_mapping WHERE entity_kind='owner'
      UNION
      SELECT i.operation_id,(owner->>'destinationId')::uuid FROM public.frameleaf_library_import i,
        LATERAL jsonb_array_elements(coalesce(i.reviewed_plan->'owners','[]'::jsonb)) owner
    ) UPDATE public."user" u SET "importOperationId"=e.operation_id FROM evidence e WHERE u.id=e.destination_id`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DO $$ BEGIN
    LOCK TABLE public."user" IN ACCESS EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM public."user" WHERE "importOperationId" IS NOT NULL) THEN
      RAISE EXCEPTION 'Imported owner provenance must be retained';
    END IF;
    ALTER TABLE public."user" DROP COLUMN "importOperationId";
  END $$`.execute(db);
}
