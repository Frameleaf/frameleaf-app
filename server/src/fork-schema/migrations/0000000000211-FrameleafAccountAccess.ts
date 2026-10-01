import { Kysely, sql } from 'kysely';

/**
 * FL-235: the access Frameleaf Cloud's invitation gives each linked account on this server (the
 * `frameleaf_access` claim: `owner`, `admin`, `editor` or `viewer`), recorded on every Sign in with
 * Frameleaf and link. It grants nothing (every invited person has their own regular account and
 * library); `GET /users/me` reports the server owner from it. Fork-owned, like the table.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE immich_fork.frameleaf_account_link
      ADD COLUMN access text,
      ADD CONSTRAINT frameleaf_account_link_access_check
        CHECK (access IS NULL OR access IN ('owner', 'admin', 'editor', 'viewer'))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE immich_fork.frameleaf_account_link
      DROP CONSTRAINT frameleaf_account_link_access_check,
      DROP COLUMN access
  `.execute(db);
}
