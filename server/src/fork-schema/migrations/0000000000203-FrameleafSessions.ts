import { Kysely, sql } from 'kysely';

/**
 * Sign in with Frameleaf (FL-158, CLD-005): the sessions a Frameleaf sign-in created.
 *
 * One row per session, with its account here (`userId`), the Frameleaf session id (`sid`), account (`sub`) and when the person
 * authenticated, so a back-channel logout from Frameleaf Cloud ends every session it names and
 * remote-access enforcement can tell these sessions apart. A handoff to another address of this
 * server (`handoffCodeHash`, `handoffExpiresAt`) is a single-use, short-lived code stored only as a
 * hash. Fork-owned: no foreign key into the official `session` table.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.frameleaf_session (
      "sessionId" uuid NOT NULL,
      "userId" uuid NOT NULL,
      sid text,
      sub text NOT NULL,
      "authTime" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "handoffCodeHash" text,
      "handoffExpiresAt" timestamptz,
      CONSTRAINT frameleaf_session_pkey PRIMARY KEY ("sessionId"),
      CONSTRAINT frameleaf_session_handoff_unique UNIQUE ("handoffCodeHash")
    )
  `.execute(db);
  await sql`CREATE INDEX frameleaf_session_sid_idx ON immich_fork.frameleaf_session (sid)`.execute(db);
  await sql`CREATE INDEX frameleaf_session_sub_idx ON immich_fork.frameleaf_session (sub)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.frameleaf_session`.execute(db);
}
