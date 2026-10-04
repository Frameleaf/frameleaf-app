import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
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
/**
 * Items shared with a person in this library (FL-83 AL-30b) in `public.asset_user_share`
 * (fork migration 0000000000206): one row per item and recipient. The service decides who may share
 * what; this only stores the rows and reads them back. A read for the recipient never returns an
 * item that is Hidden or locked now, trashed, or whose owner is gone.
 */
@Injectable()
export class ItemShareRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /** Keep privacy checks, mutation and response together; serialize sharing with asset lock/hide writers. */
  withTransaction<T>(
    callback: (
      shares: ItemShareRepository,
      users: UserRepository,
      assets: AssetRepository,
      access: AccessRepository,
    ) => Promise<T>,
    assetIds: string[] = [],
  ): Promise<T> {
    return this.inTransaction(async (tx) => {
      if (assetIds.length > 0) {
        // Lock propagation takes sources before derived results, which can oppose UUID order.
        // Refuse contention so rollback releases partial locks without blocking the privacy writer.
        try {
          await sql`SELECT id FROM asset WHERE id = ANY(${assetIds}::uuid[])
            ORDER BY id FOR NO KEY UPDATE NOWAIT`.execute(tx);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === '55P03') {
            throw new ConflictException('Item privacy is changing; retry sharing.');
          }
          throw error;
        }
      }
      return callback(
        new ItemShareRepository(tx),
        new UserRepository(tx),
        new AssetRepository(tx),
        new AccessRepository(tx),
      );
    });
  }
  private inTransaction<T>(callback: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.isTransaction ? callback(this.db as Transaction<DB>) : this.db.transaction().execute(callback);
  }
  /** Recipients to notify after a lock, including items now excluded from recipient reads. */
  async getRecipients(assetIds: string[]): Promise<Pick<ItemShareRow, 'assetId' | 'sharedWithId'>[]> {
    if (assetIds.length === 0) {
      return [];
    }
    const { rows } = await sql<Pick<ItemShareRow, 'assetId' | 'sharedWithId'>>`
      SELECT "assetId", "sharedWithId"
      FROM public.asset_user_share
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
      FROM public.asset_user_share
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
    return this.inTransaction(async (tx) => {
      const { rows } = await sql<ItemShareRow>`
        INSERT INTO public.asset_user_share ("assetId", "ownerId", "sharedWithId")
        SELECT asset_id, ${ownerId}::uuid, user_id
        FROM unnest(${assetIds}::uuid[]) AS asset_id
        CROSS JOIN unnest(${userIds}::uuid[]) AS user_id
        ON CONFLICT ("assetId", "sharedWithId") DO NOTHING
        RETURNING id, "assetId", "ownerId", "sharedWithId", "createdAt"
      `.execute(tx);
      return rows;
    });
  }
  /** Stops sharing each of the owner's items with each person (revoke). */
  async remove(ownerId: string, assetIds: string[], userIds: string[]): Promise<ItemShareRow[]> {
    if (assetIds.length === 0 || userIds.length === 0) {
      return [];
    }
    return this.inTransaction(async (tx) => {
      const { rows } = await sql<ItemShareRow>`
        DELETE FROM public.asset_user_share
        WHERE "ownerId" = ${ownerId}::uuid
          AND "assetId" = ANY(${assetIds}::uuid[])
          AND "sharedWithId" = ANY(${userIds}::uuid[])
        RETURNING id, "assetId", "ownerId", "sharedWithId", "createdAt"
      `.execute(tx);
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
      FROM public.asset_user_share share
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
