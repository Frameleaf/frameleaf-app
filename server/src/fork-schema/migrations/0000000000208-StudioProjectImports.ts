import { Kysely, sql } from 'kysely';

/**
 * FL-103 / FL-105: files uploaded into a Studio project rather than the library — microphone
 * recordings, music and sound files, stills, SVG and Lottie graphics. A graph names only the id;
 * the server records the owner, the checked content type, the SHA-256, the size and the
 * owner-private path. Like the generated media table it has no foreign key into public: project
 * existence and ownership are rechecked on every read and under a project row lock on registration,
 * and the Studio lifecycle sweep removes the rows and files of a project deleted for good.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.studio_project_import (
      "projectId" uuid NOT NULL,
      id uuid NOT NULL,
      "ownerId" uuid NOT NULL,
      "contentType" text NOT NULL,
      checksum text NOT NULL,
      "sizeBytes" bigint NOT NULL,
      path text NOT NULL,
      "fileName" text NOT NULL,
      "externalReferences" integer,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT studio_project_import_pkey PRIMARY KEY ("projectId", id),
      CONSTRAINT studio_project_import_size_check CHECK ("sizeBytes" > 0),
      CONSTRAINT studio_project_import_checksum_check CHECK (checksum ~ '^[a-f0-9]{64}$'),
      CONSTRAINT studio_project_import_references_check CHECK ("externalReferences" IS NULL OR "externalReferences" >= 0)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.studio_project_import`.execute(db);
}
