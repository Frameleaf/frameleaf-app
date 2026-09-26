import { Kysely, sql } from 'kysely';

/**
 * Utility activity (FL-47, owner decision on FL-146, 2026-09-25): the persistent "Recent utility
 * activity" of `UtilitiesManager.jsx:946-956`, starting with Large files. Each reviewed move to the
 * trash and each undo is one row: its time, the action, how many items and their combined size, and
 * the items themselves (asset id, file name and size) in `items`.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema. Only
 * the owner reads it; a file name is shown only while the item is still one the reading session may
 * see. Rows go with the account, and are kept for a year and at most 500 per owner.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.utility_activity (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "userId" uuid NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      tool text NOT NULL,
      action text NOT NULL,
      "itemCount" integer NOT NULL,
      bytes bigint NOT NULL DEFAULT 0,
      items jsonb NOT NULL,
      CONSTRAINT utility_activity_tool_check CHECK (tool IN ('large-files')),
      CONSTRAINT utility_activity_action_check CHECK (action IN ('trash', 'restore')),
      CONSTRAINT utility_activity_count_check CHECK ("itemCount" >= 0),
      CONSTRAINT utility_activity_bytes_check CHECK (bytes >= 0),
      CONSTRAINT utility_activity_items_check CHECK (jsonb_typeof(items) = 'array')
    )
  `.execute(db);
  await sql`
    CREATE INDEX utility_activity_user_tool_created_idx
      ON immich_fork.utility_activity ("userId", tool, "createdAt" DESC)
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.utility_activity`.execute(db);
}
