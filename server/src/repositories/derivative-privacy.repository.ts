import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { getForkSchemaPhase, readsForkSidecar } from 'src/repositories/fork-derived-results.js';
import { DB } from 'src/schema/index.js';
import { DerivativeSourceEvidence } from 'src/utils/derivative-privacy.js';

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
  constructor(@InjectKysely() private db: Kysely<DB>) {}

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
      ORDER BY asset.id
      FOR SHARE OF asset
    `.execute(tx);

    const sensitive = await this.sensitiveIds(tx, assetIds);

    // Read after the row locks are held, so a lock committed by anybody who got there first is seen.
    const locks = await sql<{ assetId: string; reason: AssetLockReason }>`
      SELECT "assetId", reason FROM asset_lock WHERE "assetId" = ANY(${[...assetIds]}::uuid[])
    `.execute(tx);
    const reasons = new Map(locks.rows.map((row) => [row.assetId, row.reason]));

    return new Map(
      rows.map((row) => [
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
   * Which of these assets carry sensitive evidence, from the store the fork schema phase makes
   * authoritative: `asset.is_nsfw` until the cutover, the privacy sidecar once it is `active` (the
   * same rule as `getUnlockedDetectionIds`). Only positive evidence counts.
   */
  private async sensitiveIds(tx: Kysely<DB>, assetIds: readonly string[]): Promise<Set<string>> {
    const phase = await getForkSchemaPhase(tx);
    const { rows } = readsForkSidecar(phase)
      ? await sql<{ id: string }>`
          SELECT "assetId" AS id FROM immich_fork.asset_privacy
          WHERE "assetId" = ANY(${[...assetIds]}::uuid[]) AND "isNsfw" = true
        `.execute(tx)
      : await sql<{ id: string }>`
          SELECT id FROM asset WHERE id = ANY(${[...assetIds]}::uuid[]) AND is_nsfw = true
        `.execute(tx);
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Which of these sources — all owned by somebody other than `userId` — `userId` can still reach
   * right now, share-locking the rows that grant it.
   *
   * The same two ways the library grants it (`AccessRepository`): an album the account is a member
   * of (owners are members too) that holds the asset, or a partner who shares their library with
   * the account and the asset is on their timeline. Locked media is reached by neither. The rows
   * that grant access are locked `FOR SHARE`, so removing the account from the album, taking the
   * asset out of it or ending the partnership waits for this transaction; one that committed first
   * is seen as lost access.
   */
  async lockSharedAccess(tx: Kysely<DB>, userId: string, sources: readonly LockedSourceRow[]): Promise<Set<string>> {
    const candidates = sources.filter((source) => source.ownerId !== userId && source.lockReason === null);
    if (candidates.length === 0) {
      return new Set();
    }
    const ids = candidates.map((source) => source.assetId);

    const albums = await sql<{ assetId: string }>`
      SELECT album_asset."assetId"
      FROM album_asset
      JOIN album ON album.id = album_asset."albumId" AND album."deletedAt" IS NULL
      JOIN album_user ON album_user."albumId" = album.id AND album_user."userId" = ${userId}::uuid
      WHERE album_asset."assetId" = ANY(${ids}::uuid[])
      FOR SHARE OF album_asset, album_user
    `.execute(tx);

    const partners = await sql<{ assetId: string }>`
      SELECT asset.id AS "assetId"
      FROM partner
      JOIN asset ON asset."ownerId" = partner."sharedById"
      WHERE partner."sharedWithId" = ${userId}::uuid
        AND asset.id = ANY(${ids}::uuid[])
        AND asset.visibility IN (${sql.lit(AssetVisibility.Timeline)}, ${sql.lit(AssetVisibility.Hidden)})
      FOR SHARE OF partner
    `.execute(tx);

    return new Set([...albums.rows, ...partners.rows].map((row) => row.assetId));
  }

  /**
   * Install inherited privacy on a result created in this transaction. A lock is an `asset_lock`
   * record, never a stored visibility; `lockedBy` is null because nobody chose it, it was inherited.
   */
  async install(
    tx: Kysely<DB>,
    assetId: string,
    privacy: { lockReason: AssetLockReason | null; sensitive: boolean },
  ): Promise<void> {
    if (privacy.sensitive) {
      // The legacy projection first; the caller mirrors it into the privacy sidecar afterwards.
      await tx.updateTable('asset').set({ is_nsfw: true }).where('id', '=', assetId).execute();
    }
    if (privacy.lockReason) {
      await sql`
        INSERT INTO asset_lock ("assetId", reason, "lockedBy")
        VALUES (${assetId}::uuid, ${privacy.lockReason}, NULL)
        ON CONFLICT ("assetId") DO NOTHING
      `.execute(tx);
    }
  }

  /** The privacy an existing asset carries now, for a result whose bytes it already holds. */
  async getEvidence(
    tx: Kysely<DB>,
    assetId: string,
  ): Promise<{ lockReason: AssetLockReason | null; sensitive: boolean } | undefined> {
    const { rows } = await sql<{ reason: AssetLockReason | null }>`
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
