import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetVisibility } from 'src/enum.js';
import { lockForkWrites } from 'src/repositories/fork-write-guard.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { getOwnerHiddenShareIds } from 'src/utils/item-share.js';
import { isNotLocked } from 'src/utils/locked.js';

export type ItemShareRow = {
  id: string;
  assetId: string;
  ownerId: string;
  sharedWithId: string;
  createdAt: Date;
};

const WRITE_REFUSAL = 'Sharing is unavailable while the server is being handed over';

/**
 * Items shared with a person in this library (FL-83 AL-30b) in `immich_fork.asset_user_share`
 * (fork migration 0000000000206): one row per item and recipient. The service decides who may share
 * what; this only stores the rows and reads them back. A read for the recipient never returns an
 * item that is Hidden or locked now, trashed, or whose owner is gone.
 */
@Injectable()
export class ItemShareRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Keep the mutation and its complete response on one connection until both succeed. */
  withTransaction<T>(callback: (shares: ItemShareRepository, users: UserRepository) => Promise<T>): Promise<T> {
    const execute = (db: Kysely<DB>) => callback(new ItemShareRepository(db), new UserRepository(db));
    return this.db.isTransaction ? execute(this.db) : this.db.transaction().execute(execute);
  }

  /** Recipients to notify after a lock, including items now excluded from recipient reads. */
  async getRecipients(assetIds: string[]): Promise<Pick<ItemShareRow, 'assetId' | 'sharedWithId'>[]> {
    if (assetIds.length === 0) {
      return [];
    }
    const { rows } = await sql<Pick<ItemShareRow, 'assetId' | 'sharedWithId'>>`
      SELECT "assetId", "sharedWithId"
      FROM immich_fork.asset_user_share
      WHERE "assetId" = ANY(${assetIds}::uuid[])
    `.execute(this.db);
    return rows;
  }

  /** The owner's shares of these items, oldest first. */
  async getForAssets(ownerId: string, assetIds: string[]): Promise<ItemShareRow[]> {
    if (assetIds.length === 0) {
      return [];
    }
    const { rows } = await sql<ItemShareRow>`
      SELECT id, "assetId", "ownerId", "sharedWithId", "createdAt"
      FROM immich_fork.asset_user_share
      WHERE "ownerId" = ${ownerId}::uuid AND "assetId" = ANY(${assetIds}::uuid[])
      ORDER BY "createdAt", id
    `.execute(this.db);
    return rows;
  }

  /** Shares each item with each person; a pair that is already shared keeps its row. */
  async add(ownerId: string, assetIds: string[], userIds: string[]): Promise<ItemShareRow[]> {
    if (assetIds.length === 0 || userIds.length === 0) {
      return [];
    }
    return this.withTransaction(async (shares) => {
      await lockForkWrites(shares.db, WRITE_REFUSAL);
      const { rows } = await sql<ItemShareRow>`
        INSERT INTO immich_fork.asset_user_share ("assetId", "ownerId", "sharedWithId")
        SELECT asset_id, ${ownerId}::uuid, user_id
        FROM unnest(${assetIds}::uuid[]) AS asset_id
        CROSS JOIN unnest(${userIds}::uuid[]) AS user_id
        ON CONFLICT ("assetId", "sharedWithId") DO NOTHING
        RETURNING id, "assetId", "ownerId", "sharedWithId", "createdAt"
      `.execute(shares.db);
      return rows;
    });
  }

  /** Stops sharing each of the owner's items with each person (revoke). */
  async remove(ownerId: string, assetIds: string[], userIds: string[]): Promise<ItemShareRow[]> {
    if (assetIds.length === 0 || userIds.length === 0) {
      return [];
    }
    return this.withTransaction(async (shares) => {
      await lockForkWrites(shares.db, WRITE_REFUSAL);
      const { rows } = await sql<ItemShareRow>`
        DELETE FROM immich_fork.asset_user_share
        WHERE "ownerId" = ${ownerId}::uuid
          AND "assetId" = ANY(${assetIds}::uuid[])
          AND "sharedWithId" = ANY(${userIds}::uuid[])
        RETURNING id, "assetId", "ownerId", "sharedWithId", "createdAt"
      `.execute(shares.db);
      return rows;
    });
  }

  /**
   * What the recipient sees: the items shared with them, newest share first, leaving out any item
   * that is Hidden or locked now, trashed, no longer owned by the person who shared it, or whose owner's
   * account is deleted.
   */
  async getReceived(userId: string): Promise<ItemShareRow[]> {
    const { rows } = await sql<ItemShareRow>`
      SELECT share.id, share."assetId", share."ownerId", share."sharedWithId", share."createdAt"
      FROM immich_fork.asset_user_share share
      JOIN asset ON asset.id = share."assetId" AND asset."ownerId" = share."ownerId" AND asset."deletedAt" IS NULL
      JOIN "user" owner ON owner.id = share."ownerId" AND owner."deletedAt" IS NULL
      WHERE share."sharedWithId" = ${userId}::uuid
        AND asset.visibility != ${sql.lit(AssetVisibility.Hidden)}
        AND ${isNotLocked('asset')}
      ORDER BY share."createdAt" DESC, share.id
    `.execute(this.db);
    const hidden = await getOwnerHiddenShareIds(
      this.db,
      rows.map((row) => ({ id: row.assetId, ownerId: row.ownerId })),
    );
    return rows.filter(({ assetId }) => !hidden.has(assetId));
  }
}
