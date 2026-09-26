import { Kysely, sql } from 'kysely';

/**
 * An account's own preference history (FL-71 CC-10): the "Change history" area of
 * `CommandCenter.jsx` for accounts that are not administrators. Each saved preferences change is
 * one row with its time, the device that saved it and every changed preference before and after,
 * redacted like the settings history. Locked-content rules are recorded only as changed.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema, and
 * it is not `user_metadata`, which syncs to the mobile apps. Only the account itself reads it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.user_preference_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" uuid NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "deviceLabel" text,
      changes jsonb NOT NULL,
      "omittedChanges" integer NOT NULL DEFAULT 0,
      CONSTRAINT user_preference_history_changes_check CHECK (jsonb_typeof(changes) = 'array'),
      CONSTRAINT user_preference_history_omitted_check CHECK ("omittedChanges" >= 0)
    )
  `.execute(db);
  await sql`
    CREATE INDEX user_preference_history_user_created_idx
      ON immich_fork.user_preference_history ("userId", "createdAt" DESC)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.user_preference_history`.execute(db);
}
