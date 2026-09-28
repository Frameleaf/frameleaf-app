import { Kysely, sql } from 'kysely';

/**
 * Studio projects, their immutable revision history and review comments (FL-89, `STU-202`).
 *
 * The project row is the head pointer and the writer lease; every accepted save is its own
 * revision row. `(projectId, requestKey)` is unique so a lost-ack retry is answered from the row
 * it already produced instead of being applied twice.
 *
 * Constraint and index names follow the generator's conventions (`{table}_{column}_fkey`,
 * `{table}_pkey`, `{table}_{columns}_uq`, and a `{table}_{column}_idx` index for every
 * foreign-key column) so `migrations:generate` produces no drift against the table classes.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "studio_project" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "name" character varying NOT NULL,
  "spaceId" uuid,
  "currentRevision" integer NOT NULL DEFAULT 0,
  "leaseHolderId" uuid,
  "leaseClientId" character varying,
  "leaseExpiresAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "studio_project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "studio_project_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_project_leaseHolderId_fkey" FOREIGN KEY ("leaseHolderId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_project_pkey" PRIMARY KEY ("id")
);`.execute(db);

  await sql`CREATE INDEX "studio_project_ownerId_idx" ON "studio_project" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "studio_project_spaceId_idx" ON "studio_project" ("spaceId");`.execute(db);
  await sql`CREATE INDEX "studio_project_leaseHolderId_idx" ON "studio_project" ("leaseHolderId");`.execute(db);
  await sql`CREATE INDEX "studio_project_ownerId_updatedAt_idx" ON "studio_project" ("ownerId", "updatedAt");`.execute(
    db,
  );

  await sql`CREATE TRIGGER "studio_project_updatedAt"
  BEFORE UPDATE ON "studio_project"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE TABLE "studio_project_revision" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "projectId" uuid NOT NULL,
  "revision" integer NOT NULL,
  "authorId" uuid,
  "envelope" jsonb NOT NULL,
  "digest" character varying NOT NULL,
  "graphBytes" integer NOT NULL,
  "summary" jsonb NOT NULL,
  "requestKey" character varying,
  "restoredFromRevision" integer,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "studio_project_revision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "studio_project" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "studio_project_revision_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_project_revision_projectId_revision_uq" UNIQUE ("projectId", "revision"),
  CONSTRAINT "studio_project_revision_projectId_requestKey_uq" UNIQUE ("projectId", "requestKey"),
  CONSTRAINT "studio_project_revision_pkey" PRIMARY KEY ("id")
);`.execute(db);

  await sql`CREATE INDEX "studio_project_revision_projectId_idx" ON "studio_project_revision" ("projectId");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_project_revision_authorId_idx" ON "studio_project_revision" ("authorId");`.execute(db);

  await sql`CREATE TABLE "studio_project_comment" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "projectId" uuid NOT NULL,
  "authorId" uuid NOT NULL,
  "revision" integer NOT NULL,
  "timeNum" bigint NOT NULL,
  "timeDen" bigint NOT NULL,
  "text" text NOT NULL,
  "resolvedAt" timestamp with time zone,
  "resolvedById" uuid,
  "requestKey" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "studio_project_comment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "studio_project" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "studio_project_comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "studio_project_comment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_project_comment_projectId_requestKey_uq" UNIQUE ("projectId", "requestKey"),
  CONSTRAINT "studio_project_comment_pkey" PRIMARY KEY ("id")
);`.execute(db);

  await sql`CREATE INDEX "studio_project_comment_projectId_idx" ON "studio_project_comment" ("projectId");`.execute(db);
  await sql`CREATE INDEX "studio_project_comment_authorId_idx" ON "studio_project_comment" ("authorId");`.execute(db);
  await sql`CREATE INDEX "studio_project_comment_resolvedById_idx" ON "studio_project_comment" ("resolvedById");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_project_comment_projectId_createdAt_idx" ON "studio_project_comment" ("projectId", "createdAt");`.execute(
    db,
  );

  await sql`CREATE TRIGGER "studio_project_comment_updatedAt"
  BEFORE UPDATE ON "studio_project_comment"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "studio_project_comment";`.execute(db);
  await sql`DROP TABLE "studio_project_revision";`.execute(db);
  await sql`DROP TABLE "studio_project";`.execute(db);
}
