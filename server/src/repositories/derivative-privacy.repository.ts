import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';

import { DB } from 'src/schema/index.js';
import { DerivativeSourceEvidence, strongestLockReason } from 'src/utils/derivative-privacy.js';
import { getOwnerHiddenShareIds } from 'src/utils/item-share.js';
import { isNotLocked } from 'src/utils/locked.js';
/** One library source as publication found it, locked for the rest of the transaction. */
export type LockedSourceRow = DerivativeSourceEvidence & {
  deleted: boolean;
  offline: boolean;
  /** `asset.checksum`, base64, as FL-90 records it in a manifest. */
  checksum: string;
  visibility: AssetVisibility;
};
/**
 * Privacy evidence for derived media (FL-106, `STU-404`).
 *
 * Every method takes the caller's transaction: evidence is only worth something when it is read
 * under the same locks, and in the same transaction, as the result it restricts is created. A lock
 * on a source that commits after these reads waits for the publication to finish; one that commits
 * before is seen. Nothing here decides the policy; that is `unionDerivativePrivacy`.
 */
@Injectable()
export class DerivativePrivacyRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /**
   * Read, and share-lock, every library source a result is made from.
   *
   * `FOR SHARE` on the asset rows conflicts with the row update every lock, trash, delete and owner
   * change performs, so none of them can slip in between this read and the commit that publishes.
   * A source that is gone is simply missing from the answer.
   */
  async lockSources(tx: Kysely<DB>, assetIds: readonly string[]): Promise<Map<string, LockedSourceRow>> {
    if (assetIds.length === 0) {
      return new Map();
    }
    const { rows } = await sql<{
      id: string;
      ownerId: string;
      deletedAt: Date | null;
      isOffline: boolean;
      checksum: Buffer;
      visibility: AssetVisibility;
    }>`
      SELECT asset.id, asset."ownerId", asset."deletedAt", asset."isOffline", asset.checksum, asset.visibility
      FROM asset
      WHERE asset.id = ANY(${[...assetIds]}::uuid[])
        OR asset."livePhotoVideoId" = ANY(${[...assetIds]}::uuid[])
      ORDER BY asset.id
      FOR SHARE OF asset
    `.execute(tx);
    const sensitive = await this.sensitiveIds(tx, assetIds);
    // Read after the row locks are held, including a still linked after it was locked: its hidden
    // motion may have no lock record of its own, but library access already treats it as Locked.
    const locks = await sql<{
      assetId: string;
      reason: AssetLockReason;
    }>`
      SELECT source.id AS "assetId", asset_lock.reason
      FROM asset source
      JOIN asset locked ON locked.id = source.id
        OR (source.visibility = ${sql.lit(AssetVisibility.Hidden)} AND locked."livePhotoVideoId" = source.id)
      JOIN asset_lock ON asset_lock."assetId" = locked.id
      WHERE source.id = ANY(${[...assetIds]}::uuid[])
    `.execute(tx);
    const reasons = new Map<string, AssetLockReason | null>();
    for (const row of locks.rows) {
      reasons.set(row.assetId, strongestLockReason([reasons.get(row.assetId) ?? null, row.reason]));
    }
    const requested = new Set(assetIds);
    return new Map(
      // An item share's still grants its motion access. Lock both in the same order as lock writers,
      // but only the requested sources contribute publication evidence.
      rows
        .filter((row) => requested.has(row.id))
        .map((row) => [
          row.id,
          {
            assetId: row.id,
            ownerId: row.ownerId,
            deleted: row.deletedAt !== null,
            offline: row.isOffline,
            sensitive: sensitive.has(row.id),
            lockReason: reasons.get(row.id) ?? null,
            checksum: Buffer.from(row.checksum).toString('base64'),
            visibility: row.visibility,
          },
        ]),
    );
  }
  /**
   * Which of these assets carry positive sensitive evidence in `public.asset.is_nsfw`,
   * the same source used by `getUnlockedDetectionIds`.
   */
  private async sensitiveIds(tx: Kysely<DB>, assetIds: readonly string[]): Promise<Set<string>> {
    const { rows } = await sql<{
      id: string;
    }>`
          SELECT id FROM asset WHERE id = ANY(${[...assetIds]}::uuid[]) AND is_nsfw = true
        `.execute(tx);
    return new Set(rows.map((row) => row.id));
  }
  /**
   * Which of these sources — all owned by somebody other than `userId` — `userId` can still reach
   * right now, share-locking the rows that grant it.
   *
   * The same grants as the library (`AccessRepository`): an album the account is a member
   * of (owners are members too) that holds the asset, or an item shared directly with the account.
   * FL-326: a partnership grants nothing, as partners hold their own copies. Locked media is reached
   * by none of them. The rows that grant access are locked `FOR SHARE`, so deleting the album,
   * removing the account from it or taking the asset out of it waits for this transaction; one that
   * committed first is seen as lost access.
   */
  async lockSharedAccess(tx: Kysely<DB>, userId: string, sources: readonly LockedSourceRow[]): Promise<Set<string>> {
    const candidates = sources.filter((source) => source.ownerId !== userId && source.lockReason === null);
    if (candidates.length === 0) {
      return new Set();
    }
    const ids = candidates.map((source) => source.assetId);
    const albums = await sql<{
      assetId: string;
    }>`
      SELECT album_asset."assetId"
      FROM album_asset
      JOIN album ON album.id = album_asset."albumId" AND album."deletedAt" IS NULL
      JOIN album_user ON album_user."albumId" = album.id AND album_user."userId" = ${userId}::uuid
      WHERE album_asset."assetId" = ANY(${ids}::uuid[])
      ORDER BY album.id
      FOR SHARE OF album, album_asset, album_user
    `.execute(tx);
    const reachable = new Set(albums.rows.map((row) => row.assetId));
    const remaining = ids.filter((id) => !reachable.has(id));
    if (remaining.length === 0) {
      return reachable;
    }
    const { rows: items } = await sql<{
      assetId: string;
      sharedAssetId: string;
      ownerId: string;
    }>`
      SELECT source.id AS "assetId", asset.id AS "sharedAssetId", asset."ownerId"
      FROM public.asset_user_share share
      JOIN asset ON asset.id = share."assetId" AND asset."ownerId" = share."ownerId"
        AND asset."deletedAt" IS NULL
      JOIN "user" owner ON owner.id = asset."ownerId" AND owner."deletedAt" IS NULL
      JOIN asset source ON source."ownerId" = asset."ownerId"
        AND (source.id = asset.id OR source.id = asset."livePhotoVideoId")
      WHERE share."sharedWithId" = ${userId}::uuid
        AND source.id = ANY(${remaining}::uuid[])
        AND asset.visibility != ${sql.lit(AssetVisibility.Hidden)}
        AND ${isNotLocked('asset')}
      ORDER BY asset.id, share.id
      FOR SHARE OF share, asset, owner
    `.execute(tx);
    // Match preference writers' per-account lock, including when no preferences row exists yet.
    for (const ownerId of [...new Set(items.map((item) => item.ownerId))].toSorted()) {
      await sql`SELECT pg_advisory_xact_lock_shared(-2, hashtext(${ownerId})::int)`.execute(tx);
    }
    if (items.length > 0) {
      // ponytail: library-wide membership locks during publication; use a shared per-owner writer protocol if contention grows.
      // Protect absent matches too: row locks cannot stop new tags/faces/observations or tag reparenting.
      // NOWAIT avoids deadlocking writers that acquired membership locks before our source/grant locks.
      try {
        await sql`LOCK TABLE public.asset_face, public.pet, public.pet_observation, public.tag_asset, public.tag_closure
          IN SHARE MODE NOWAIT`.execute(tx);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === '55P03') {
          throw new ConflictException('Shared-source privacy is changing; retry publication.');
        }
        throw error;
      }
    }
    const hidden = await getOwnerHiddenShareIds(
      tx,
      items.flatMap(({ assetId, sharedAssetId, ownerId }) => [
        { id: assetId, ownerId },
        { id: sharedAssetId, ownerId },
      ]),
    );
    for (const item of items) {
      if (!hidden.has(item.assetId) && !hidden.has(item.sharedAssetId)) {
        reachable.add(item.assetId);
      }
    }
    return reachable;
  }
  /**
   * Install inherited privacy on a result created in this transaction. A lock is an `asset_lock`
   * record, never a stored visibility; `lockedBy` is null because nobody chose it, and it is marked
   * `inherited`, so unlocking the last locked source releases it (`releaseDerivedResults`).
   */
  async install(
    tx: Kysely<DB>,
    assetId: string,
    privacy: {
      lockReason: AssetLockReason | null;
      sensitive: boolean;
    },
  ): Promise<void> {
    if (privacy.sensitive) {
      // The legacy projection first; the caller mirrors it into the privacy sidecar afterwards.
      await tx.updateTable('asset').set({ is_nsfw: true }).where('id', '=', assetId).execute();
    }
    if (privacy.lockReason) {
      await sql`
        INSERT INTO asset_lock ("assetId", reason, "lockedBy", inherited)
        VALUES (${assetId}::uuid, ${privacy.lockReason}, NULL, true)
        ON CONFLICT ("assetId") DO NOTHING
      `.execute(tx);
    }
  }
  /** The privacy an existing asset carries now, for a result whose bytes it already holds. */
  async getEvidence(
    tx: Kysely<DB>,
    assetId: string,
  ): Promise<
    | {
        lockReason: AssetLockReason | null;
        sensitive: boolean;
      }
    | undefined
  > {
    const { rows } = await sql<{
      reason: AssetLockReason | null;
    }>`
      SELECT asset_lock.reason
      FROM asset
      LEFT JOIN asset_lock ON asset_lock."assetId" = asset.id
      WHERE asset.id = ${assetId}::uuid
    `.execute(tx);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const sensitive = await this.sensitiveIds(tx, [assetId]);
    return { lockReason: row.reason ?? null, sensitive: sensitive.has(assetId) };
  }
  /** For tests and diagnostics: the privacy an asset carries, outside any transaction. */
  get(assetId: string) {
    return this.getEvidence(this.db, assetId);
  }
}
