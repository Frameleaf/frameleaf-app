import { Kysely, sql } from 'kysely';

/**
 * Sign in with Frameleaf (FL-158, CLD-005): the Frameleaf account each local account is linked to.
 *
 * One row per local account and one local account per Frameleaf account (`sub` is unique). A local
 * account linked to an administrator's own identity provider can also have a row here: the two
 * providers are separate slots. `autoRegistered` marks an account Frameleaf Cloud created on first
 * sign-in, whose role follows the cloud's `frameleaf_role` claim. Fork-owned, so it lives in
 * `immich_fork` and does not foreign-key into the official schema; the account service removes a
 * person's row when the account is removed.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.frameleaf_account_link (
      "userId" uuid NOT NULL,
      sub text NOT NULL,
      email text NOT NULL,
      "emailVerified" boolean NOT NULL DEFAULT false,
      role text,
      "autoRegistered" boolean NOT NULL DEFAULT false,
      "linkedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "lastSignInAt" timestamptz,
      CONSTRAINT frameleaf_account_link_pkey PRIMARY KEY ("userId"),
      CONSTRAINT frameleaf_account_link_sub_unique UNIQUE (sub),
      CONSTRAINT frameleaf_account_link_role_check CHECK (role IS NULL OR role IN ('admin', 'user'))
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.frameleaf_account_link`.execute(db);
}
