import { Kysely, sql } from 'kysely';

/**
 * Server-level Viewer access (FL-235): the role Frameleaf Cloud's invitation gives each linked
 * account on this server (the `frameleaf_access` claim), recorded on every Sign in with Frameleaf
 * and link, and when a Viewer's scope (the server owner's library, shared as a partner) was last
 * granted. Revoking a Viewer's access clears `scopeGrantedAt` and keeps `access`, so the account
 * stays read-only and the next invitation grants the scope again. Fork-owned, like the table.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE immich_fork.frameleaf_account_link
      ADD COLUMN access text,
      ADD COLUMN "scopeGrantedAt" timestamptz,
      ADD CONSTRAINT frameleaf_account_link_access_check
        CHECK (access IS NULL OR access IN ('owner', 'admin', 'editor', 'viewer'))
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE immich_fork.frameleaf_account_link
      DROP CONSTRAINT frameleaf_account_link_access_check,
      DROP COLUMN "scopeGrantedAt",
      DROP COLUMN access
  `.execute(db);
}
