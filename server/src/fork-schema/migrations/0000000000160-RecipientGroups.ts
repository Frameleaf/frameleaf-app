import { Kysely, sql } from 'kysely';

/**
 * Named recipient shortcuts (FL-55). An owner saves a named group of people ("Family", "Hiking
 * club") and applies it when inviting to a shared space. A group is only a shortcut: applying it
 * sends ordinary, reviewable invitations, and editing or deleting it never adds, removes or changes
 * anybody's existing access. The name is private to its owner — it is never shown to the people in
 * it and never travels with an invitation.
 *
 * Fork-owned, so it does not foreign-key into the official schema; people who no longer exist are
 * left out when a group is read.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.recipient_group (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "ownerId" uuid NOT NULL,
      name text NOT NULL,
      "userIds" uuid[] NOT NULL DEFAULT '{}'::uuid[],
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT recipient_group_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
      CONSTRAINT recipient_group_size_check CHECK (cardinality("userIds") <= 200)
    )
  `.execute(db);
  await sql`CREATE INDEX recipient_group_owner_idx ON immich_fork.recipient_group ("ownerId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.recipient_group`.execute(db);
}
