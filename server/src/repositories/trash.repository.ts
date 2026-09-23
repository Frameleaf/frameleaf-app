import { InjectKysely } from 'nestjs-kysely';
import type { Kysely } from 'kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { isNotLockedAsset } from 'src/utils/database.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';

export class TrashRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  getDeletedIds(): AsyncIterableIterator<{ id: string }> {
    return this.db.selectFrom('asset').select(['id']).where('status', '=', AssetStatus.Deleted).stream();
  }

  /**
   * Restores the user's whole trash. Their Locked media in it is restored only from their elevated
   * session (`lockedOwnerId`), so an ordinary session neither changes nor counts it (FL-34).
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async restore(userId: string, { lockedOwnerId }: LockedVisibilityOptions = {}): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Trashed)
      .$if(lockedOwnerId !== userId, (qb) => qb.where((eb) => isNotLockedAsset(eb)))
      .set({ status: AssetStatus.Active, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  /** Empties the user's whole trash; their Locked media in it only from their elevated session (FL-34). */
  @GenerateSql({ params: [DummyValue.UUID] })
  async empty(userId: string, { lockedOwnerId }: LockedVisibilityOptions = {}): Promise<number> {
    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('ownerId', '=', userId)
      .where('status', '=', AssetStatus.Trashed)
      .$if(lockedOwnerId !== userId, (qb) => qb.where((eb) => isNotLockedAsset(eb)))
      .set({ status: AssetStatus.Deleted })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async restoreAll(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const { numUpdatedRows } = await this.db
      .updateTable('asset')
      .where('status', '=', AssetStatus.Trashed)
      .where('id', 'in', ids)
      .set({ status: AssetStatus.Active, deletedAt: null })
      .executeTakeFirst();

    return Number(numUpdatedRows);
  }
}
