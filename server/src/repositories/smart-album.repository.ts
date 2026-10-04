import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AlbumUserRole } from 'src/enum.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { DB } from 'src/schema/index.js';

@Injectable()
export class SmartAlbumRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {
    this.db = publicationDatabase(this.db);
  }
  /**
   * Idempotent: for each (ownerId, kind) pair that doesn't already have a
   * smart_album row, create the backing album + album_user (owner) + smart_album
   * in a single transaction guarded by a per-(ownerId, kind) advisory lock.
   *
   * The advisory lock is required because ON CONFLICT DO NOTHING on the
   * smart_album insert silently skips the row on conflict, but the data-modifying
   * CTEs above it (new_album, new_album_owner) have already executed by then.
   * Without serialization, two concurrent callers would each create an album +
   * album_user row, only one of which ends up referenced by smart_album — the
   * other becomes orphaned. The advisory lock serializes per (ownerId, kind),
   * so the SELECT-then-INSERT path is race-safe.
   */
  async ensureForUser(
    ownerId: string,
    kinds: {
      kind: string;
      name: string;
    }[],
  ): Promise<void> {
    if (kinds.length === 0) {
      return;
    }
    for (const { kind, name } of kinds) {
      await this.db.transaction().execute(async (trx) => {
        // Serialize this (ownerId, kind) pair across concurrent callers. Released
        // automatically at end-of-transaction.
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`${ownerId}:${kind}`}))`.execute(trx);
        const existing = await this.getSmartAlbumIdForOwnerAndKind(ownerId, kind, trx);
        if (existing) {
          return;
        }
        // Create backing album + album_user (owner) + smart_album in one CTE
        // chain. The final INSERT references both `new_album` and `new_album_owner`
        // so PostgreSQL is forced to execute every data-modifying CTE.

        const album = await trx
          .with('new_album', (qb) => qb.insertInto('album').values({ albumName: name }).returning('id'))
          .with('new_album_owner', (qb) =>
            qb
              .insertInto('album_user')
              .expression((eb) =>
                eb
                  .selectFrom('new_album')
                  .select((eb) => [
                    eb.ref('new_album.id').as('albumId'),
                    sql`${ownerId}::uuid`.as('userId'),
                    sql`${AlbumUserRole.Owner}::album_user_role_enum`.as('role'),
                  ]),
              )
              .returning('albumId'),
          )
          .selectFrom('new_album_owner')
          .select('albumId')
          .executeTakeFirstOrThrow();
        {
          await trx
            .insertInto('smart_album')
            .values({ albumId: album.albumId, ownerId, kind })
            .returning('id')
            .executeTakeFirstOrThrow();
        }
      });
    }
  }
  async getSmartAlbumIdForOwnerAndKind(
    ownerId: string,
    kind: string,
    kysely: Kysely<DB> = this.db,
  ): Promise<string | null> {
    const row = await kysely
      .selectFrom('smart_album')
      .select('id')
      .where('ownerId', '=', ownerId)
      .where('kind', '=', kind)
      .executeTakeFirst();
    return row?.id ?? null;
  }
  /**
   * Return a map of kind -> smart_album.id for all built-in kinds belonging to
   * `ownerId`. Replaces N round-trips to `getSmartAlbumIdForOwnerAndKind` with
   * a single query.
   */
  async getAllSmartAlbumIdsForOwner(ownerId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .selectFrom('smart_album')
      .select(['id', 'kind'])
      .where('ownerId', '=', ownerId)
      .execute();
    return new Map(rows.map((r) => [r.kind, r.id]));
  }
  /**
   * Which of `albumIds` are backed by a built-in smart album rule (and therefore filled
   * automatically), mapped to the rule's kind. Read from the authoritative side for the current phase.
   */
  async getSmartBackedAlbumKinds(albumIds: string[]): Promise<Map<string, string>> {
    if (albumIds.length === 0) {
      return new Map();
    }
    const rows = await this.db
      .selectFrom('smart_album')
      .select(['albumId', 'kind'])
      .where('albumId', 'in', albumIds)
      .execute();
    return new Map(rows.map((row) => [row.albumId, row.kind]));
  }
  async isExcluded(smartAlbumId: string, assetId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('smart_album_exclusion')
      .select('smartAlbumId')
      .where('smartAlbumId', '=', smartAlbumId)
      .where('assetId', '=', assetId)
      .executeTakeFirst();
    return !!row;
  }
  /**
   * Return the subset of `smartAlbumIds` that have the given asset excluded.
   * Single query equivalent of calling `isExcluded` per smart album.
   */
  async getExcludedSmartAlbumIds(assetId: string, smartAlbumIds: string[]): Promise<Set<string>> {
    if (smartAlbumIds.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('smart_album_exclusion')
      .select('smartAlbumId')
      .where('assetId', '=', assetId)
      .where('smartAlbumId', 'in', smartAlbumIds)
      .execute();
    return new Set(rows.map((r) => r.smartAlbumId));
  }
  /**
   * Add asset to smart_album_asset AND mirror into album_asset so it shows
   * up in normal album browsing. Both inserts run in a single transaction so
   * we never end up with a half-applied membership.
   */
  async addAssetToSmartAlbum(
    smartAlbumId: string,
    assetId: string,
    matchReason: 'tag' | 'clip' | 'both',
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const smartAlbum = await this.getRule(smartAlbumId, trx, false);
      if (!smartAlbum) {
        return;
      }
      {
        await trx
          .insertInto('smart_album_asset')
          .values({ smartAlbumId, assetId, matchReason })
          .onConflict((oc) => oc.columns(['smartAlbumId', 'assetId']).doUpdateSet({ matchReason }))
          .execute();
      }
      await trx
        .insertInto('album_asset')
        .values({ albumId: smartAlbum.albumId, assetId })
        .onConflict((oc) => oc.doNothing())
        .execute();
    });
  }
  /**
   * Remove asset from smart_album_asset AND from the backing album_asset.
   *
   * Wrapped in a transaction so we never leave the mirror half-applied. The
   * mirror is deleted FIRST so that, if a transaction aborts midway, the
   * remaining `smart_album_asset` row will let the next `evaluate` call
   * either re-add the mirror or remove the smart-album-asset row — i.e. the
   * orphan self-heals. Deleting in the opposite order would leave a stuck
   * `album_asset` row that no future evaluate could clean up.
   */
  async removeAssetFromSmartAlbum(smartAlbumId: string, assetId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const smartAlbum = await this.getRule(smartAlbumId, trx, false);
      if (smartAlbum) {
        await trx
          .deleteFrom('album_asset')
          .where('albumId', '=', smartAlbum.albumId)
          .where('assetId', '=', assetId)
          .execute();
      }
      {
        await trx
          .deleteFrom('smart_album_asset')
          .where('smartAlbumId', '=', smartAlbumId)
          .where('assetId', '=', assetId)
          .execute();
      }
    });
  }
  /**
   * Return the smart-album kinds the asset is currently in for this owner.
   */
  async getMatchingKinds(assetId: string, ownerId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('smart_album_asset')
      .innerJoin('smart_album', 'smart_album.id', 'smart_album_asset.smartAlbumId')
      .select('smart_album.kind')
      .where('smart_album_asset.assetId', '=', assetId)
      .where('smart_album.ownerId', '=', ownerId)
      .execute();
    return rows.map((r) => r.kind);
  }
  /**
   * Add to smart_album_exclusion and remove from smart_album_asset + album_asset
   * atomically. Stub for PR 7 (admin UI opt-out endpoint).
   */
  async excludeAsset(smartAlbumId: string, assetId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const smartAlbum = await this.getRule(smartAlbumId, trx, false);
      if (!smartAlbum) {
        return;
      }
      {
        await trx
          .insertInto('smart_album_exclusion')
          .values({ smartAlbumId, assetId })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      await trx
        .deleteFrom('album_asset')
        .where('albumId', '=', smartAlbum.albumId)
        .where('assetId', '=', assetId)
        .execute();
      {
        await trx
          .deleteFrom('smart_album_asset')
          .where('smartAlbumId', '=', smartAlbumId)
          .where('assetId', '=', assetId)
          .execute();
      }
    });
  }
  /**
   * The owner took items out of a built-in smart album by hand (FL-60): exclude them, so no later
   * evaluation puts them back. Does nothing for an album that is not a built-in smart album.
   */
  async excludeFromAlbum(albumId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    const ruleId = await this.getRuleIdForAlbum(albumId);
    if (!ruleId) {
      return;
    }
    for (const assetId of assetIds) {
      await this.excludeAsset(ruleId, assetId);
    }
  }
  private async getRuleIdForAlbum(albumId: string): Promise<string | undefined> {
    const row = await this.db.selectFrom('smart_album').select('id').where('albumId', '=', albumId).executeTakeFirst();
    return row?.id;
  }
  async deleteAssets(assetIds: string[], kysely: Kysely<DB> = this.db): Promise<void> {
    if (assetIds.length === 0) return;
    await kysely.deleteFrom('smart_album_asset').where('assetId', 'in', assetIds).execute();
    await kysely.deleteFrom('smart_album_exclusion').where('assetId', 'in', assetIds).execute();
  }
  async deleteAlbums(albumIds: string[], kysely: Kysely<DB> = this.db): Promise<void> {
    if (albumIds.length > 0) await kysely.deleteFrom('smart_album').where('albumId', 'in', albumIds).execute();
  }
  async deleteOwner(ownerId: string, kysely: Kysely<DB> = this.db): Promise<void> {
    await kysely.deleteFrom('smart_album').where('ownerId', '=', ownerId).execute();
  }

  private async getRule(id: string, kysely: Kysely<DB>, _sidecar?: boolean): Promise<{ albumId: string } | undefined> {
    return kysely.selectFrom('smart_album').select('albumId').where('id', '=', id).executeTakeFirst();
  }
}
