import { Kysely, sql } from 'kysely';

/**
 * Sign in with Frameleaf token exchange (FL-230, NAPI-006): what keeps a server-audience token from
 * the Frameleaf identity provider to one session, and out once Frameleaf Cloud ended access.
 *
 * - `frameleaf_exchange_token`: every exchange token presented, by its `jti`, until it could no longer
 *   be accepted anyway (`expiresAt`), so a copy is refused as replayed.
 * - `frameleaf_sign_in_revocation`: a Frameleaf back-channel logout (unshare, a lowered role, a
 *   suspension, or a sign-out) for an account (`kind` = `sub`) or a Frameleaf session (`sid`). An
 *   exchange token minted before `revokedAt` is refused until `expiresAt`, when every such token has
 *   expired.
 *
 * Expired rows are removed by the writers. Fork-owned: no foreign key into the official schema.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.frameleaf_exchange_token (
      jti text NOT NULL,
      sub text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "usedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT frameleaf_exchange_token_pkey PRIMARY KEY (jti)
    )
  `.execute(db);
  await sql`
    CREATE INDEX frameleaf_exchange_token_expires_idx ON immich_fork.frameleaf_exchange_token ("expiresAt")
  `.execute(db);
  await sql`
    CREATE TABLE immich_fork.frameleaf_sign_in_revocation (
      kind text NOT NULL,
      value text NOT NULL,
      "revokedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "expiresAt" timestamptz NOT NULL,
      CONSTRAINT frameleaf_sign_in_revocation_pkey PRIMARY KEY (kind, value),
      CONSTRAINT frameleaf_sign_in_revocation_kind_check CHECK (kind IN ('sid', 'sub'))
    )
  `.execute(db);
  await sql`
    CREATE INDEX frameleaf_sign_in_revocation_expires_idx ON immich_fork.frameleaf_sign_in_revocation ("expiresAt")
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.frameleaf_sign_in_revocation`.execute(db);
  await sql`DROP TABLE immich_fork.frameleaf_exchange_token`.execute(db);
}
