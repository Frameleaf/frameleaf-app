import { Kysely, sql } from 'kysely';

/**
 * FL-111: immutable, server-owned declarations for checked project intermediates. A graph names
 * only an id; it cannot supply the file path, checksum, producer or source lineage. This fork-owned
 * table has no foreign key into public: project existence and ownership are checked on every read
 * and under a project row lock on registration. Orphan rows remain inaccessible for future file
 * retention cleanup. No worker or public registration endpoint is introduced by this migration.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.studio_generated_resource (
      "projectId" uuid NOT NULL,
      id text NOT NULL,
      "ownerId" uuid NOT NULL,
      "sourceRevision" integer NOT NULL,
      producer text NOT NULL,
      checksum text NOT NULL,
      path text NOT NULL,
      "derivedFrom" jsonb NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT studio_generated_resource_pkey PRIMARY KEY ("projectId", id),
      CONSTRAINT studio_generated_resource_revision_check CHECK ("sourceRevision" > 0),
      CONSTRAINT studio_generated_resource_lineage_check CHECK (jsonb_typeof("derivedFrom") = 'array')
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.studio_generated_resource`.execute(db);
}
