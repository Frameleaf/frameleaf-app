import { Kysely, sql } from 'kysely';

/**
 * FL-920: import connections. A connection is a remote place one account imports from; each scan of
 * it is a `takeout_import` row that names it, and `import_connection_item` remembers every file the
 * connection has seen at its source so a later scan only offers what is new.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "import_connection" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "provider" text NOT NULL,
  "displayName" text NOT NULL,
  "sealedCredentials" bytea NOT NULL,
  "roots" jsonb NOT NULL DEFAULT '[]',
  "dailyCheck" boolean NOT NULL DEFAULT false,
  "cursor" jsonb,
  "lastScanAt" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'active',
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "import_connection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "import_connection_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "import_connection_ownerId_idx" ON "import_connection" ("ownerId");`.execute(db);
  await sql`ALTER TABLE "takeout_import" ADD "connectionId" uuid;`.execute(db);
  await sql`ALTER TABLE "takeout_import" ADD CONSTRAINT "takeout_import_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "import_connection" ("id") ON UPDATE CASCADE ON DELETE CASCADE;`.execute(
    db,
  );
  await sql`CREATE INDEX "takeout_import_connectionId_idx" ON "takeout_import" ("connectionId");`.execute(db);
  await sql`CREATE TABLE "import_connection_item" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "connectionId" uuid NOT NULL,
  "remoteId" text NOT NULL,
  "path" text NOT NULL,
  "size" bigint NOT NULL,
  "modifiedAt" timestamp with time zone NOT NULL,
  "contentHash" text,
  "albumHint" text,
  "caption" text,
  "favourite" boolean NOT NULL DEFAULT false,
  "importId" uuid,
  "fileId" uuid,
  "error" text,
  CONSTRAINT "import_connection_item_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "import_connection" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "import_connection_item_importId_fkey" FOREIGN KEY ("importId") REFERENCES "takeout_import" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "import_connection_item_connectionId_remoteId_uq" UNIQUE ("connectionId", "remoteId"),
  CONSTRAINT "import_connection_item_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "import_connection_item_connectionId_idx" ON "import_connection_item" ("connectionId");`.execute(
    db,
  );
  await sql`CREATE INDEX "import_connection_item_importId_idx" ON "import_connection_item" ("importId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "import_connection_item";`.execute(db);
  await sql`ALTER TABLE "takeout_import" DROP COLUMN "connectionId";`.execute(db);
  await sql`DROP TABLE "import_connection";`.execute(db);
}
