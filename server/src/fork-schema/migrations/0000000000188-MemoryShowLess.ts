import { Kysely, sql } from 'kysely';

/**
 * "Show less" on memories (FL-62): a person or pet of the owner's, a calendar date (`MM-dd`) or a
 * kind of memory that is no longer generated or shown to that owner. One row per rule; removing
 * the row brings them back.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema; a
 * rule naming a person or pet that no longer exists simply matches nothing.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.memory_show_less (
      "userId" uuid NOT NULL,
      kind text NOT NULL,
      value text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY ("userId", kind, value),
      CONSTRAINT memory_show_less_kind_check CHECK (kind IN ('person', 'pet', 'date', 'type')),
      CONSTRAINT memory_show_less_value_check CHECK (char_length(value) BETWEEN 1 AND 64)
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.memory_show_less`.execute(db);
}
