import { Kysely, sql } from 'kysely';
import { AssetLockReason, StudioExportVersionState } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

/**
 * A source that becomes Locked locks everything already published from it (FL-106).
 *
 * Privacy is inherited as a union at publication, and this keeps the union true afterwards: when a
 * source gains a lock, every published Studio export that read it gains one too, with the source's
 * reason, in the same transaction as the source's lock. A `library` result is an asset and gets an
 * `asset_lock` record (never `visibility = locked`); a `project` result records the lock in its
 * privacy, which its download checks. An export made from such a result is followed in turn.
 *
 * Call it after the source locks are written and after the source rows were updated in the same
 * transaction: that update waits for any publication holding those rows, so the versions it
 * committed are seen here. Returns the result assets it locked, so the caller releases their covers
 * and notifies like any other lock. Nothing is ever unlocked here.
 */
export const lockDerivedResults = async (db: Kysely<DB>, assetIds: string[]): Promise<string[]> => {
  const locked: string[] = [];
  const visited = new Set(assetIds);
  let frontier = [...visited];

  while (frontier.length > 0) {
    const exists = await sql<{ present: boolean }>`
      SELECT to_regclass('public.studio_export_version_source') IS NOT NULL AS present
    `.execute(db);
    if (!exists.rows[0]?.present) {
      return locked;
    }

    // Every published version made from one of these sources, with the reason the source now has.
    const { rows } = await sql<{ versionId: string; resultAssetId: string | null; reason: AssetLockReason }>`
      SELECT DISTINCT ON (version.id) version.id AS "versionId", version."resultAssetId", asset_lock.reason
      FROM studio_export_version_source source
      JOIN studio_export_version version ON version.id = source."versionId"
      JOIN asset_lock ON asset_lock."assetId" = source."assetId"
      WHERE source."assetId" = ANY(${frontier}::uuid[])
        AND version.state = ${StudioExportVersionState.Published}
      ORDER BY version.id,
        CASE asset_lock.reason
          WHEN ${AssetLockReason.ImmichLockedFolder} THEN 3
          WHEN ${AssetLockReason.Marked} THEN 2
          ELSE 1
        END DESC
    `.execute(db);
    if (rows.length === 0) {
      return locked;
    }

    for (const row of rows) {
      await sql`
        UPDATE studio_export_version_source
        SET locked = true, "lockReason" = coalesce("lockReason", ${row.reason})
        WHERE "versionId" = ${row.versionId}::uuid AND "assetId" = ANY(${frontier}::uuid[])
      `.execute(db);
      await sql`
        UPDATE studio_export_version
        SET privacy = jsonb_set(
              coalesce(privacy, '{}'::jsonb),
              '{lockReason}',
              to_jsonb(coalesce(privacy ->> 'lockReason', ${row.reason}::text))
            ),
            "updatedAt" = now()
        WHERE id = ${row.versionId}::uuid
      `.execute(db);
    }

    const results = [...new Set(rows.map((row) => row.resultAssetId).filter((id): id is string => !!id))];
    const reasons = new Map(rows.filter((row) => row.resultAssetId).map((row) => [row.resultAssetId!, row.reason]));
    if (results.length === 0) {
      return locked;
    }
    const inserted = await sql<{ assetId: string }>`
      INSERT INTO asset_lock ("assetId", reason, "lockedBy")
      SELECT target.id, target.reason, NULL
      FROM unnest(${results}::uuid[], ${results.map((id) => reasons.get(id)!)}::text[]) AS target(id, reason)
      ON CONFLICT ("assetId") DO NOTHING
      RETURNING "assetId"
    `.execute(db);
    const next = inserted.rows.map((row) => row.assetId);
    if (next.length > 0) {
      await db.updateTable('asset').set({ updatedAt: new Date() }).where('id', 'in', next).execute();
    }
    locked.push(...next);
    frontier = results.filter((id) => !visited.has(id));
    for (const id of frontier) {
      visited.add(id);
    }
  }

  return locked;
};
