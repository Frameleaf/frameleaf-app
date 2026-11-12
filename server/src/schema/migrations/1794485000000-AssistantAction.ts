import { Kysely, sql } from 'kysely';

/** FL-938: the assistant action journal: what Frameleaf Assistant proposed, applied and undid. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "assistant_action" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "userId" uuid NOT NULL,
  "question" text,
  "kind" character varying NOT NULL,
  "status" character varying NOT NULL,
  "plan" jsonb NOT NULL,
  "mediaOperationId" uuid,
  "createdAlbumId" uuid,
  "before" jsonb,
  "undo" jsonb,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "appliedAt" timestamp with time zone,
  "undoneAt" timestamp with time zone,
  CONSTRAINT "assistant_action_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "assistant_action_mediaOperationId_fkey" FOREIGN KEY ("mediaOperationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "assistant_action_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "assistant_action_userId_createdAt_idx" ON "assistant_action" ("userId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "assistant_action_mediaOperationId_idx" ON "assistant_action" ("mediaOperationId");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "assistant_action";`.execute(db);
}
