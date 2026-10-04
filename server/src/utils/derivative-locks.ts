import { Kysely, sql } from 'kysely';
import { AssetLockReason, AssetVisibility, StudioExportVersionState } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { isMotionOfLockedStill } from 'src/utils/database.js';
import { isLocked } from 'src/utils/locked.js';

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
 * and notifies like any other lock. The lock is marked `inherited`, so `releaseDerivedResults` can
 * take it off again; a result that was already locked keeps its own lock.
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
      INSERT INTO asset_lock ("assetId", reason, "lockedBy", inherited)
      SELECT target.id, target.reason, NULL, true
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

/**
 * The other half (FL-195 follow-up, owner decision, September 27, 2026: "yes they should unlock"): once
 * a source is unlocked, every published Studio export that read it and now has no locked source left
 * is unlocked too — its recorded privacy, and its result asset's lock when that lock was inherited
 * (`asset_lock.inherited`). A lock the owner put on the result directly is never released here, and a
 * result that still has a locked source stays locked. Exports made from a released result follow in
 * turn. Call it in the transaction that deleted the source locks. Returns the result assets unlocked.
 */
export const releaseDerivedResults = async (db: Kysely<DB>, assetIds: string[]): Promise<string[]> => {
  const released: string[] = [];
  const visited = new Set(assetIds);
  let frontier = [...visited];
  const effectiveLocks = db
    .selectFrom('asset')
    .select('asset.id')
    .where((eb) => eb.or([isLocked(), isMotionOfLockedStill(eb)]));

  while (frontier.length > 0) {
    const exists = await sql<{ present: boolean }>`
      SELECT to_regclass('public.studio_export_version_source') IS NOT NULL AS present
    `.execute(db);
    if (!exists.rows[0]?.present) {
      return released;
    }

    // A still can lend its lock to motion without a motion lock row. Follow that motion even
    // though the caller's deleted lock rows contain only the still.
    const motions = await db
      .selectFrom('asset as still')
      .innerJoin('asset as motion', 'motion.id', 'still.livePhotoVideoId')
      .select('motion.id')
      .where('still.id', 'in', frontier)
      .where('motion.visibility', '=', AssetVisibility.Hidden)
      .execute();
    for (const { id } of motions) {
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      frontier.push(id);
    }

    // Sources that are no longer locked stop counting as locked on every version that read them.
    await sql`
      UPDATE studio_export_version_source
      SET locked = false, "lockReason" = NULL
      WHERE "assetId" = ANY(${frontier}::uuid[])
        AND NOT EXISTS (${effectiveLocks.where('asset.id', '=', sql<string>`studio_export_version_source."assetId"`)})
    `.execute(db);

    // Published versions made from these sources with no locked source left.
    const { rows } = await sql<{ versionId: string; resultAssetId: string | null }>`
      SELECT DISTINCT version.id AS "versionId", version."resultAssetId"
      FROM studio_export_version_source source
      JOIN studio_export_version version ON version.id = source."versionId"
      WHERE source."assetId" = ANY(${frontier}::uuid[])
        AND version.state = ${StudioExportVersionState.Published}
        AND NOT EXISTS (
          SELECT 1
          FROM studio_export_version_source other
          WHERE other."versionId" = version.id
            AND EXISTS (${effectiveLocks.where('asset.id', '=', sql<string>`other."assetId"`)})
        )
    `.execute(db);
    if (rows.length === 0) {
      return released;
    }

    await sql`
      UPDATE studio_export_version
      SET privacy = jsonb_set(coalesce(privacy, '{}'::jsonb), '{lockReason}', 'null'::jsonb), "updatedAt" = now()
      WHERE id = ANY(${rows.map((row) => row.versionId)}::uuid[])
    `.execute(db);

    const results = [...new Set(rows.map((row) => row.resultAssetId).filter((id): id is string => !!id))];
    if (results.length === 0) {
      return released;
    }
    const unlocked = await sql<{ assetId: string }>`
      DELETE FROM asset_lock
      WHERE "assetId" = ANY(${results}::uuid[]) AND inherited = true
      RETURNING "assetId"
    `.execute(db);
    const next = unlocked.rows.map((row) => row.assetId);
    if (next.length > 0) {
      await db.updateTable('asset').set({ updatedAt: new Date() }).where('id', 'in', next).execute();
    }
    released.push(...next);
    frontier = next.filter((id) => !visited.has(id));
    for (const id of frontier) {
      visited.add(id);
    }
  }

  return released;
};
