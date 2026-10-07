import { Kysely, sql } from 'kysely';

/** Existing projects have no creation identity; retries are deduplicated for new requests only. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`alter table public.studio_project add column "createRequestKey" text,
    add column "createRequestDigest" text,
    add constraint "studio_project_ownerId_createRequestKey_uq" unique ("ownerId", "createRequestKey")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`alter table public.studio_project drop constraint "studio_project_ownerId_createRequestKey_uq",
    drop column "createRequestKey", drop column "createRequestDigest"`.execute(db);
}
