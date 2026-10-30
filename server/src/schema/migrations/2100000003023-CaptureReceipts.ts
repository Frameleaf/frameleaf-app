import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "bookmark" ADD "source" jsonb;`.execute(db);
  await sql`CREATE TABLE "capture_receipt" (
  "ownerId" uuid NOT NULL,
  "captureId" uuid NOT NULL,
  "actorId" text NOT NULL,
  "requestHash" bytea NOT NULL,
  "kind" text NOT NULL,
  "itemId" uuid NOT NULL,
  "status" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "capture_receipt_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "capture_receipt_pkey" PRIMARY KEY ("ownerId", "captureId")
);`.execute(db);
}

export function down(): Promise<void> {
  return Promise.reject(new Error('Capture receipts prevent duplicate publication; restore a backup rather than discarding them'));
}
