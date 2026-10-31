import { Kysely, sql } from 'kysely';

// FL-721: optional encryption of a person's Locked files. One row per person who turned it on, and
// `pendingUnlockAt` marks a locked asset that is leaving Locked while its files are unsealed.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "locked_encryption" (
  "userId" uuid NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "askAgainHours" integer DEFAULT 72,
  "recoveryKeyCreatedAt" timestamp with time zone NOT NULL,
  "enabledAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "locked_encryption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "locked_encryption_mode_check" CHECK ("mode" = ANY (ARRAY['pin'::text, 'advanced'::text])),
  CONSTRAINT "locked_encryption_status_check" CHECK ("status" = ANY (ARRAY['encrypting'::text, 'on'::text, 'decrypting'::text])),
  CONSTRAINT "locked_encryption_askAgainHours_check" CHECK ("askAgainHours" = ANY (ARRAY[8, 24, 72])),
  CONSTRAINT "locked_encryption_pkey" PRIMARY KEY ("userId")
);`.execute(db);
  await sql`ALTER TABLE "asset_lock" ADD "pendingUnlockAt" timestamp with time zone;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_lock" DROP COLUMN "pendingUnlockAt";`.execute(db);
  await sql`DROP TABLE "locked_encryption";`.execute(db);
}
