import { Kysely, sql } from 'kysely';

/**
 * Each account's Studio workspace layout (FL-91, `STU-204`): the panels, sizes and timeline zoom
 * Freecut keeps in a workspace folder (`infrastructure/storage/workspace-fs`). Here it is stored
 * per account on the server, never behind a File System Access handle, so it follows the person
 * to Safari and Firefox and to another device. The layout is the engine's own document, stored
 * and returned byte for byte with the engine revision that wrote it.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema; the
 * row is removed when its account is.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.studio_workspace_layout (
      "userId" uuid PRIMARY KEY,
      layout jsonb NOT NULL,
      "engineRevision" text NOT NULL,
      "savedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT studio_workspace_layout_object_check CHECK (jsonb_typeof(layout) = 'object')
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.studio_workspace_layout`.execute(db);
}
