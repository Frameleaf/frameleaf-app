import { Kysely, sql } from 'kysely';

// Sync now sends each asset's SHA-256, what the apps hash their own originals with (`syncChecksum`).
// Forgetting how far each device's own-asset stream had got makes its next sync send every asset again, with
// that checksum. Deletes and every other stream carry on from where they were.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM session_sync_checkpoint
    WHERE type IN ('AssetV1', 'AssetV2', 'AssetV3', 'AssetBootstrapV1')`.execute(db);
}

// Nothing to put back: a device that was sent its assets again keeps them.
export function down(): Promise<void> {
  return Promise.resolve();
}
