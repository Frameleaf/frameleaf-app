import { Kysely, sql } from 'kysely';

/**
 * Unified sign-in step 1: one record of methods, level, time and source for every session. Sessions that
 * exist now are recorded as legacy, with the method the old derived checks saw (`frameleaf_session`,
 * `session_passkey`), so remote access treats them exactly as before.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "session_sign_in" (
  "sessionId" uuid NOT NULL,
  "methods" character varying[] NOT NULL DEFAULT '{}',
  "level" character varying NOT NULL,
  "authTime" timestamp with time zone NOT NULL DEFAULT now(),
  "source" character varying NOT NULL,
  "legacy" boolean NOT NULL DEFAULT false,
  CONSTRAINT "session_sign_in_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "session_sign_in_pkey" PRIMARY KEY ("sessionId")
);`.execute(db);
  await sql`INSERT INTO "session_sign_in" ("sessionId", "methods", "level", "authTime", "source", "legacy")
  SELECT s."id",
    CASE WHEN f."sessionId" IS NULL AND p."sessionId" IS NOT NULL THEN ARRAY['passkey']::character varying[] ELSE '{}'::character varying[] END,
    CASE WHEN f."sessionId" IS NULL AND p."sessionId" IS NOT NULL THEN 'verified' ELSE 'basic' END,
    s."createdAt",
    CASE WHEN f."sessionId" IS NOT NULL THEN 'frameleaf' ELSE 'local' END,
    true
  FROM "session" s
  LEFT JOIN "frameleaf_session" f ON f."sessionId" = s."id"
  LEFT JOIN "session_passkey" p ON p."sessionId" = s."id";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "session_sign_in";`.execute(db);
}
