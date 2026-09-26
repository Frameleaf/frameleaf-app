import { Kysely, sql } from 'kysely';

/**
 * What an admitted render worker session proved it can encode and write (FL-95, `STU-401`).
 *
 * Admission already binds a session to its engine digest, GPU memory and scopes. The codecs and
 * containers its conformance check verified are bound here, one row per session, so a claim is
 * measured against the evidence the session was admitted with: a worker that did not prove an
 * HEVC encoder is never handed an HEVC export. A session without a row proved nothing and is
 * given no job that names an output format.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema
 * (`sessionId` points at `public.render_worker_session` without a constraint); the row goes with
 * the session's own retention.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.render_worker_session_capability (
      "sessionId" uuid PRIMARY KEY,
      codecs text[] NOT NULL DEFAULT '{}'::text[],
      formats text[] NOT NULL DEFAULT '{}'::text[],
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.render_worker_session_capability`.execute(db);
}
